/* eslint-disable @typescript-eslint/no-explicit-any -- the mock reads loosely typed request JSON */
/**
 * Subcontractor routes of the mock API (ADR-036), in memory. Request bodies are validated and
 * answers parsed with the shared schemas, so the mock follows the contract.
 *
 * Simplifications (documented because they are not the real implementation):
 *  - The mock does not read the work orders of mock-api.ts. Every project except the two seeded
 *    ones has a fixed virtual work order (T-1, T-2, the box line 2-12-4-8 and a legacy line); the
 *    two seeded projects have none. That keeps this flow independent of the other specs, which
 *    share the mock's state.
 *  - The sheet is the same stand-in as in mock-api.ts: `PK\x03\x04` + JSON `{ sheets }`.
 *    Row numbers are index + 2 (header on row 1).
 */
import { createHash, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  AddContractorPriceRequestSchema,
  ContractorImportCommitPayloadSchema,
  ContractorImportPreviewOptionsSchema,
  ContractorImportPreviewResponseSchema,
  ContractorListResponseSchema,
  ContractorRegistrationSchema,
  ContractorSchema,
  CreateContractorRequestSchema,
  IMPORT_FIELDS,
  IMPORT_HEADER_SYNONYMS,
  Decimal4StringSchema,
  Decimal6StringSchema,
  ProjectContractorsResponseSchema,
  UpdateContractorLineRequestSchema,
  UpdateContractorRequestSchema,
  scopeKeyOf,
} from '@ftth/shared';
import { cmpDec, mulDec, subDec, sumDec } from './mock-decimal.ts';
import type { Helpers } from './mock-design.ts';

const NOW = '2026-11-07T08:00:00.000Z';
const NO_WORK_ORDER = new Set<string>();

interface Part {
  name: string;
  filename: string | null;
  data: Buffer;
}
interface Deps {
  readMultipart: (req: IncomingMessage) => Promise<Part[]>;
  readFixture: (
    data: Buffer,
  ) => { sheets: { name: string; header: string[]; rows: any[][] }[] } | null;
}
let deps: Deps | null = null;
export function configureContractors(value: Deps): void {
  deps = value;
}

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
    id: '5a000000-0000-4000-8000-000000000004',
    lineNo: 3,
    code: '2-12-4-8',
    description: 'تركيب بوكس',
    unit: 'عدد',
    contractPrice: '30',
    quantity: '100',
    assignable: true,
  },
  {
    id: '5a000000-0000-4000-8000-000000000003',
    lineNo: 4,
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
  scope: string | null;
  quantity: string;
  prices: PriceRecord[];
  sourceRow: number | null;
}
interface FileRecord {
  id: string;
  fileName: string;
  sizeBytes: number;
  sha256: string;
}
interface RegistrationRecord {
  id: string;
  projectId: string;
  contractorId: string;
  registeredOn: string;
  lines: LineRecord[];
  files: FileRecord[];
}

const WORK_ORDER_ID = '2b1c9f2e-6b3d-4e8a-9c7f-2d4b6a8c0e1f';
const contractors: any[] = [];
const registrations: RegistrationRecord[] = [];

function itemOf(id: string) {
  const item = WORK_ORDER_LINES.find((entry) => entry.id === id);
  if (!item) throw new Error('unknown work-order line ' + id);
  return item;
}

const highest = (line: LineRecord) =>
  line.prices.reduce(
    (max, price) => (cmpDec(price.unitPrice, max) > 0 ? price.unitPrice : max),
    '0',
  );

/** Every contractor line of the work-order line, in every registration of every project. */
const linesOfItem = (itemId: string) =>
  registrations.flatMap((registration) =>
    registration.lines.filter((line) => line.workOrderItemId === itemId),
  );

/** Per scope key: reserved quantity and highest price ever, over the stored lines. */
function usageOf(itemId: string, exceptLineId?: string) {
  const scopes = new Map<string, { scope: string | null; reserved: string; highest: string }>();
  for (const line of linesOfItem(itemId)) {
    if (line.id === exceptLineId) continue;
    const key = scopeKeyOf(line.scope) ?? '';
    const current = scopes.get(key) ?? { scope: line.scope, reserved: '0', highest: '0' };
    current.reserved = sumDec([current.reserved, line.quantity]);
    if (cmpDec(highest(line), current.highest) > 0) current.highest = highest(line);
    scopes.set(key, current);
  }
  return scopes;
}

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
    scope: record.scope,
    contractPrice: item.contractPrice,
    quantity: record.quantity,
    prices: record.prices.map((price) => ({ ...price, createdById: null, createdAt: NOW })),
    sourceRow: record.sourceRow,
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
    lines: [...record.lines]
      .sort((a, b) => itemOf(a.workOrderItemId).lineNo - itemOf(b.workOrderItemId).lineNo)
      .map(lineView),
    files: record.files.map((file) => ({ ...file, uploadedById: null, createdAt: NOW })),
    createdById: null,
    createdAt: NOW,
  });
}

function availabilityOf(item: (typeof WORK_ORDER_LINES)[number]) {
  const usage = [...usageOf(item.id).values()];
  const total = sumDec(usage.map((entry) => entry.highest));
  const wholeOnly = usage.length === 1 && usage[0]?.scope === null;
  return {
    workOrderItemId: item.id,
    lineNo: item.lineNo,
    code: item.code,
    description: item.description,
    unit: item.unit,
    workType: 'civil',
    contractPrice: item.contractPrice,
    workOrderQuantity: item.quantity,
    mode: usage.length === 0 ? 'free' : wholeOnly ? 'whole' : 'scoped',
    scopes: usage.map((entry) => ({
      scope: entry.scope,
      reservedQuantity: entry.reserved,
      availableQuantity: subDec(item.quantity, entry.reserved),
      highestPrice: entry.highest,
    })),
    scopesPriceTotal: total,
    priceRoom: subDec(item.contractPrice, total),
    assignable: item.assignable,
  };
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
    availability: has ? WORK_ORDER_LINES.map(availabilityOf) : [],
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

// ---------- the uploaded sheet ----------

const normalise = (text: string) => text.trim().toLowerCase().replace(/\s+/g, ' ');
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
type Mapping = Record<(typeof IMPORT_FIELDS)[number], number | null>;

function suggestMapping(header: string[]): Mapping {
  const mapping = Object.fromEntries(IMPORT_FIELDS.map((field) => [field, null])) as Mapping;
  for (const field of IMPORT_FIELDS) {
    const synonyms = IMPORT_HEADER_SYNONYMS[field].map(normalise);
    const index = header.findIndex((cell) => synonyms.includes(normalise(cell)));
    mapping[field] = index === -1 ? null : index;
  }
  // A contractor sheet has no work type or amount column.
  mapping.workType = null;
  mapping.amount = null;
  return mapping;
}

interface Target {
  kind: 'new' | 'append';
  contractorId?: string;
  registeredOn?: string;
  registrationId?: string;
}

function parseSheet(
  file: Part,
  projectId: string,
  target: Target,
  options: { sheetName?: string | undefined; mapping?: Mapping | undefined },
) {
  const fixture = deps?.readFixture(file.data);
  const sheet = fixture?.sheets.find((s) => s.name === options.sheetName) ?? fixture?.sheets[0];
  if (!fixture || !sheet) return null;
  const suggested = suggestMapping(sheet.header);
  const mapping = options.mapping ?? suggested;
  const cell = (row: any[], field: (typeof IMPORT_FIELDS)[number]) => {
    const index = mapping[field];
    const value = index === null ? null : (row[index] ?? null);
    return value === null || value === '' ? null : String(value).trim();
  };
  const existing =
    target.kind === 'append'
      ? registrations.find((entry) => entry.id === target.registrationId)
      : undefined;

  const rows = sheet.rows.map((row, index) => {
    const raw = Object.fromEntries(
      IMPORT_FIELDS.map((field) => [field, cell(row, field)]),
    ) as Record<(typeof IMPORT_FIELDS)[number], string | null>;
    const issues: any[] = [];
    const issue = (code: string, field: string | null = null, params?: Record<string, string>) =>
      issues.push({ code, severity: 'error', field, ...(params ? { params } : {}) });
    const base = {
      rowNumber: index + 2,
      raw,
      code: raw.code,
      description: raw.description,
      unit: raw.unit,
      workType: null,
      scope: raw.scope,
      sheetAmount: null,
      issues,
    };
    // An empty quantity: the row is skipped (as in the work-order import).
    if (raw.quantity === null) {
      issues.push({ code: 'EMPTY_QUANTITY_SKIPPED', severity: 'warning', field: 'quantity' });
      return { ...base, kind: 'skipped', quantity: null, unitPrice: null, amount: null };
    }
    for (const field of ['code', 'description', 'unit', 'unitPrice'] as const) {
      if (raw[field] === null) issue('MISSING_VALUE', field);
    }
    const decimal = (field: 'quantity' | 'unitPrice') => {
      const value = raw[field];
      if (value === null) return null;
      const schema = field === 'quantity' ? Decimal4StringSchema : Decimal6StringSchema;
      if (!schema.safeParse(value).success) {
        issue('INVALID_NUMBER', field);
        return null;
      }
      return value;
    };
    const quantity = decimal('quantity');
    const unitPrice = decimal('unitPrice');
    return {
      ...base,
      kind: 'item',
      quantity,
      unitPrice,
      amount: quantity !== null && unitPrice !== null ? mulDec(quantity, unitPrice) : null,
    };
  });

  const items = rows.filter((row) => row.kind === 'item' && row.code !== null);
  // Same code and scope on two rows of the sheet.
  const keyOf = (row: (typeof rows)[number]) => `${row.code}\u0000${scopeKeyOf(row.scope) ?? ''}`;
  for (const row of items) {
    const same = items.filter((other) => keyOf(other) === keyOf(row) && other !== row);
    if (same.length > 0) {
      row.issues.push({
        code: 'CODE_SCOPE_REPEATED',
        severity: 'error',
        field: 'code',
        params: { scope: row.scope ?? '', otherRows: same.map((o) => o.rowNumber).join(', ') },
      });
    }
  }
  for (const row of items) {
    const item = WORK_ORDER_LINES.find((entry) => entry.code === row.code);
    const issue = (code: string, field: string | null, params?: Record<string, string>) =>
      row.issues.push({ code, severity: 'error', field, ...(params ? { params } : {}) });
    if (!item) {
      issue('NOT_IN_WORK_ORDER', 'code');
      continue;
    }
    if (row.description !== null && row.description !== item.description) {
      issue('WORK_ORDER_MISMATCH', 'description', { workOrderValue: item.description });
    }
    if (row.unit !== null && row.unit !== item.unit) {
      issue('WORK_ORDER_MISMATCH', 'unit', { workOrderValue: item.unit });
    }
    if (!item.assignable) {
      issue('LEGACY_WORK_ORDER_LINE', 'code');
      continue;
    }
    const key = scopeKeyOf(row.scope);
    const stored = usageOf(item.id);
    const sheetOfItem = items.filter((other) => other.code === row.code);
    // A whole line and scopes never mix: with the stored lines or inside the sheet.
    const storedWhole = stored.has('');
    const storedScoped = [...stored.keys()].some((k) => k !== '');
    const sheetWhole = sheetOfItem.some((other) => scopeKeyOf(other.scope) === null);
    const sheetScoped = sheetOfItem.some((other) => scopeKeyOf(other.scope) !== null);
    if ((storedWhole || sheetWhole) && (storedScoped || sheetScoped)) {
      issue('WHOLE_AND_SCOPES_MIXED', 'scope', { code: item.code });
    }
    if (existing?.lines.some((l) => l.workOrderItemId === item.id && scopeKeyOf(l.scope) === key)) {
      issue('LINE_ALREADY_ASSIGNED', 'scope', { scope: row.scope ?? '' });
    }
    // Quantity: per scope, other contractors plus the other rows of this sheet on the same scope.
    const sheetSameScope = sheetOfItem.filter(
      (other) => other !== row && scopeKeyOf(other.scope) === key && other.quantity !== null,
    );
    const reserved = sumDec([
      stored.get(key ?? '')?.reserved ?? '0',
      ...sheetSameScope.map((other) => other.quantity as string),
    ]);
    const available = subDec(item.quantity, reserved);
    if (row.quantity !== null && cmpDec(row.quantity, available) > 0) {
      issue('QUANTITY_EXCEEDS_WORK_ORDER', 'quantity', {
        scope: row.scope ?? '',
        workOrderQuantity: item.quantity,
        reservedQuantity: reserved,
        availableQuantity: available,
      });
    }
    // Price: the other scopes' highest prices plus this price stay within the contract price.
    if (row.unitPrice !== null) {
      const others = new Map<string, string>();
      for (const [k, entry] of stored) if (k !== (key ?? '')) others.set(k, entry.highest);
      for (const other of sheetOfItem) {
        const k = scopeKeyOf(other.scope) ?? '';
        if (k === (key ?? '') || other.unitPrice === null) continue;
        if (cmpDec(other.unitPrice, others.get(k) ?? '0') > 0) others.set(k, other.unitPrice);
      }
      const otherScopesPrice = sumDec([...others.values()]);
      const maxAllowedPrice = subDec(item.contractPrice, otherScopesPrice);
      if (cmpDec(row.unitPrice, maxAllowedPrice) > 0) {
        issue('PRICE_EXCEEDS_CONTRACT', 'unitPrice', {
          contractPrice: item.contractPrice,
          otherScopesPrice,
          maxAllowedPrice,
        });
      }
    }
  }

  const hasError = (row: (typeof rows)[number]) =>
    row.issues.some((entry: any) => entry.severity === 'error');
  void projectId;
  return {
    rows,
    sheet,
    mapping,
    hasError,
    response: ContractorImportPreviewResponseSchema.parse({
      file: {
        name: file.filename ?? 'import.xlsx',
        sizeBytes: file.data.length,
        sha256: createHash('sha256').update(file.data).digest('hex'),
      },
      sheets: fixture.sheets.map((s) => ({ name: s.name, rowCount: s.rows.length })),
      sheetName: sheet.name,
      headerRow: 1,
      columns: sheet.header.map((header, index) => ({
        index,
        letter: LETTERS[index] ?? 'Z',
        header,
      })),
      suggestedMapping: suggested,
      mapping,
      fileIssues: [],
      rows,
      summary: {
        rowCount: rows.length,
        headingCount: 0,
        errorRowCount: rows.filter(hasError).length,
        warningRowCount: rows.filter((row) => !hasError(row) && row.issues.length > 0).length,
        duplicateCodes: [],
        total: sumDec(
          rows.filter((row) => !hasError(row) && row.amount).map((r) => r.amount as string),
        ),
      },
    }),
  };
}

async function handleImport(
  req: IncomingMessage,
  res: ServerResponse,
  projectId: string,
  commit: boolean,
  { send, sendError }: Helpers,
): Promise<void> {
  if (!deps) throw new Error('configureContractors() was not called');
  const parts = await deps.readMultipart(req);
  const file = parts.find((part) => part.name === 'file');
  const payloadPart = parts.find((part) => part.name === 'payload');
  if (!file || !payloadPart) return sendError(res, 400, 'VALIDATION_FAILED');
  let json: unknown;
  try {
    json = JSON.parse(payloadPart.data.toString('utf8'));
  } catch {
    return sendError(res, 400, 'VALIDATION_FAILED');
  }
  if (NO_WORK_ORDER.has(projectId))
    return sendError(res, 409, 'CONFLICT', { reason: 'NO_WORK_ORDER' });

  if (!commit) {
    const options = ContractorImportPreviewOptionsSchema.safeParse(json);
    if (!options.success) return sendError(res, 400, 'VALIDATION_FAILED');
    const parsed = parseSheet(file, projectId, options.data.target, {
      sheetName: options.data.sheetName,
      mapping: options.data.mapping as Mapping | undefined,
    });
    if (!parsed) return sendError(res, 400, 'VALIDATION_FAILED');
    return send(res, 200, parsed.response);
  }

  const payload = ContractorImportCommitPayloadSchema.safeParse(json);
  if (!payload.success) return sendError(res, 400, 'VALIDATION_FAILED');
  const { target } = payload.data;
  const invalid = (reason: string, extra: Record<string, unknown> = {}) =>
    sendError(res, 422, 'IMPORT_INVALID', {
      reason,
      fileIssues: [],
      rows: [],
      duplicateCodes: [],
      ...extra,
    });
  const parsed = parseSheet(file, projectId, target, {
    sheetName: payload.data.sheetName,
    mapping: payload.data.mapping as Mapping,
  });
  if (!parsed || parsed.response.file.sha256 !== payload.data.fileSha256) {
    return invalid('FILE_CHANGED');
  }
  const excluded = new Set<number>(payload.data.excludedRowNumbers);
  const included = parsed.rows.filter((row) => !excluded.has(row.rowNumber) && row.kind === 'item');
  if (included.length === 0) return invalid('NO_ROWS_INCLUDED');
  const withErrors = included.filter(parsed.hasError);
  if (withErrors.length > 0) {
    return invalid('ROW_ERRORS', {
      rows: withErrors.map((row) => ({ rowNumber: row.rowNumber, issues: row.issues })),
    });
  }

  let registration: RegistrationRecord | undefined;
  if (target.kind === 'new') {
    if (!contractors.some((entry) => entry.id === target.contractorId)) {
      return sendError(res, 404, 'NOT_FOUND');
    }
    if (
      registrations.some(
        (entry) => entry.projectId === projectId && entry.contractorId === target.contractorId,
      )
    ) {
      return sendError(res, 409, 'CONFLICT', { reason: 'CONTRACTOR_ALREADY_REGISTERED' });
    }
    registration = {
      id: randomUUID(),
      projectId,
      contractorId: target.contractorId,
      registeredOn: target.registeredOn,
      lines: [],
      files: [],
    };
  } else {
    registration = registrations.find(
      (entry) => entry.id === target.registrationId && entry.projectId === projectId,
    );
    if (!registration) return sendError(res, 404, 'NOT_FOUND');
  }
  for (const row of included) {
    const item = WORK_ORDER_LINES.find((entry) => entry.code === row.code);
    if (!item || row.quantity === null || row.unitPrice === null) continue;
    registration.lines.push({
      id: randomUUID(),
      workOrderItemId: item.id,
      scope: row.scope,
      quantity: row.quantity,
      // The first price starts on the registration date.
      prices: [
        { id: randomUUID(), effectiveFrom: registration.registeredOn, unitPrice: row.unitPrice },
      ],
      sourceRow: row.rowNumber,
    });
  }
  registration.files.push({
    id: randomUUID(),
    fileName: file.filename ?? 'import.xlsx',
    sizeBytes: Math.max(1, file.data.length),
    sha256: parsed.response.file.sha256,
  });
  if (!registrations.includes(registration)) registrations.push(registration);
  return send(res, 201, projectView(projectId));
}

/**
 * `/admin/projects/:projectId/contractors/...` and `/projects/:projectId/contractors` (GET).
 * `tail` = the segments after `contractors`: [registrationId, 'lines', lineId, 'prices'] or
 * ['import'] / ['import', 'preview'].
 */
export async function handleProjectContractors(
  req: IncomingMessage,
  res: ServerResponse,
  projectId: string,
  tail: string[],
  helpers: Helpers,
): Promise<void> {
  const { send, sendError, readJson } = helpers;
  const method = req.method ?? 'GET';
  const [registrationId, linesWord, lineId, pricesWord] = tail;
  const invalid = () => sendError(res, 400, 'VALIDATION_FAILED');
  const conflict = (details: Record<string, unknown>) => sendError(res, 409, 'CONFLICT', details);

  if (registrationId === 'import') {
    if (method !== 'POST') return sendError(res, 404, 'NOT_FOUND');
    if (linesWord === 'preview') return handleImport(req, res, projectId, false, helpers);
    if (linesWord === undefined) return handleImport(req, res, projectId, true, helpers);
    return sendError(res, 404, 'NOT_FOUND');
  }
  if (!registrationId) {
    if (method === 'GET') return send(res, 200, projectView(projectId));
    return sendError(res, 404, 'NOT_FOUND');
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
  const line = record.lines.find((entry) => entry.id === lineId);
  if (linesWord !== 'lines' || !line) return sendError(res, 404, 'NOT_FOUND');
  const item = itemOf(line.workOrderItemId);
  const key = scopeKeyOf(line.scope) ?? '';

  if (method === 'DELETE' && !pricesWord) {
    if (record.lines.length === 1) return conflict({ reason: 'LAST_LINE' });
    record.lines.splice(record.lines.indexOf(line), 1);
    return send(res, 204);
  }
  if (method === 'PATCH' && !pricesWord) {
    const body = UpdateContractorLineRequestSchema.safeParse(await readJson(req));
    if (!body.success) return invalid();
    const others = usageOf(item.id, line.id).get(key)?.reserved ?? '0';
    const available = subDec(item.quantity, others);
    if (cmpDec(body.data.quantity, available) > 0) {
      return conflict({
        reason: 'QUANTITY_EXCEEDS_WORK_ORDER',
        workOrderItemId: item.id,
        code: item.code,
        scope: line.scope,
        workOrderQuantity: item.quantity,
        reservedQuantity: others,
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
    const otherScopes = [...usageOf(item.id).entries()]
      .filter(([k]) => k !== key)
      .map(([, entry]) => entry.highest);
    const otherScopesPrice = sumDec(otherScopes);
    const maxAllowedPrice = subDec(item.contractPrice, otherScopesPrice);
    if (cmpDec(body.data.unitPrice, maxAllowedPrice) > 0) {
      return conflict({
        reason: 'PRICE_EXCEEDS_CONTRACT',
        workOrderItemId: item.id,
        code: item.code,
        contractPrice: item.contractPrice,
        otherScopesPrice,
        maxAllowedPrice,
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
