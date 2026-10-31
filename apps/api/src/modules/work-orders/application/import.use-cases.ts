import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  EVENT_ENTITIES,
  EVENT_TYPES,
  XLSX_CONTENT_TYPE,
  type ImportInvalidDetails,
  type WorkOrderImportCommitPayload,
  type WorkOrderImportPreviewOptions,
  type WorkOrderImportPreviewResponse,
} from '@ftth/shared';
import { AppError } from '../../../common/app-error.js';
import type { Clock, IdGenerator } from '../../../common/clock.js';
import { storageKeys, type ObjectStorage } from '../../../common/object-storage.port.js';
import { discardObject } from '../../../common/storage/discard-object.js';
import {
  assertLinesFit,
  lineFromContract,
  type ApprovedContract,
  type Reservations,
} from '../domain/contract-lines.js';
import { extensionOf, hasZipSignature } from '../domain/file-signatures.js';
import {
  checkImportAgainstContract,
  contractItemOfRow,
} from '../domain/import/contract-matching.js';
import { selectRowsForCommit } from '../domain/import/import-commit.js';
import { parseImport, type ParsedImport } from '../domain/import/import-parser.js';
import type { RawWorkbook } from '../domain/import/raw-workbook.js';
import { WorkOrder, type NewItem } from '../domain/work-order.js';
import type {
  ContractCatalog,
  WorkOrderAttachment,
  WorkOrderRepository,
  WorkOrderUnitOfWork,
} from '../domain/work-order.repository.js';
import type { ProjectCurrencyLookup, WorkbookReader } from './ports.js';
import type { WorkOrderView } from './work-order-queries.js';

export interface UploadedXlsx {
  fileName: string;
  buffer: Buffer;
}

export interface ReadXlsx {
  workbook: RawWorkbook;
  sha256: string;
}

export async function readXlsx(file: UploadedXlsx, reader: WorkbookReader): Promise<ReadXlsx> {
  if (extensionOf(file.fileName) !== 'xlsx' || !hasZipSignature(file.buffer)) {
    throw new AppError('UNSUPPORTED_FILE', 'Only .xlsx workbooks can be imported');
  }
  return {
    workbook: await reader.read(file.buffer),
    sha256: createHash('sha256').update(file.buffer).digest('hex'),
  };
}

export function importInvalid(details: ImportInvalidDetails): AppError {
  return new AppError('IMPORT_INVALID', `Import refused: ${details.reason}`, details);
}

/** Parses the sheet and returns rows with their issues. Writes nothing. */
export class PreviewImportUseCase {
  constructor(private readonly reader: WorkbookReader) {}

  async execute(input: {
    file: UploadedXlsx;
    options: WorkOrderImportPreviewOptions;
  }): Promise<WorkOrderImportPreviewResponse> {
    const { workbook, sha256 } = await readXlsx(input.file, this.reader);
    return {
      file: { name: input.file.fileName, sizeBytes: input.file.buffer.length, sha256 },
      ...parseImport(workbook, input.options),
    };
  }
}

/**
 * Before the file is read (ADR-028): the project needs an approved contract and no work order yet.
 * Returns the contract and what the work orders saved so far have reserved of it.
 */
async function loadContractForImport(
  contracts: ContractCatalog,
  orders: WorkOrderRepository,
  projectId: string,
  options?: { lock?: boolean },
): Promise<{ contract: ApprovedContract; reservations: Reservations }> {
  const contract = await contracts.loadApproved(projectId, options);
  if (await orders.existsForProject(projectId)) {
    throw new AppError('CONFLICT', 'The project already has a work order', {
      reason: 'WORK_ORDER_EXISTS',
    });
  }
  return { contract, reservations: await contracts.reservations(contract.id) };
}

/** Parses the sheet and checks every item row against the approved contract. Writes nothing. */
export class PreviewWorkOrderImportUseCase {
  private readonly preview: PreviewImportUseCase;

  constructor(
    reader: WorkbookReader,
    private readonly contracts: ContractCatalog,
    private readonly orders: WorkOrderRepository,
  ) {
    this.preview = new PreviewImportUseCase(reader);
  }

  async execute(input: {
    projectId: string;
    file: UploadedXlsx;
    options: WorkOrderImportPreviewOptions;
  }): Promise<WorkOrderImportPreviewResponse> {
    const { contract, reservations } = await loadContractForImport(
      this.contracts,
      this.orders,
      input.projectId,
    );
    const { file, ...parsed } = await this.preview.execute({
      file: input.file,
      options: input.options,
    });
    return { file, ...checkImportAgainstContract(parsed, contract, reservations) };
  }
}

/**
 * Re-parses the same file, checks it against the approved contract and, if every included row is
 * clean, creates the project's work order atomically with lines linked to contract items.
 */
export class CommitImportUseCase {
  constructor(
    private readonly reader: WorkbookReader,
    private readonly uow: WorkOrderUnitOfWork,
    private readonly contracts: ContractCatalog,
    private readonly orders: WorkOrderRepository,
    private readonly projects: ProjectCurrencyLookup,
    private readonly storage: ObjectStorage,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(input: {
    projectId: string;
    actorId: string;
    file: UploadedXlsx;
    payload: WorkOrderImportCommitPayload;
  }): Promise<WorkOrderView> {
    const { projectId, actorId, file, payload } = input;
    const { contract, reservations } = await loadContractForImport(
      this.contracts,
      this.orders,
      projectId,
    );
    const { workbook, sha256 } = await readXlsx(file, this.reader);
    if (sha256 !== payload.fileSha256) {
      throw importInvalid({ reason: 'FILE_CHANGED', fileIssues: [], rows: [], duplicateCodes: [] });
    }

    const parsed = parseImport(workbook, {
      sheetName: payload.sheetName,
      headerRow: payload.headerRow,
      mapping: payload.mapping,
    });
    const excluded = new Set(payload.excludedRowNumbers);
    // A repeated code is judged among the rows that stay, like the other duplicate rules.
    const kept: ParsedImport = {
      ...parsed,
      rows: parsed.rows.filter((row) => !excluded.has(row.rowNumber)),
    };
    const checked = checkImportAgainstContract(kept, contract, reservations);
    // `acceptedDuplicateCodes` is ignored (ADR-028): a repeated code is the error CODE_REPEATED.
    const selection = selectRowsForCommit(checked, {
      excludedRowNumbers: [],
      acceptedDuplicateCodes: [],
    });
    if (!selection.ok) throw importInvalid(selection.details);
    const excludedRowCount = parsed.rows.length - kept.rows.length;

    const rowByNumber = new Map(kept.rows.map((row) => [row.rowNumber, row]));
    // Heading rows are section titles of a BOQ; a work order never stores them.
    const lines: NewItem[] = [];
    for (const line of selection.lines) {
      if (line.kind !== 'item') continue;
      const row = rowByNumber.get(line.sourceRow ?? 0);
      const contractItem = row ? contractItemOfRow(row, contract) : undefined;
      if (!contractItem) throw new Error(`Row ${line.sourceRow ?? 0} has no contract item`);
      lines.push(lineFromContract(contract, contractItem.id, line.quantity, line.sourceRow));
    }

    const now = this.clock.now();
    const currency = await this.projects.currencyOf(projectId);
    const order = WorkOrder.create(
      {
        projectId,
        number: payload.workOrder.number,
        title: payload.workOrder.title,
        issuedOn: payload.workOrder.issuedOn,
        notes: payload.workOrder.notes,
        currency,
        source: 'import',
        items: lines,
        createdById: actorId,
      },
      this.ids,
      now,
    );

    // Object first, database second: a failed transaction only leaves an object we then delete.
    const attachmentId = this.ids.next();
    const storageKey = storageKeys.workOrderAttachment(
      projectId,
      order.header.id,
      attachmentId,
      'xlsx',
    );
    const stored = await this.storage.put(storageKey, Readable.from(file.buffer), {
      contentType: XLSX_CONTENT_TYPE,
      maxBytes: file.buffer.length,
    });
    const attachment: WorkOrderAttachment = {
      id: attachmentId,
      projectId,
      workOrderId: order.header.id,
      kind: 'import_source',
      fileName: file.fileName,
      contentType: XLSX_CONTENT_TYPE,
      sizeBytes: stored.sizeBytes,
      sha256: stored.sha256,
      storageKey,
      uploadedById: actorId,
      createdAt: now,
    };

    try {
      await this.uow.run(async (tx) => {
        // Under the contract lock the reservations are re-read: another work order may have been
        // saved since the check above.
        const locked = await loadContractForImport(tx.contracts, tx.orders, projectId, {
          lock: true,
        });
        assertLinesFit(locked.contract, locked.reservations, lines);
        await tx.orders.insert(order);
        await tx.attachments.insert(attachment);
        await tx.events.append({
          projectId,
          entity: EVENT_ENTITIES.workOrder,
          entityId: order.header.id,
          type: EVENT_TYPES.workOrderImported,
          actorId,
          payload: {
            number: order.header.number,
            currency,
            contractId: contract.id,
            fileName: file.fileName,
            fileSha256: sha256,
            attachmentId,
            sheetName: parsed.sheetName,
            headerRow: parsed.headerRow,
            mapping: parsed.mapping,
            rowCount: parsed.rows.length,
            itemCount: order.items.length,
            excludedRowCount,
            total: order.total.toString(),
            contractItemIds: order.items.map((item) => item.contractItemId),
          },
        });
      });
    } catch (error) {
      await discardObject(this.storage, storageKey);
      throw error;
    }
    return { order, attachments: [attachment] };
  }
}
