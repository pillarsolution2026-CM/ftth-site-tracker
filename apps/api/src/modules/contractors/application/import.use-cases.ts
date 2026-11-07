import { Readable } from 'node:stream';
import {
  EVENT_ENTITIES,
  EVENT_TYPES,
  scopeKeyOf,
  XLSX_CONTENT_TYPE,
  type ContractorImportCommitPayload,
  type ContractorImportPreviewOptions,
  type ContractorImportPreviewResponse,
  type ContractorImportTarget,
  type ImportPreviewRow,
} from '@ftth/shared';
import { AppError } from '../../../common/app-error.js';
import type { IdGenerator } from '../../../common/clock.js';
import { storageKeys, type ObjectStorage } from '../../../common/object-storage.port.js';
import { discardObject } from '../../../common/storage/discard-object.js';
import type { GetProjectUseCase } from '../../projects/application/get-project.use-case.js';
import {
  importInvalid,
  readXlsx,
  type UploadedXlsx,
} from '../../work-orders/application/import.use-cases.js';
import type { WorkbookReader } from '../../work-orders/application/ports.js';
import { parseImport } from '../../work-orders/domain/import/import-parser.js';
import { Decimal } from '../../work-orders/domain/decimal.js';
import type { NewLine, Registration, WorkOrderLine } from '../domain/contractor.js';
import type {
  ContractorRepository,
  ContractorTx,
  ContractorUnitOfWork,
  RegistrationRepository,
} from '../domain/contractor.repository.js';
import {
  checkContractorSheet,
  selectContractorRows,
  slotOf,
  workOrderLineOfRow,
  type ContractorSheetContext,
} from '../domain/import/contractor-matching.js';
import { viewOf, type ProjectContractorsView } from './contractor-queries.js';

type Projects = Pick<GetProjectUseCase, 'execute'>;

interface Loaded {
  workOrderId: string;
  contractor: { id: string; name: string };
  /** Append target only. */
  registration: Registration | null;
  context: ContractorSheetContext;
}

/**
 * Before the file is read: the project needs a work order; a new registration needs a contractor
 * that is not on it yet; an append needs a registration of this project (404 otherwise).
 */
async function load(
  registrations: RegistrationRepository,
  contractors: ContractorRepository,
  projectId: string,
  target: ContractorImportTarget,
  options?: { lock?: boolean },
): Promise<Loaded> {
  const workOrderId = await registrations.workOrderOf(projectId, options);
  if (workOrderId === null) {
    throw new AppError('CONFLICT', 'The project has no work order yet', {
      reason: 'NO_WORK_ORDER',
    });
  }
  let contractor: Loaded['contractor'];
  let registration: Registration | null = null;
  if (target.kind === 'new') {
    const found = await contractors.findById(target.contractorId);
    if (!found) throw new AppError('NOT_FOUND', 'Contractor not found');
    if (await registrations.isRegistered(workOrderId, found.id)) {
      throw new AppError('CONFLICT', 'The contractor is already registered on this work order', {
        reason: 'CONTRACTOR_ALREADY_REGISTERED',
      });
    }
    contractor = { id: found.id, name: found.name };
  } else {
    registration = await registrations.find(projectId, target.registrationId);
    if (!registration) throw new AppError('NOT_FOUND', 'Contractor registration not found');
    contractor = { id: registration.contractor.id, name: registration.contractor.name };
  }
  const [lines, holdings] = await Promise.all([
    registrations.workOrderLines(workOrderId),
    registrations.holdings(workOrderId),
  ]);
  const ownSlots = new Set(
    (registration?.lines ?? []).map((line) => slotOf(line.item.id, line.scopeKey)),
  );
  return { workOrderId, contractor, registration, context: { lines, holdings, ownSlots } };
}

/** Parses the sheet and checks every item row against the work order. Writes nothing. */
export class PreviewContractorImportUseCase {
  constructor(
    private readonly projects: Projects,
    private readonly registrations: RegistrationRepository,
    private readonly contractors: ContractorRepository,
    private readonly reader: WorkbookReader,
  ) {}

  async execute(input: {
    projectId: string;
    file: UploadedXlsx;
    options: ContractorImportPreviewOptions;
  }): Promise<ContractorImportPreviewResponse> {
    const { projectId, file, options } = input;
    await this.projects.execute(projectId);
    const { context } = await load(this.registrations, this.contractors, projectId, options.target);
    const { workbook, sha256 } = await readXlsx(file, this.reader);
    const parsed = parseImport(
      workbook,
      { sheetName: options.sheetName, headerRow: options.headerRow, mapping: options.mapping },
      'contractor',
    );
    return {
      file: { name: file.fileName, sizeBytes: file.buffer.length, sha256 },
      ...checkContractorSheet(parsed, context),
    };
  }
}

function newLines(
  rows: readonly ImportPreviewRow[],
  context: ContractorSheetContext,
  effectiveFrom: string,
  actorId: string,
  ids: IdGenerator,
): NewLine[] {
  return rows.map((row) => {
    const line: WorkOrderLine | undefined = workOrderLineOfRow(row, context.lines);
    if (!line) throw new Error(`Row ${row.rowNumber} has no work-order line`);
    const scope = row.scope === null ? null : row.scope.trim() || null;
    return {
      id: ids.next(),
      workOrderItemId: line.id,
      scope,
      scopeKey: scopeKeyOf(scope),
      quantity: Decimal.parse(row.quantity ?? '0'),
      sourceRow: row.rowNumber,
      firstPrice: {
        id: ids.next(),
        effectiveFrom,
        unitPrice: Decimal.parse(row.unitPrice ?? '0'),
        createdById: actorId,
      },
    };
  });
}

/**
 * Re-parses the same file, checks it against the work order and, if every included row is clean,
 * creates the registration (or appends to it) atomically with the lines, their first prices and
 * the stored sheet. The work-order row lock is taken first, so the numbers checked are the ones
 * written.
 */
export class CommitContractorImportUseCase {
  constructor(
    private readonly projects: Projects,
    private readonly reader: WorkbookReader,
    private readonly uow: ContractorUnitOfWork,
    private readonly registrations: RegistrationRepository,
    private readonly contractors: ContractorRepository,
    private readonly storage: ObjectStorage,
    private readonly ids: IdGenerator,
  ) {}

  async execute(input: {
    projectId: string;
    actorId: string;
    file: UploadedXlsx;
    payload: ContractorImportCommitPayload;
  }): Promise<ProjectContractorsView> {
    const { projectId, actorId, file, payload } = input;
    const project = await this.projects.execute(projectId);
    await load(this.registrations, this.contractors, projectId, payload.target);
    const { workbook, sha256 } = await readXlsx(file, this.reader);
    if (sha256 !== payload.fileSha256) {
      throw importInvalid({ reason: 'FILE_CHANGED', fileIssues: [], rows: [], duplicateCodes: [] });
    }
    const parsed = parseImport(
      workbook,
      { sheetName: payload.sheetName, headerRow: payload.headerRow, mapping: payload.mapping },
      'contractor',
    );
    const excluded = new Set(payload.excludedRowNumbers);
    // Repeats are judged among the rows that stay, like the other row rules.
    const kept = { ...parsed, rows: parsed.rows.filter((row) => !excluded.has(row.rowNumber)) };
    const excludedRowCount = parsed.rows.length - kept.rows.length;

    // The same check runs again under the lock; this first pass answers without touching storage.
    const first = await load(this.registrations, this.contractors, projectId, payload.target);
    const early = selectContractorRows(checkContractorSheet(kept, first.context));
    if (!early.ok) throw importInvalid(early.details);

    const registrationId =
      payload.target.kind === 'new' ? this.ids.next() : payload.target.registrationId;
    const fileId = this.ids.next();
    const storageKey = storageKeys.contractorImportFile(projectId, registrationId, fileId);
    const stored = await this.storage.put(storageKey, Readable.from(file.buffer), {
      contentType: XLSX_CONTENT_TYPE,
      maxBytes: file.buffer.length,
    });

    try {
      return await this.uow.run(async (tx) => {
        const loaded = await load(tx.registrations, tx.contractors, projectId, payload.target, {
          lock: true,
        });
        const selection = selectContractorRows(checkContractorSheet(kept, loaded.context));
        if (!selection.ok) throw importInvalid(selection.details);

        const registeredOn =
          payload.target.kind === 'new'
            ? payload.target.registeredOn
            : (loaded.registration?.registeredOn ?? '');
        const lines = newLines(selection.rows, loaded.context, registeredOn, actorId, this.ids);
        const summary = {
          fileName: file.fileName,
          fileSha256: sha256,
          fileId,
          sheetName: parsed.sheetName,
          headerRow: parsed.headerRow,
          rowCount: parsed.rows.length,
          lineCount: lines.length,
          excludedRowCount,
        };

        if (payload.target.kind === 'new') {
          await tx.registrations.insert({
            id: registrationId,
            projectId,
            workOrderId: loaded.workOrderId,
            contractorId: loaded.contractor.id,
            registeredOn,
            createdById: actorId,
            lines,
          });
        } else {
          for (const line of lines) {
            await tx.registrations.insertLine(projectId, registrationId, line);
          }
        }
        await tx.registrations.insertFile({
          id: fileId,
          projectId,
          registrationId,
          fileName: file.fileName,
          sizeBytes: stored.sizeBytes,
          sha256: stored.sha256,
          storageKey,
          uploadedById: actorId,
        });
        await this.writeEvents(tx, {
          projectId,
          actorId,
          registrationId,
          registeredOn,
          loaded,
          lines,
          summary,
          isNew: payload.target.kind === 'new',
        });
        return viewOf(tx.registrations, projectId, project.currency);
      });
    } catch (error) {
      await discardObject(this.storage, storageKey);
      throw error;
    }
  }

  private async writeEvents(
    tx: ContractorTx,
    input: {
      projectId: string;
      actorId: string;
      registrationId: string;
      registeredOn: string;
      loaded: Loaded;
      lines: NewLine[];
      summary: Record<string, unknown>;
      isNew: boolean;
    },
  ): Promise<void> {
    const { projectId, actorId, registrationId, loaded, lines, summary } = input;
    const codeOf = new Map(loaded.context.lines.map((line) => [line.id, line.code]));
    const linePayload = (line: NewLine) => ({
      id: line.id,
      workOrderItemId: line.workOrderItemId,
      code: codeOf.get(line.workOrderItemId),
      scope: line.scope,
      quantity: line.quantity.toString(),
      unitPrice: line.firstPrice.unitPrice.toString(),
      sourceRow: line.sourceRow,
    });
    if (input.isNew) {
      await tx.events.append({
        projectId,
        entity: EVENT_ENTITIES.contractorRegistration,
        entityId: registrationId,
        type: EVENT_TYPES.contractorRegistered,
        actorId,
        payload: {
          contractorId: loaded.contractor.id,
          contractorName: loaded.contractor.name,
          workOrderId: loaded.workOrderId,
          registeredOn: input.registeredOn,
          ...summary,
          lines: lines.map(linePayload),
        },
      });
      return;
    }
    for (const line of lines) {
      await tx.events.append({
        projectId,
        entity: EVENT_ENTITIES.contractorLine,
        entityId: line.id,
        type: EVENT_TYPES.contractorLineAdded,
        actorId,
        payload: {
          registrationId,
          effectiveFrom: input.registeredOn,
          ...summary,
          ...linePayload(line),
        },
      });
    }
  }
}
