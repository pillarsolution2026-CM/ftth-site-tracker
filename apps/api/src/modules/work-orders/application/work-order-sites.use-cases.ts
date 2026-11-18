import {
  EVENT_ENTITIES,
  EVENT_TYPES,
  siteNamesFromColumn,
  type ReplaceWorkOrderSitesRequest,
  type WorkOrderSitesPreviewResponse,
} from '@ftth/shared';
import { AppError } from '../../../common/app-error.js';
import type { Clock, IdGenerator } from '../../../common/clock.js';
import { cellText } from '../domain/import/cell-values.js';
import type { RawSheet } from '../domain/import/raw-workbook.js';
import { planSiteReplacement, type WorkOrderSite } from '../domain/work-order-site.js';
import type { WorkOrderRepository, WorkOrderUnitOfWork } from '../domain/work-order.repository.js';
import { readXlsx, type UploadedXlsx } from './import.use-cases.js';
import type { WorkbookReader } from './ports.js';

export interface WorkOrderSitesView {
  version: number;
  sites: WorkOrderSite[];
}

const nameList = (sites: readonly WorkOrderSite[]) =>
  sites.map((site) => ({ id: site.id, name: site.name }));

export class ListWorkOrderSitesUseCase {
  constructor(private readonly uow: WorkOrderUnitOfWork) {}

  execute(projectId: string, workOrderId: string): Promise<WorkOrderSitesView> {
    return this.uow.run(async (tx) => {
      const order = await tx.orders.findById(projectId, workOrderId);
      if (!order) throw new AppError('NOT_FOUND', 'Work order not found');
      return { version: order.header.version, sites: await tx.sites.list(projectId, workOrderId) };
    });
  }
}

/** Replaces the sites of a work order (ADR-049): one transaction, one event, version bumped. */
export class ReplaceWorkOrderSitesUseCase {
  constructor(
    private readonly uow: WorkOrderUnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  execute(input: {
    projectId: string;
    workOrderId: string;
    actorId: string;
    request: ReplaceWorkOrderSitesRequest;
  }): Promise<WorkOrderSitesView> {
    const { projectId, workOrderId, actorId, request } = input;
    return this.uow.run(async (tx) => {
      const order = await tx.orders.findById(projectId, workOrderId, { lock: true });
      if (!order) throw new AppError('NOT_FOUND', 'Work order not found');
      order.assertVersion(request.expectedVersion);

      const current = await tx.sites.list(projectId, workOrderId);
      const plan = planSiteReplacement({
        workOrderId,
        current,
        requested: request.sites,
        actorId,
        ids: this.ids,
        now: this.clock.now(),
      });
      const changed =
        plan.inserted.length > 0 || plan.updated.length > 0 || plan.removed.length > 0;
      if (!changed) return { version: order.header.version, sites: plan.sites };

      await tx.sites.apply(projectId, workOrderId, plan);
      const header = await tx.orders.updateHeader(projectId, workOrderId, {});
      await tx.events.append({
        projectId,
        entity: EVENT_ENTITIES.workOrder,
        entityId: workOrderId,
        type: EVENT_TYPES.workOrderSitesChanged,
        actorId,
        payload: {
          before: nameList(current),
          after: nameList(plan.sites),
          added: plan.inserted.length,
          changed: plan.updated.length,
          removed: plan.removed.length,
          version: header.version,
        },
      });
      return { version: header.version, sites: plan.sites };
    });
  }
}

/** The names of the first column that has text (ADR-049). */
export function readSitesSheet(sheet: RawSheet): Omit<WorkOrderSitesPreviewResponse, 'sheetName'> {
  const rowNumbers = [...sheet.rows.keys()].sort((a, b) => a - b);
  let column = -1;
  for (const row of rowNumbers) {
    const cells = sheet.rows.get(row) ?? [];
    cells.forEach((cell, index) => {
      if (cellText(cell) !== null && (column === -1 || index < column)) column = index;
    });
  }
  if (column === -1) return { names: [], repeated: [], tooLongRows: [] };
  return siteNamesFromColumn(
    rowNumbers.map((row) => ({ row, text: cellText(sheet.rows.get(row)?.[column]) })),
  );
}

/** Reads a sites table; nothing is saved. */
export class PreviewSitesTableUseCase {
  constructor(
    private readonly orders: WorkOrderRepository,
    private readonly reader: WorkbookReader,
  ) {}

  async execute(input: {
    projectId: string;
    workOrderId: string;
    file: UploadedXlsx;
  }): Promise<WorkOrderSitesPreviewResponse> {
    if (!(await this.orders.exists(input.projectId, input.workOrderId))) {
      throw new AppError('NOT_FOUND', 'Work order not found');
    }
    const { workbook } = await readXlsx(input.file, this.reader);
    const sheet = workbook.sheets[0];
    if (!sheet) throw new AppError('UNSUPPORTED_FILE', 'The workbook has no sheet');
    return { sheetName: sheet.name, ...readSitesSheet(sheet) };
  }
}
