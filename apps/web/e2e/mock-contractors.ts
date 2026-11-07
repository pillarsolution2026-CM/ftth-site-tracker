/* eslint-disable @typescript-eslint/no-explicit-any -- the mock reads loosely typed request JSON */
/**
 * Subcontractor routes of the mock API (ADR-036), in memory. Request bodies are validated and
 * answers parsed with the shared schemas, so the mock follows the contract.
 *
 * Simplification: the mock does not read the work orders of mock-api.ts. Every project except the
 * two seeded ones has a fixed virtual work order (two priced lines and one legacy line); the two
 * seeded projects have none. That keeps this flow independent of the other specs, which share the
 * mock's state.
 */
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  AddContractorLineRequestSchema,
  AddContractorPriceRequestSchema,
  ContractorListResponseSchema,
  ContractorRegistrationSchema,
  ContractorSchema,
  CreateContractorRequestSchema,
  ProjectContractorsResponseSchema,
  RegisterContractorRequestSchema,
  UpdateContractorLineRequestSchema,
  UpdateContractorRequestSchema,
} from '@ftth/shared';
import { cmpDec, subDec, sumDec } from './mock-decimal.ts';
import type { Helpers } from './mock-design.ts';

const NOW = '2026-11-07T08:00:00.000Z';
const NO_WORK_ORDER = new Set<string>();

/** Project ids that have no work order (the seeded ones); set by mock-api.ts. */
export function projectsWithoutWorkOrder(ids: string[]): void {
  for (const id of ids) NO_WORK_ORDER.add(id);
}

const WORK_ORDER_LINES = [
  {
    id: '5a000000-0000-4000-8000-000000000001',
    lineNo: 1,
    code: 'T-1',
    description: 'حفر خندق',
    unit: 'م',
    contractPrice: '12.5',
    quantity: '100',
    assignable: true,
  },
  {
    id: '5a000000-0000-4000-8000-000000000002',
    lineNo: 2,
    code: 'T-2',
    description: 'ردم',
    unit: 'م',
    contractPrice: '3',
    quantity: '40',
    assignable: true,
  },
  {
    id: '5a000000-0000-4000-8000-000000000003',
    lineNo: 3,
    code: 'OLD-1',
    description: 'بند قديم',
    unit: 'م',
    contractPrice: '1',
    quantity: '10',
    assignable: false,
  },
];

interface PriceRecord {
  id: string;
  effectiveFrom: string;
  unitPrice: string;
}
interface LineRecord {
  id: string;
  workOrderItemId: string;
  quantity: string;
  prices: PriceRecord[];
}
interface RegistrationRecord {
  id: string;
  projectId: string;
  contractorId: string;
  registeredOn: string;
  lines: LineRecord[];
}

const contractors: any[] = [];
const registrations: RegistrationRecord[] = [];

const WORK_ORDER_ID = '2b1c9f2e-6b3d-4e8a-9c7f-2d4b6a8c0e1f';

function itemOf(id: string) {
  const item = WORK_ORDER_LINES.find((entry) => entry.id === id);
  if (!item) throw new Error('unknown work-order line ' + id);
  return item;
}

const reserved = (itemId: string, exceptLineId?: string) =>
  sumDec(
    registrations.flatMap((registration) =>
      registration.lines
        .filter((line) => line.workOrderItemId === itemId && line.id !== exceptLineId)
        .map((line) => line.quantity),
    ),
  );

function lineView(record: LineRecord) {
  const item = itemOf(record.workOrderItemId);
  return {
    id: record.id,
    workOrderItemId: item.id,
    lineNo: item.lineNo,
    code: item.code,
    description: item.description,
    unit: item.unit,
    workType: 'civil',
    contractPrice: item.contractPrice,
    quantity: record.quantity,
    prices: record.prices.map((price) => ({ ...price, createdById: null, createdAt: NOW })),
  };
}

function registrationView(record: RegistrationRecord) {
  const contractor = contractors.find((entry) => entry.id === record.contractorId);
  return ContractorRegistrationSchema.parse({
    id: record.id,
    projectId: record.projectId,
    workOrderId: WORK_ORDER_ID,
    contractor: {
      id: contractor.id,
      name: contractor.name,
      contactName: contractor.contactName,
      contactPhone: contractor.contactPhone,
      commercialRegister: contractor.commercialRegister,
      taxCard: contractor.taxCard,
    },
    registeredOn: record.registeredOn,
    lines: record.lines.map(lineView),
    createdById: null,
    createdAt: NOW,
  });
}

function projectView(projectId: string) {
  const has = !NO_WORK_ORDER.has(projectId);
  return ProjectContractorsResponseSchema.parse({
    projectId,
    workOrderId: has ? WORK_ORDER_ID : null,
    currency: 'EGP',
    registrations: registrations
      .filter((registration) => registration.projectId === projectId)
      .map(registrationView),
    availability: has
      ? WORK_ORDER_LINES.map((item) => {
          const held = reserved(item.id);
          return {
            workOrderItemId: item.id,
            lineNo: item.lineNo,
            code: item.code,
            description: item.description,
            unit: item.unit,
            workType: 'civil',
            contractPrice: item.contractPrice,
            workOrderQuantity: item.quantity,
            reservedQuantity: held,
            availableQuantity: subDec(item.quantity, held),
            assignable: item.assignable,
          };
        })
      : [],
  });
}

const withCount = (contractor: any) => ({
  ...contractor,
  workOrderCount: new Set(
    registrations
      .filter((registration) => registration.contractorId === contractor.id)
      .map((registration) => registration.projectId),
  ).size,
});

/** `/admin/contractors[/:id]`; `segments` = ['admin', 'contractors', id]. */
export async function handleContractors(
  req: IncomingMessage,
  res: ServerResponse,
  segments: string[],
  { send, sendError, readJson }: Helpers,
): Promise<void> {
  const method = req.method ?? 'GET';
  const id = segments[2];
  const taken = (name: string, exceptId?: string) =>
    contractors.some(
      (entry) => entry.name.toLowerCase() === name.toLowerCase() && entry.id !== exceptId,
    );
  if (!id && method === 'GET') {
    return send(
      res,
      200,
      ContractorListResponseSchema.parse({ items: contractors.map(withCount) }),
    );
  }
  if (!id && method === 'POST') {
    const body = CreateContractorRequestSchema.safeParse(await readJson(req));
    if (!body.success) return sendError(res, 400, 'VALIDATION_FAILED');
    if (taken(body.data.name)) {
      return sendError(res, 409, 'CONFLICT', { reason: 'CONTRACTOR_NAME_TAKEN' });
    }
    const contractor = {
      id: randomUUID(),
      commercialRegister: null,
      taxCard: null,
      ...body.data,
      version: 1,
      createdAt: NOW,
      updatedAt: NOW,
    };
    contractors.push(contractor);
    return send(res, 201, ContractorSchema.parse(withCount(contractor)));
  }
  const contractor = contractors.find((entry) => entry.id === id);
  if (!contractor) return sendError(res, 404, 'NOT_FOUND');
  if (method === 'GET') return send(res, 200, ContractorSchema.parse(withCount(contractor)));
  if (method === 'PATCH') {
    const body = UpdateContractorRequestSchema.safeParse(await readJson(req));
    if (!body.success) return sendError(res, 400, 'VALIDATION_FAILED');
    if (body.data.expectedVersion !== contractor.version) {
      return sendError(res, 409, 'CONFLICT', { reason: 'STALE_VERSION' });
    }
    if (body.data.name && taken(body.data.name, contractor.id)) {
      return sendError(res, 409, 'CONFLICT', { reason: 'CONTRACTOR_NAME_TAKEN' });
    }
    const fields: Record<string, unknown> = { ...body.data };
    delete fields.expectedVersion;
    Object.assign(contractor, fields, { version: contractor.version + 1, updatedAt: NOW });
    return send(res, 200, ContractorSchema.parse(withCount(contractor)));
  }
  return sendError(res, 404, 'NOT_FOUND');
}

/**
 * `/admin/projects/:projectId/contractors/...` and `/projects/:projectId/contractors` (GET).
 * `tail` = the segments after `contractors`: [registrationId, 'lines', lineId, 'prices'].
 */
export async function handleProjectContractors(
  req: IncomingMessage,
  res: ServerResponse,
  projectId: string,
  tail: string[],
  { send, sendError, readJson }: Helpers,
): Promise<void> {
  const method = req.method ?? 'GET';
  const [registrationId, linesWord, lineId, pricesWord] = tail;
  const invalid = () => sendError(res, 400, 'VALIDATION_FAILED');
  const conflict = (details: Record<string, unknown>) => sendError(res, 409, 'CONFLICT', details);

  if (!registrationId) {
    if (method === 'GET') return send(res, 200, projectView(projectId));
    if (method !== 'POST') return sendError(res, 404, 'NOT_FOUND');
    const body = RegisterContractorRequestSchema.safeParse(await readJson(req));
    if (!body.success) return invalid();
    if (NO_WORK_ORDER.has(projectId)) return conflict({ reason: 'NO_WORK_ORDER' });
    if (!contractors.some((entry) => entry.id === body.data.contractorId)) {
      return sendError(res, 404, 'NOT_FOUND');
    }
    if (
      registrations.some(
        (entry) => entry.projectId === projectId && entry.contractorId === body.data.contractorId,
      )
    ) {
      return conflict({ reason: 'CONTRACTOR_ALREADY_REGISTERED' });
    }
    for (const line of body.data.lines) {
      const item = WORK_ORDER_LINES.find((entry) => entry.id === line.workOrderItemId);
      if (!item) return conflict({ reason: 'LINE_NOT_IN_WORK_ORDER' });
      if (!item.assignable) return conflict({ reason: 'LEGACY_ITEM' });
      const held = reserved(item.id);
      const available = subDec(item.quantity, held);
      if (cmpDec(line.quantity, available) > 0) {
        return conflict({
          reason: 'QUANTITY_EXCEEDS_WORK_ORDER',
          workOrderItemId: item.id,
          code: item.code,
          workOrderQuantity: item.quantity,
          reservedQuantity: held,
          requestedQuantity: line.quantity,
          availableQuantity: available,
        });
      }
      if (cmpDec(line.unitPrice, item.contractPrice) > 0) {
        return conflict({
          reason: 'PRICE_EXCEEDS_CONTRACT',
          workOrderItemId: item.id,
          code: item.code,
          contractPrice: item.contractPrice,
          requestedPrice: line.unitPrice,
        });
      }
    }
    const record: RegistrationRecord = {
      id: randomUUID(),
      projectId,
      contractorId: body.data.contractorId,
      registeredOn: body.data.registeredOn,
      lines: body.data.lines.map((line) => ({
        id: randomUUID(),
        workOrderItemId: line.workOrderItemId,
        quantity: line.quantity,
        prices: [
          { id: randomUUID(), effectiveFrom: body.data.registeredOn, unitPrice: line.unitPrice },
        ],
      })),
    };
    registrations.push(record);
    return send(res, 201, projectView(projectId));
  }

  const index = registrations.findIndex(
    (entry) => entry.id === registrationId && entry.projectId === projectId,
  );
  const record = registrations[index];
  if (!record) return sendError(res, 404, 'NOT_FOUND');
  if (!linesWord) {
    if (method !== 'DELETE') return sendError(res, 404, 'NOT_FOUND');
    registrations.splice(index, 1);
    return send(res, 204);
  }
  if (method === 'POST' && linesWord === 'lines' && !lineId) {
    const body = AddContractorLineRequestSchema.safeParse(await readJson(req));
    if (!body.success) return invalid();
    const item = WORK_ORDER_LINES.find((entry) => entry.id === body.data.workOrderItemId);
    if (!item) return conflict({ reason: 'LINE_NOT_IN_WORK_ORDER' });
    if (!item.assignable) return conflict({ reason: 'LEGACY_ITEM' });
    if (record.lines.some((entry) => entry.workOrderItemId === item.id)) {
      return conflict({ reason: 'LINE_REPEATED' });
    }
    const held = reserved(item.id);
    const available = subDec(item.quantity, held);
    if (cmpDec(body.data.quantity, available) > 0) {
      return conflict({
        reason: 'QUANTITY_EXCEEDS_WORK_ORDER',
        workOrderItemId: item.id,
        code: item.code,
        workOrderQuantity: item.quantity,
        reservedQuantity: held,
        requestedQuantity: body.data.quantity,
        availableQuantity: available,
      });
    }
    if (cmpDec(body.data.unitPrice, item.contractPrice) > 0) {
      return conflict({
        reason: 'PRICE_EXCEEDS_CONTRACT',
        workOrderItemId: item.id,
        code: item.code,
        contractPrice: item.contractPrice,
        requestedPrice: body.data.unitPrice,
      });
    }
    record.lines.push({
      id: randomUUID(),
      workOrderItemId: item.id,
      quantity: body.data.quantity,
      prices: [
        { id: randomUUID(), effectiveFrom: record.registeredOn, unitPrice: body.data.unitPrice },
      ],
    });
    return send(res, 201, projectView(projectId));
  }
  const line = record.lines.find((entry) => entry.id === lineId);
  if (linesWord !== 'lines' || !line) return sendError(res, 404, 'NOT_FOUND');
  const item = itemOf(line.workOrderItemId);

  if (method === 'DELETE' && !pricesWord) {
    if (record.lines.length === 1) return conflict({ reason: 'LAST_LINE' });
    record.lines.splice(record.lines.indexOf(line), 1);
    return send(res, 204);
  }
  if (method === 'PATCH' && !pricesWord) {
    const body = UpdateContractorLineRequestSchema.safeParse(await readJson(req));
    if (!body.success) return invalid();
    const available = subDec(item.quantity, reserved(item.id, line.id));
    if (cmpDec(body.data.quantity, available) > 0) {
      return conflict({
        reason: 'QUANTITY_EXCEEDS_WORK_ORDER',
        workOrderItemId: item.id,
        code: item.code,
        workOrderQuantity: item.quantity,
        reservedQuantity: reserved(item.id, line.id),
        requestedQuantity: body.data.quantity,
        availableQuantity: available,
      });
    }
    line.quantity = body.data.quantity;
    return send(res, 200, projectView(projectId));
  }
  if (method === 'POST' && pricesWord === 'prices') {
    const body = AddContractorPriceRequestSchema.safeParse(await readJson(req));
    if (!body.success) return invalid();
    const latest = line.prices.at(-1)?.effectiveFrom ?? '';
    if (body.data.effectiveFrom <= latest) {
      return conflict({ reason: 'PRICE_DATE_NOT_AFTER_LATEST', latestEffectiveFrom: latest });
    }
    if (cmpDec(body.data.unitPrice, item.contractPrice) > 0) {
      return conflict({
        reason: 'PRICE_EXCEEDS_CONTRACT',
        workOrderItemId: item.id,
        code: item.code,
        contractPrice: item.contractPrice,
        requestedPrice: body.data.unitPrice,
      });
    }
    line.prices.push({
      id: randomUUID(),
      effectiveFrom: body.data.effectiveFrom,
      unitPrice: body.data.unitPrice,
    });
    return send(res, 201, projectView(projectId));
  }
  return sendError(res, 404, 'NOT_FOUND');
}
