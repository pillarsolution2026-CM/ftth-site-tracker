import { Readable } from 'node:stream';
import {
  EVENT_ENTITIES,
  EVENT_TYPES,
  XLSX_CONTENT_TYPE,
  type ContractImportCommitPayload,
  type ContractImportPreviewOptions,
  type ContractImportPreviewResponse,
} from '@ftth/shared';
import { AppError } from '../../../common/app-error.js';
import type { Clock, IdGenerator } from '../../../common/clock.js';
import { storageKeys, type ObjectStorage } from '../../../common/object-storage.port.js';
import { discardObject } from '../../../common/storage/discard-object.js';
import {
  importInvalid,
  PreviewImportUseCase,
  readXlsx,
  type UploadedXlsx,
} from '../../work-orders/application/import.use-cases.js';
import type { WorkbookReader } from '../../work-orders/application/ports.js';
import { selectRowsForCommit } from '../../work-orders/domain/import/import-commit.js';
import { parseImport } from '../../work-orders/domain/import/import-parser.js';
import type { ImportedLine } from '../domain/contract.js';
import type {
  ContractAttachment,
  ContractRepository,
  ContractUnitOfWork,
} from '../domain/contract.repository.js';
import { viewInTx, type ContractView } from './contract-queries.js';
import { lockContract } from './contract.use-cases.js';

async function requireDraft(contracts: ContractRepository, contractId: string, version?: number) {
  const contract = await contracts.findById(contractId);
  if (!contract) throw new AppError('NOT_FOUND', 'Contract not found');
  contract.assertDraft();
  if (version !== undefined) contract.assertVersion(version);
}

/** Parses the sheet of a draft contract and returns rows with their issues. Writes nothing. */
export class PreviewContractImportUseCase {
  private readonly preview: PreviewImportUseCase;

  constructor(
    private readonly contracts: ContractRepository,
    reader: WorkbookReader,
  ) {
    this.preview = new PreviewImportUseCase(reader);
  }

  async execute(input: {
    contractId: string;
    file: UploadedXlsx;
    options: ContractImportPreviewOptions;
  }): Promise<ContractImportPreviewResponse> {
    await requireDraft(this.contracts, input.contractId);
    return this.preview.execute({ file: input.file, options: input.options });
  }
}

/**
 * Re-parses the same file and, if every included row is clean, replaces all lines of the draft
 * contract in one transaction. Items become items, heading rows become headings.
 */
export class CommitContractImportUseCase {
  constructor(
    private readonly reader: WorkbookReader,
    private readonly uow: ContractUnitOfWork,
    private readonly contracts: ContractRepository,
    private readonly storage: ObjectStorage,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(input: {
    contractId: string;
    actorId: string;
    file: UploadedXlsx;
    payload: ContractImportCommitPayload;
  }): Promise<ContractView> {
    const { contractId, actorId, file, payload } = input;
    await requireDraft(this.contracts, contractId, payload.expectedVersion);

    const { workbook, sha256 } = await readXlsx(file, this.reader);
    if (sha256 !== payload.fileSha256) {
      throw importInvalid({ reason: 'FILE_CHANGED', fileIssues: [], rows: [], duplicateCodes: [] });
    }
    const parsed = parseImport(workbook, {
      sheetName: payload.sheetName,
      headerRow: payload.headerRow,
      mapping: payload.mapping,
    });
    const selection = selectRowsForCommit(parsed, payload, 'keep');
    if (!selection.ok) throw importInvalid(selection.details);
    const imported: ImportedLine[] = selection.lines.map((line) =>
      line.kind === 'heading' ? line : { ...line, sourceRow: line.sourceRow ?? 0 },
    );

    const now = this.clock.now();
    // Object first, database second: a failed transaction only leaves an object we then delete.
    const attachmentId = this.ids.next();
    const storageKey = storageKeys.contractAttachment(contractId, attachmentId, 'xlsx');
    const stored = await this.storage.put(storageKey, Readable.from(file.buffer), {
      contentType: XLSX_CONTENT_TYPE,
      maxBytes: file.buffer.length,
    });
    const attachment: ContractAttachment = {
      id: attachmentId,
      contractId,
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
      return await this.uow.run(async (tx) => {
        const contract = await lockContract(tx, contractId);
        contract.assertDraft();
        contract.assertVersion(payload.expectedVersion);
        const lines = contract.buildImportedLines(imported, this.ids, now);
        await tx.contracts.replaceLines(contractId, lines);
        await tx.attachments.insert(attachment);
        const itemCount = lines.filter((line) => line.kind === 'item').length;
        const after = await viewInTx(tx, contractId);
        await tx.events.append({
          projectId: null,
          entity: EVENT_ENTITIES.contract,
          entityId: contractId,
          type: EVENT_TYPES.contractImported,
          actorId,
          payload: {
            fileName: file.fileName,
            fileSha256: sha256,
            attachmentId,
            sheetName: parsed.sheetName,
            headerRow: parsed.headerRow,
            mapping: parsed.mapping,
            rowCount: parsed.rows.length,
            itemCount,
            headingCount: lines.length - itemCount,
            excludedRowCount: selection.excludedCount,
            replacedLineCount: contract.lines.length,
            acceptedDuplicateCodes: payload.acceptedDuplicateCodes,
            total: after.contract.total.toString(),
            version: after.contract.header.version,
          },
        });
        return after;
      });
    } catch (error) {
      await discardObject(this.storage, storageKey);
      throw error;
    }
  }
}
