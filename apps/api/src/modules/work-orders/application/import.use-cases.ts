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
import { extensionOf, hasZipSignature } from '../domain/file-signatures.js';
import { selectRowsForCommit } from '../domain/import/import-commit.js';
import { parseImport } from '../domain/import/import-parser.js';
import type { RawWorkbook } from '../domain/import/raw-workbook.js';
import { WorkOrder, type NewItem } from '../domain/work-order.js';
import type { WorkOrderAttachment, WorkOrderUnitOfWork } from '../domain/work-order.repository.js';
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

/** Re-parses the same file and, if every included row is clean, creates one work order atomically. */
export class CommitImportUseCase {
  constructor(
    private readonly reader: WorkbookReader,
    private readonly uow: WorkOrderUnitOfWork,
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
    const { workbook, sha256 } = await readXlsx(file, this.reader);
    if (sha256 !== payload.fileSha256) {
      throw importInvalid({ reason: 'FILE_CHANGED', fileIssues: [], rows: [], duplicateCodes: [] });
    }

    const parsed = parseImport(workbook, {
      sheetName: payload.sheetName,
      headerRow: payload.headerRow,
      mapping: payload.mapping,
    });
    const selection = selectRowsForCommit(parsed, payload);
    if (!selection.ok) throw importInvalid(selection.details);

    // Heading rows are section titles of a BOQ; a work order never stores them.
    const items: NewItem[] = [];
    for (const line of selection.lines) {
      if (line.kind === 'item') items.push(line);
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
        items,
        acceptedDuplicateCodes: payload.acceptedDuplicateCodes,
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
            fileName: file.fileName,
            fileSha256: sha256,
            attachmentId,
            sheetName: parsed.sheetName,
            headerRow: parsed.headerRow,
            mapping: parsed.mapping,
            rowCount: parsed.rows.length,
            itemCount: order.items.length,
            excludedRowCount: selection.excludedCount,
            acceptedDuplicateCodes: payload.acceptedDuplicateCodes,
            total: order.total.toString(),
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
