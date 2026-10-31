/* eslint-disable @typescript-eslint/no-explicit-any -- the mock reads loosely typed request JSON */
/**
 * Tiny stand-in for the FTTH API used by the Playwright run. It is started with plain `node`
 * (type stripping), so it only uses erasable TypeScript. Every response body is parsed with the
 * shared schemas before it is sent, so the mock cannot drift from the contract unnoticed.
 *
 * Simplifications (documented because they are not the real implementation):
 *  - The "xlsx" fixture is `PK\x03\x04` followed by JSON `{ sheets: [{ name, header, rows }] }`;
 *    the mock reads that JSON instead of unzipping real OOXML. The preview/commit rules (header
 *    detection by synonyms, decimals, duplicates, IMPORT_INVALID reasons) follow the contract.
 *  - CAD processing is simulated by time: queued -> processing -> processed.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  AddWorkOrderItemRequestSchema,
  ContractItemAvailabilityResponseSchema,
  CreateWorkOrderRequestSchema,
  UpdateWorkOrderItemRequestSchema,
  CadCurvePageSchema,
  CadFileDetailSchema,
  CadFileListResponseSchema,
  CadFileLogResponseSchema,
  CadFileSummarySchema,
  CadInsertPageSchema,
  CadLayerListResponseSchema,
  CadTextPageSchema,
  Decimal4StringSchema,
  Decimal6StringSchema,
  IMPORT_FIELDS,
  IMPORT_HEADER_SYNONYMS,
  WORK_TYPE_SYNONYMS,
  WORK_TYPES,
  type WorkType,
  WorkOrderAttachmentListResponseSchema,
  WorkOrderAttachmentSchema,
  WorkOrderDetailSchema,
  WorkOrderImportPreviewResponseSchema,
  WorkOrderItemSchema,
  WorkOrderListResponseSchema,
} from '@ftth/shared';
import {
  ADMIN_ACCESS,
  ADMIN_EMAIL,
  ADMIN_ME,
  ADMIN_REFRESH,
  createAdminState,
  handleAdmin,
} from './mock-admin.ts';
import { cmpDec, mulDec, subDec, sumDec } from './mock-decimal.ts';
import {
  configureContracts,
  contractView,
  handleProjectContract,
  seedContractId,
  seedDraftContractId,
} from './mock-contracts.ts';
import {
  MOCK_DETECTION,
  handleDesignRevisions,
  handleMapping,
  type Helpers,
  type MockCadFile,
} from './mock-design.ts';

const PORT = Number(process.env.MOCK_API_PORT ?? 3101);
const EMAIL = 'pm@example.com';
const PASSWORD = 'correct-password';
const ACCESS = 'mock-access-token';
const REFRESH = 'mock-refresh-token-0123456789abcdef0123456789';
const PROJECT_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
// A second project of the same PM, under a contract that is still a draft (ADR-028 e2e).
const DRAFT_PROJECT_ID = '1f8fad5b-d9cb-469f-a165-70867728950e';
const PROJECT_CONTRACTS: Record<string, string> = {
  [PROJECT_ID]: seedContractId,
  [DRAFT_PROJECT_ID]: seedDraftContractId,
};
const CURRENCY = 'EGP';

const ME = {
  id: 'b3b5c5a2-1f0e-4c5e-8a4b-6d2f9a7e1c10',
  email: EMAIL,
  displayName: 'منى أحمد',
  locale: 'ar',
  isAdmin: false,
  memberships: [
    {
      projectId: PROJECT_ID,
      projectName: 'شبكة الألياف - القاهرة الجديدة',
      role: 'pm',
      zoneIds: [],
    },
    {
      projectId: DRAFT_PROJECT_ID,
      projectName: 'مشروع الإسكندرية (عقد مسودة)',
      role: 'pm',
      zoneIds: [],
    },
  ],
};

function send(res: ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    res.writeHead(status).end();
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

function sendError(res: ServerResponse, status: number, code: string, details?: unknown): void {
  send(res, status, { code, message: code, ...(details === undefined ? {} : { details }) });
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  try {
    return JSON.parse((await readBody(req)).toString('utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

// ---------- multipart ----------

interface Part {
  name: string;
  filename: string | null;
  data: Buffer;
}

function parseMultipart(contentType: string, body: Buffer): Part[] {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const marker = Buffer.from(`--${boundary?.[1] ?? boundary?.[2] ?? ''}`);
  const parts: Part[] = [];
  let start = body.indexOf(marker);
  while (start !== -1) {
    const next = body.indexOf(marker, start + marker.length);
    if (next === -1) break;
    const chunk = body.subarray(start + marker.length + 2, next - 2); // drop CRLF around the part
    const split = chunk.indexOf('\r\n\r\n');
    const head = chunk.subarray(0, split).toString('utf8');
    const name = /name="([^"]*)"/.exec(head)?.[1] ?? '';
    const filename = /filename="([^"]*)"/.exec(head)?.[1] ?? null;
    parts.push({ name, filename, data: chunk.subarray(split + 4) });
    start = next;
  }
  return parts;
}

async function readMultipart(req: IncomingMessage): Promise<Part[]> {
  return parseMultipart(req.headers['content-type'] ?? '', await readBody(req));
}

// ---------- work orders ----------

interface ItemRecord {
  id: string;
  lineNo: number;
  code: string;
  description: string;
  unit: string;
  quantity: string;
  unitPrice: string;
  workType: WorkType | null;
  /** Contract item the line comes from (ADR-028); null = legacy line. */
  contractItemId: string | null;
  source: 'manual' | 'import';
  sourceRow: number | null;
}

interface AttachmentRecord {
  id: string;
  kind: 'document' | 'import_source';
  fileName: string;
  contentType: string;
  data: Buffer;
  createdAt: string;
}

interface WorkOrderRecord {
  id: string;
  projectId: string;
  number: string;
  title: string | null;
  issuedOn: string | null;
  notes: string | null;
  source: 'manual' | 'import';
  version: number;
  items: ItemRecord[];
  attachments: AttachmentRecord[];
  createdAt: string;
  updatedAt: string;
}

const workOrders = new Map<string, WorkOrderRecord>();

function itemOut(workOrderId: string, item: ItemRecord) {
  const now = new Date().toISOString();
  return WorkOrderItemSchema.parse({
    id: item.id,
    workOrderId,
    lineNo: item.lineNo,
    code: item.code,
    description: item.description,
    unit: item.unit,
    quantity: item.quantity,
    unitPrice: item.unitPrice,
    amount: mulDec(item.quantity, item.unitPrice),
    workType: item.workType,
    contractItemId: item.contractItemId,
    source: item.source,
    sourceRow: item.sourceRow,
    createdAt: now,
    updatedAt: now,
  });
}

function attachmentOut(workOrderId: string, attachment: AttachmentRecord) {
  return WorkOrderAttachmentSchema.parse({
    id: attachment.id,
    workOrderId,
    kind: attachment.kind,
    fileName: attachment.fileName,
    contentType: attachment.contentType,
    sizeBytes: Math.max(1, attachment.data.length),
    sha256: createHash('sha256').update(attachment.data).digest('hex'),
    uploadedById: ME.id,
    createdAt: attachment.createdAt,
  });
}

function summaryOut(workOrder: WorkOrderRecord) {
  return {
    id: workOrder.id,
    projectId: workOrder.projectId,
    number: workOrder.number,
    title: workOrder.title,
    issuedOn: workOrder.issuedOn,
    currency: CURRENCY,
    source: workOrder.source,
    itemCount: workOrder.items.length,
    total: sumDec(workOrder.items.map((item) => mulDec(item.quantity, item.unitPrice))),
    attachmentCount: workOrder.attachments.length,
    version: workOrder.version,
    createdAt: workOrder.createdAt,
    updatedAt: workOrder.updatedAt,
  };
}

function duplicateCodesOf(workOrder: WorkOrderRecord) {
  const lines = new Map<string, number[]>();
  for (const item of workOrder.items)
    lines.set(item.code, [...(lines.get(item.code) ?? []), item.lineNo]);
  return [...lines.entries()]
    .filter(([, lineNos]) => lineNos.length > 1)
    .map(([code, lineNos]) => ({ code, lineNos }));
}

function detailOut(workOrder: WorkOrderRecord) {
  return WorkOrderDetailSchema.parse({
    ...summaryOut(workOrder),
    notes: workOrder.notes,
    items: workOrder.items.map((item) => itemOut(workOrder.id, item)),
    attachments: workOrder.attachments.map((a) => attachmentOut(workOrder.id, a)),
    duplicateCodes: duplicateCodesOf(workOrder),
  });
}

function newWorkOrder(
  projectId: string,
  header: Record<string, unknown>,
  source: 'manual' | 'import',
): WorkOrderRecord {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    projectId,
    number: String(header.number ?? ''),
    title: (header.title as string | null | undefined) ?? null,
    issuedOn: (header.issuedOn as string | null | undefined) ?? null,
    notes: (header.notes as string | null | undefined) ?? null,
    source,
    version: 1,
    items: [],
    attachments: [],
    createdAt: now,
    updatedAt: now,
  };
}

function numberTaken(projectId: string, number: string, exceptId?: string): boolean {
  return [...workOrders.values()].some(
    (w) => w.projectId === projectId && w.number === number && w.id !== exceptId,
  );
}

// ---------- work-order lines come from the approved contract (ADR-028) ----------

type ContractData = NonNullable<ReturnType<typeof contractView>>;

/** The project's contract when it can take work-order lines, else the 409 reason. */
function contractGate(projectId: string): { contract: ContractData } | { reason: string } {
  const contractId = PROJECT_CONTRACTS[projectId];
  const contract = contractId ? contractView(contractId) : undefined;
  if (!contract) return { reason: 'NO_CONTRACT' };
  if (contract.status !== 'approved') return { reason: 'CONTRACT_NOT_APPROVED' };
  return { contract };
}

/** Σ quantity per contract item over every work order of the contract (all projects). */
function reservedOn(contractId: string, exceptWorkOrderId?: string): Map<string, string> {
  const reserved = new Map<string, string>();
  for (const workOrder of workOrders.values()) {
    if (PROJECT_CONTRACTS[workOrder.projectId] !== contractId) continue;
    if (workOrder.id === exceptWorkOrderId) continue;
    for (const item of workOrder.items) {
      if (item.contractItemId === null) continue;
      reserved.set(
        item.contractItemId,
        sumDec([reserved.get(item.contractItemId) ?? '0', item.quantity]),
      );
    }
  }
  return reserved;
}

function availabilityOut(projectId: string, contract: ContractData) {
  const reserved = reservedOn(contract.id);
  const own = [...workOrders.values()].find((w) => w.projectId === projectId);
  return ContractItemAvailabilityResponseSchema.parse({
    contractId: contract.id,
    contractNumber: contract.number,
    items: contract.lines.map((line) => {
      const reservedQuantity = reserved.get(line.id) ?? '0';
      return {
        contractItemId: line.id,
        lineNo: line.lineNo,
        code: line.code,
        description: line.description,
        unit: line.unit,
        unitPrice: line.unitPrice,
        workType: line.workType,
        contractQuantity: line.quantity,
        reservedQuantity,
        availableQuantity: subDec(line.quantity, reservedQuantity),
        workOrderItemId: own?.items.find((item) => item.contractItemId === line.id)?.id ?? null,
      };
    }),
  });
}

/** Sends the 409 and returns true when the quantity is not in the contract or above what is left. */
function rejectQuantity(
  res: ServerResponse,
  contract: ContractData,
  contractItemId: string,
  quantity: string,
  exceptWorkOrderId?: string,
): boolean {
  const line = contract.lines.find((candidate) => candidate.id === contractItemId);
  if (!line) {
    sendError(res, 409, 'CONFLICT', { reason: 'NOT_IN_CONTRACT', contractItemId });
    return true;
  }
  const reservedQuantity = reservedOn(contract.id, exceptWorkOrderId).get(line.id) ?? '0';
  const availableQuantity = subDec(line.quantity, reservedQuantity);
  if (cmpDec(quantity, availableQuantity) > 0) {
    sendError(res, 409, 'CONFLICT', {
      reason: 'QUANTITY_EXCEEDS_CONTRACT',
      contractItemId,
      code: line.code,
      contractQuantity: line.quantity,
      reservedQuantity,
      requestedQuantity: quantity,
      availableQuantity,
    });
    return true;
  }
  return false;
}

function itemFromContract(
  line: ContractData['lines'][number],
  lineNo: number,
  quantity: string,
): ItemRecord {
  return {
    id: randomUUID(),
    lineNo,
    code: line.code,
    description: line.description,
    unit: line.unit,
    quantity,
    unitPrice: line.unitPrice,
    workType: line.workType,
    contractItemId: line.id,
    source: 'manual',
    sourceRow: null,
  };
}

// ---------- excel import (fixture format, see header comment) ----------

interface FixtureSheet {
  name: string;
  header: string[];
  rows: (string | number | null)[][];
}

function readFixture(data: Buffer): { sheets: FixtureSheet[] } | null {
  if (data.length < 4 || data.readUInt32LE(0) !== 0x04034b50) return null;
  try {
    return JSON.parse(data.subarray(4).toString('utf8')) as { sheets: FixtureSheet[] };
  } catch {
    return null;
  }
}

type Mapping = Record<(typeof IMPORT_FIELDS)[number], number | null>;

const normalise = (text: string) => text.trim().toLowerCase().replace(/\s+/g, ' ');

function suggestMapping(header: string[]): Mapping {
  const mapping = Object.fromEntries(IMPORT_FIELDS.map((field) => [field, null])) as Mapping;
  for (const field of IMPORT_FIELDS) {
    const synonyms = IMPORT_HEADER_SYNONYMS[field].map(normalise);
    const index = header.findIndex((cell) => synonyms.includes(normalise(cell)));
    mapping[field] = index === -1 ? null : index;
  }
  return mapping;
}

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function parsePreview(
  file: Part,
  options: { sheetName?: string; mapping?: Mapping },
  /** Work-order import: rows are matched to this approved contract (ADR-028). */
  against?: { contract: ContractData; reserved: Map<string, string> },
) {
  const fixture = readFixture(file.data);
  if (!fixture) return null;
  const sheet = fixture.sheets.find((s) => s.name === options.sheetName) ?? fixture.sheets[0];
  if (!sheet) return null;
  const suggested = suggestMapping(sheet.header);
  const mapping = options.mapping ?? suggested;
  const cell = (row: (string | number | null)[], field: (typeof IMPORT_FIELDS)[number]) => {
    const index = mapping[field];
    const value = index === null ? null : (row[index] ?? null);
    return value === null || value === '' ? null : String(value);
  };

  const rows = sheet.rows.map((row, index) => {
    const raw = Object.fromEntries(
      IMPORT_FIELDS.map((field) => [field, cell(row, field)]),
    ) as Record<(typeof IMPORT_FIELDS)[number], string | null>;
    const issues: unknown[] = [];
    // A heading row (owner, 2026-10-31): no unit, no price, quantity and amount empty or zero.
    const zeroOrEmpty = (value: string | null) => value === null || Number(value) === 0;
    if (
      raw.unit === null &&
      raw.unitPrice === null &&
      zeroOrEmpty(raw.quantity) &&
      zeroOrEmpty(raw.amount)
    ) {
      if (raw.code === null)
        issues.push({ code: 'MISSING_VALUE', severity: 'error', field: 'code' });
      return {
        rowNumber: index + 2,
        kind: 'heading' as 'heading' | 'item',
        raw,
        code: raw.code,
        description: raw.description,
        unit: null as string | null,
        quantity: null as string | null,
        unitPrice: null as string | null,
        workType: null as WorkType | null,
        sheetAmount: raw.amount,
        amount: null as string | null,
        issues,
      };
    }
    for (const field of [
      'code',
      'description',
      'unit',
      'quantity',
      'unitPrice',
      'workType',
    ] as const) {
      if (raw[field] === null) issues.push({ code: 'MISSING_VALUE', severity: 'error', field });
    }
    const decimal = (field: 'quantity' | 'unitPrice') => {
      const value = raw[field];
      if (value === null) return null;
      const schema = field === 'quantity' ? Decimal4StringSchema : Decimal6StringSchema;
      if (!schema.safeParse(value).success) {
        issues.push({ code: 'INVALID_NUMBER', severity: 'error', field });
        return null;
      }
      return value;
    };
    const quantity = decimal('quantity');
    const unitPrice = decimal('unitPrice');
    const typeText = raw.workType === null ? null : normalise(raw.workType);
    const workType =
      typeText === null
        ? null
        : (WORK_TYPES.find((type) => WORK_TYPE_SYNONYMS[type].map(normalise).includes(typeText)) ??
          null);
    if (typeText !== null && workType === null) {
      issues.push({ code: 'INVALID_WORK_TYPE', severity: 'error', field: 'workType' });
    }
    return {
      rowNumber: index + 2,
      kind: 'item' as 'heading' | 'item',
      raw,
      code: raw.code,
      description: raw.description,
      unit: raw.unit,
      quantity,
      unitPrice,
      workType,
      sheetAmount: raw.amount,
      amount: quantity !== null && unitPrice !== null ? mulDec(quantity, unitPrice) : null,
      issues,
    };
  });

  const byCode = new Map<string, number[]>();
  for (const row of rows) {
    if (row.code !== null) byCode.set(row.code, [...(byCode.get(row.code) ?? []), row.rowNumber]);
  }
  const repeated = [...byCode.entries()]
    .filter(([, rowNumbers]) => rowNumbers.length > 1)
    .map(([code, rowNumbers]) => ({ code, rowNumbers }));
  // A work order has no duplicate decision: a repeated code is an error on every row (ADR-028).
  const duplicateCodes = against ? [] : repeated;
  for (const duplicate of repeated) {
    for (const row of rows) {
      if (row.code !== duplicate.code) continue;
      row.issues.push({
        code: against ? 'CODE_REPEATED' : 'DUPLICATE_CODE',
        severity: against ? 'error' : 'warning',
        field: 'code',
        params: { otherRows: duplicate.rowNumbers.filter((n) => n !== row.rowNumber).join(', ') },
      });
    }
  }

  if (against) {
    for (const row of rows) {
      if (row.kind !== 'item' || row.code === null) continue;
      const line = against.contract.lines.find((candidate) => candidate.code === row.code);
      if (!line) {
        row.issues.push({ code: 'NOT_IN_CONTRACT', severity: 'error', field: 'code' });
        continue;
      }
      const mismatch = (field: string, contractValue: string) =>
        row.issues.push({
          code: 'CONTRACT_MISMATCH',
          severity: 'error',
          field,
          params: { contractValue },
        });
      if (row.description !== null && row.description.trim() !== line.description) {
        mismatch('description', line.description);
      }
      if (row.unit !== null && row.unit.trim() !== line.unit) mismatch('unit', line.unit);
      if (row.unitPrice !== null && cmpDec(row.unitPrice, line.unitPrice) !== 0) {
        mismatch('unitPrice', line.unitPrice);
      }
      if (row.workType !== null && row.workType !== line.workType) {
        mismatch('workType', line.workType);
      }
      const reservedQuantity = against.reserved.get(line.id) ?? '0';
      const availableQuantity = subDec(line.quantity, reservedQuantity);
      if (row.quantity !== null && cmpDec(row.quantity, availableQuantity) > 0) {
        row.issues.push({
          code: 'QUANTITY_EXCEEDS_CONTRACT',
          severity: 'error',
          field: 'quantity',
          params: {
            availableQuantity,
            contractQuantity: line.quantity,
            reservedQuantity,
          },
        });
      }
    }
  }

  // The same unit typed differently (spaces / line breaks): warn, keep the value as typed.
  const unitGroups = new Map<string, typeof rows>();
  for (const row of rows) {
    if (row.kind !== 'item' || row.unit === null) continue;
    const key = row.unit.replace(/\s+/g, ' ').trim();
    unitGroups.set(key, [...(unitGroups.get(key) ?? []), row]);
  }
  for (const group of unitGroups.values()) {
    for (const row of group) {
      const others = group.filter((other) => other.unit !== row.unit).map((o) => o.rowNumber);
      if (others.length > 0) {
        row.issues.push({
          code: 'UNIT_FORM_VARIANT',
          severity: 'warning',
          field: 'unit',
          params: { otherRows: others.join(', ') },
        });
      }
    }
  }

  const hasError = (row: (typeof rows)[number]) =>
    row.issues.some((issue) => (issue as { severity: string }).severity === 'error');
  const hasWarning = (row: (typeof rows)[number]) =>
    row.issues.some((issue) => (issue as { severity: string }).severity === 'warning');
  return {
    sheet,
    mapping,
    suggested,
    rows,
    hasError,
    duplicateCodes,
    contractLines: against?.contract.lines ?? [],
    response: WorkOrderImportPreviewResponseSchema.parse({
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
        headingCount: rows.filter((row) => row.kind === 'heading').length,
        errorRowCount: rows.filter(hasError).length,
        warningRowCount: rows.filter(hasWarning).length,
        duplicateCodes,
        total: sumDec(
          rows
            .filter((row) => !hasError(row) && row.amount !== null)
            .map((row) => row.amount as string),
        ),
      },
    }),
  };
}

// ---------- CAD ----------

interface CadRecord {
  id: string;
  originalName: string;
  format: 'dwg' | 'dxf';
  sizeBytes: number;
  sha256: string;
  data: Buffer | null;
  createdAt: string;
  queuedAt: number;
}

const cadFiles = new Map<string, CadRecord>();
const QUEUED_MS = 2500;
const PROCESSING_MS = 3000;

function cadStatus(file: CadRecord): 'queued' | 'processing' | 'processed' {
  const age = Date.now() - file.queuedAt;
  if (age < QUEUED_MS) return 'queued';
  return age < QUEUED_MS + PROCESSING_MS ? 'processing' : 'processed';
}

const LAYER_ID_BASE = 'aaaaaaaa-0000-4000-8000-0000000000';
const LAYERS = [
  { name: 'ROUTE-MAIN', aciColor: 1, counts: { LWPOLYLINE: 3, LINE: 1 } },
  { name: 'MANHOLE', aciColor: 30, counts: { INSERT: 2 } },
  { name: 'طبقة-النصوص', aciColor: 7, counts: { TEXT: 2, MTEXT: 1 } },
];

function cadSummary(file: CadRecord) {
  const status = cadStatus(file);
  const processed = status === 'processed';
  return {
    id: file.id,
    projectId: PROJECT_ID,
    originalName: file.originalName,
    format: file.format,
    sizeBytes: Math.max(1, file.sizeBytes),
    sha256: file.sha256,
    status,
    uploadedById: ME.id,
    counts: processed ? { layers: LAYERS.length, inserts: 2, texts: 3, curves: 4 } : null,
    warningCount: processed ? 1 : 0,
    errorCode: null,
    createdAt: file.createdAt,
    updatedAt: file.createdAt,
    processedAt: processed
      ? new Date(file.queuedAt + QUEUED_MS + PROCESSING_MS).toISOString()
      : null,
  };
}

function cadDetail(file: CadRecord) {
  const processed = cadStatus(file) === 'processed';
  return CadFileDetailSchema.parse({
    ...cadSummary(file),
    dxfVersion: processed ? 'AC1032' : null,
    converter: processed ? 'none' : null,
    converterVersion: null,
    insUnits: processed ? 1 : null,
    crsDetection: processed ? MOCK_DETECTION : null,
    extents: processed ? { minX: 0, minY: 0, maxX: 1500.5, maxY: 980.25 } : null,
    warnings: processed
      ? [{ code: 'UNITS_CRS_MISMATCH', count: 1, params: { declared: 'in', implied: 'm' } }]
      : [],
    errorMessage: null,
    queuedAt: new Date(file.queuedAt).toISOString(),
    processingStartedAt: null,
  });
}

function page<T>(items: T[], url: URL) {
  const pageNo = Number(url.searchParams.get('page') ?? 1);
  const pageSize = Number(url.searchParams.get('pageSize') ?? 100);
  return {
    items: items.slice((pageNo - 1) * pageSize, pageNo * pageSize),
    page: pageNo,
    pageSize,
    total: items.length,
  };
}

const point = (x: number, y: number) => ({ x, y, z: 0 });

function cadLayers() {
  return LAYERS.map((layer, index) => ({
    id: `${LAYER_ID_BASE}${String(index + 10)}`,
    name: layer.name,
    aciColor: layer.aciColor,
    trueColor: null,
    linetype: 'Continuous',
    isOn: true,
    isFrozen: false,
    isLocked: false,
    entityCounts: layer.counts,
    entityTotal: Object.values(layer.counts).reduce((a, b) => a + b, 0),
  }));
}

function cadInserts() {
  return [0, 1].map((n) => ({
    id: `bbbbbbbb-0000-4000-8000-00000000000${n}`,
    handle: `1A${n}`,
    layer: 'MANHOLE',
    blockName: `MH-${n + 1}`,
    position: point(100 * (n + 1), 50),
    rotation: 90 * n,
    scale: point(1, 1),
    aciColor: 256,
    attributes: [{ tag: 'ID', rawValue: `MH-0${n + 1}`, value: `MH-0${n + 1}`, readable: true }],
  }));
}

function cadTexts() {
  return [
    { text: 'خط رئيسي', readable: true, raw: 'خط رئيسي' },
    { text: 'F 36 C', readable: true, raw: '{\\fArial;F 36 C}' },
    { text: '????', readable: false, raw: '%%U\\M+ABCD' },
  ].map((entry, n) => ({
    id: `cccccccc-0000-4000-8000-00000000000${n}`,
    handle: `2B${n}`,
    kind: n === 1 ? 'mtext' : 'text',
    layer: 'طبقة-النصوص',
    position: point(10 * n, 20),
    height: 2.5,
    rotation: 0,
    rawText: entry.raw,
    text: entry.text,
    readable: entry.readable,
    style: 'Standard',
    font: 'arial.ttf',
    aciColor: 7,
  }));
}

function cadCurves() {
  return [0, 1, 2, 3].map((n) => ({
    id: `dddddddd-0000-4000-8000-00000000000${n}`,
    handle: `3C${n}`,
    entityType: n === 3 ? 'LINE' : 'LWPOLYLINE',
    layer: 'ROUTE-MAIN',
    vertexCount: 2 + n,
    isClosed: false,
    length: 120.5 * (n + 1),
    bbox: { minX: 0, minY: 0, maxX: 100, maxY: 50 },
    approximated: false,
    aciColor: 256,
  }));
}

// ---------- mapping / design revisions (see mock-design.ts) ----------

const helpers: Helpers = { send, sendError, readJson, page };

function mockCad(file: CadRecord): MockCadFile {
  return {
    id: file.id,
    projectId: PROJECT_ID,
    originalName: file.originalName,
    processed: cadStatus(file) === 'processed',
    userId: ME.id,
    layers: LAYERS.map((layer) => ({
      name: layer.name,
      aciColor: layer.aciColor,
      counts: Object.fromEntries(Object.entries(layer.counts)) as Record<string, number>,
    })),
    inserts: cadInserts().map((insert) => ({ blockName: insert.blockName, layer: insert.layer })),
    texts: cadTexts().map((text) => ({
      layer: text.layer,
      text: text.text,
      readable: text.readable,
    })),
  };
}

// ---------- routing ----------

const tokens = { accessToken: ACCESS, refreshToken: REFRESH, expiresIn: 900 };

async function handleProject(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  segments: string[],
): Promise<void> {
  const [, projectId, resource, id, sub, subId, subSub] = segments;
  if (projectId === undefined || !(projectId in PROJECT_CONTRACTS)) {
    return sendError(res, 404, 'NOT_FOUND');
  }
  const method = req.method ?? 'GET';

  if (resource === 'work-orders')
    return handleWorkOrders(req, res, method, projectId, [id, sub, subId, subSub]);
  if (resource === 'contract')
    return handleProjectContract(res, method, PROJECT_CONTRACTS[projectId] ?? null);
  if (projectId !== PROJECT_ID) return sendError(res, 404, 'NOT_FOUND');
  if (resource === 'cad-files') return handleCad(req, res, url, method, [id, sub]);
  if (resource === 'design-revisions') {
    return handleDesignRevisions(req, res, url, method, [id, sub, subId], helpers, (cadId) => {
      const record = cadFiles.get(cadId);
      return record ? mockCad(record) : undefined;
    });
  }
  return sendError(res, 404, 'NOT_FOUND');
}

async function handleWorkOrders(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  projectId: string,
  [id, sub, subId, subSub]: (string | undefined)[],
): Promise<void> {
  const existing = [...workOrders.values()].find((w) => w.projectId === projectId);
  /** 409 NO_CONTRACT / CONTRACT_NOT_APPROVED / WORK_ORDER_EXISTS before anything is read. */
  const creationGate = () => {
    const gate = contractGate(projectId);
    if ('reason' in gate) {
      sendError(res, 409, 'CONFLICT', { reason: gate.reason });
      return null;
    }
    if (existing) {
      sendError(res, 409, 'CONFLICT', { reason: 'WORK_ORDER_EXISTS' });
      return null;
    }
    return gate.contract;
  };

  if (id === 'contract-items' && method === 'GET') {
    const gate = contractGate(projectId);
    if ('reason' in gate) return sendError(res, 409, 'CONFLICT', { reason: gate.reason });
    return send(res, 200, availabilityOut(projectId, gate.contract));
  }

  if (id === undefined) {
    if (method === 'GET') {
      const items = [...workOrders.values()]
        .filter((w) => w.projectId === projectId)
        .sort((a, b) => a.number.localeCompare(b.number))
        .map(summaryOut);
      return send(res, 200, WorkOrderListResponseSchema.parse({ items }));
    }
    if (method === 'POST') {
      const body = CreateWorkOrderRequestSchema.safeParse(await readJson(req));
      if (!body.success) return sendError(res, 400, 'VALIDATION_FAILED');
      const contract = creationGate();
      if (!contract) return;
      if (numberTaken(projectId, body.data.number)) return sendError(res, 409, 'CONFLICT');
      for (const line of body.data.lines) {
        if (rejectQuantity(res, contract, line.contractItemId, line.quantity)) return;
      }
      const workOrder = newWorkOrder(projectId, body.data, 'manual');
      workOrder.items = body.data.lines.flatMap((line, index) => {
        const found = contract.lines.find((candidate) => candidate.id === line.contractItemId);
        return found ? [itemFromContract(found, index + 1, line.quantity)] : [];
      });
      workOrders.set(workOrder.id, workOrder);
      return send(res, 201, detailOut(workOrder));
    }
  }

  if (id === 'import') {
    const contract = creationGate();
    if (!contract) return;
    const parts = await readMultipart(req);
    const file = parts.find((part) => part.name === 'file');
    const payload = JSON.parse(
      parts.find((part) => part.name === 'payload')?.data.toString('utf8') ?? '{}',
    ) as Record<string, any>;
    if (!file || !readFixture(file.data)) return sendError(res, 415, 'UNSUPPORTED_FILE');

    const against = { contract, reserved: reservedOn(contract.id) };
    if (sub === 'preview') {
      const parsed = parsePreview(file, payload, against);
      return parsed ? send(res, 200, parsed.response) : sendError(res, 415, 'UNSUPPORTED_FILE');
    }
    if (sub === undefined && method === 'POST') {
      return commitImport(res, projectId, file, payload, against);
    }
  }

  const workOrder = id ? workOrders.get(id) : undefined;
  if (!workOrder || workOrder.projectId !== projectId) return sendError(res, 404, 'NOT_FOUND');

  if (sub === undefined) {
    if (method === 'GET') return send(res, 200, detailOut(workOrder));
    if (method === 'DELETE') {
      workOrders.delete(workOrder.id);
      return send(res, 204);
    }
    if (method === 'PATCH') {
      const body = await readJson(req);
      if (body.expectedVersion !== workOrder.version) return sendError(res, 409, 'CONFLICT');
      if (typeof body.number === 'string' && numberTaken(projectId, body.number, workOrder.id)) {
        return sendError(res, 409, 'CONFLICT');
      }
      for (const field of ['number', 'title', 'issuedOn', 'notes'] as const) {
        if (field in body) (workOrder as any)[field] = body[field];
      }
      workOrder.version += 1;
      workOrder.updatedAt = new Date().toISOString();
      return send(res, 200, detailOut(workOrder));
    }
  }

  if (sub === 'items') return handleItems(req, res, method, workOrder, subId);
  if (sub === 'attachments') return handleAttachments(req, res, method, workOrder, subId, subSub);
  return sendError(res, 404, 'NOT_FOUND');
}

async function handleItems(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  workOrder: WorkOrderRecord,
  itemId: string | undefined,
): Promise<void> {
  const raw = await readJson(req);
  const touch = () => {
    workOrder.version += 1;
    workOrder.updatedAt = new Date().toISOString();
  };

  if (itemId === undefined && method === 'POST') {
    const body = AddWorkOrderItemRequestSchema.safeParse(raw);
    if (!body.success) return sendError(res, 400, 'VALIDATION_FAILED');
    const gate = contractGate(workOrder.projectId);
    if ('reason' in gate) return sendError(res, 409, 'CONFLICT', { reason: gate.reason });
    if (workOrder.items.some((item) => item.contractItemId === body.data.contractItemId)) {
      return sendError(res, 409, 'CONFLICT', { reason: 'CONTRACT_ITEM_REPEATED' });
    }
    if (rejectQuantity(res, gate.contract, body.data.contractItemId, body.data.quantity)) return;
    const line = gate.contract.lines.find((candidate) => candidate.id === body.data.contractItemId);
    if (!line) return sendError(res, 409, 'CONFLICT', { reason: 'NOT_IN_CONTRACT' });
    const lineNo = body.data.lineNo ?? Math.max(0, ...workOrder.items.map((i) => i.lineNo)) + 1;
    const item = itemFromContract(line, lineNo, body.data.quantity);
    workOrder.items.push(item);
    touch();
    return send(res, 201, itemOut(workOrder.id, item));
  }

  const item = workOrder.items.find((candidate) => candidate.id === itemId);
  if (!item) return sendError(res, 404, 'NOT_FOUND');
  if (method === 'PATCH') {
    const body = UpdateWorkOrderItemRequestSchema.safeParse(raw);
    if (!body.success) return sendError(res, 400, 'VALIDATION_FAILED');
    if (item.contractItemId === null) {
      return sendError(res, 409, 'CONFLICT', { reason: 'LEGACY_ITEM' });
    }
    const gate = contractGate(workOrder.projectId);
    if ('reason' in gate) return sendError(res, 409, 'CONFLICT', { reason: gate.reason });
    if (rejectQuantity(res, gate.contract, item.contractItemId, body.data.quantity, workOrder.id)) {
      return;
    }
    item.quantity = body.data.quantity;
    touch();
    return send(res, 200, itemOut(workOrder.id, item));
  }
  if (method === 'DELETE') {
    workOrder.items = workOrder.items.filter((candidate) => candidate.id !== item.id);
    touch();
    return send(res, 204);
  }
  return sendError(res, 404, 'NOT_FOUND');
}

async function handleAttachments(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  workOrder: WorkOrderRecord,
  attachmentId: string | undefined,
  tail: string | undefined,
): Promise<void> {
  if (attachmentId === undefined) {
    if (method === 'GET') {
      return send(
        res,
        200,
        WorkOrderAttachmentListResponseSchema.parse({
          items: workOrder.attachments.map((a) => attachmentOut(workOrder.id, a)),
        }),
      );
    }
    const file = (await readMultipart(req)).find((part) => part.name === 'file');
    if (!file || !file.data.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
      return sendError(res, 415, 'UNSUPPORTED_FILE');
    }
    const attachment: AttachmentRecord = {
      id: randomUUID(),
      kind: 'document',
      fileName: file.filename ?? 'file.pdf',
      contentType: 'application/pdf',
      data: file.data,
      createdAt: new Date().toISOString(),
    };
    workOrder.attachments.push(attachment);
    return send(res, 201, attachmentOut(workOrder.id, attachment));
  }
  const attachment = workOrder.attachments.find((candidate) => candidate.id === attachmentId);
  if (!attachment) return sendError(res, 404, 'NOT_FOUND');
  if (method === 'GET' && tail === 'content') {
    res.writeHead(200, {
      'content-type': attachment.contentType,
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(attachment.fileName)}`,
    });
    return void res.end(attachment.data);
  }
  if (method === 'DELETE') {
    if (attachment.kind === 'import_source') return sendError(res, 409, 'CONFLICT');
    workOrder.attachments = workOrder.attachments.filter((a) => a.id !== attachment.id);
    return send(res, 204);
  }
  return sendError(res, 404, 'NOT_FOUND');
}

function commitImport(
  res: ServerResponse,
  projectId: string,
  file: Part,
  payload: Record<string, any>,
  against: { contract: ContractData; reserved: Map<string, string> },
): void {
  const parsed = parsePreview(
    file,
    { sheetName: payload.sheetName, mapping: payload.mapping },
    against,
  );
  const invalid = (reason: string, extra: Record<string, unknown> = {}) =>
    sendError(res, 422, 'IMPORT_INVALID', {
      reason,
      fileIssues: [],
      rows: [],
      duplicateCodes: [],
      ...extra,
    });
  if (!parsed || parsed.response.file.sha256 !== payload.fileSha256) return invalid('FILE_CHANGED');

  const excluded = new Set<number>(payload.excludedRowNumbers ?? []);
  // Heading rows are skipped by the work-order import (the contract import keeps them).
  const included = parsed.rows.filter((row) => !excluded.has(row.rowNumber) && row.kind === 'item');
  if (included.length === 0) return invalid('NO_ROWS_INCLUDED');
  const withErrors = included.filter(parsed.hasError);
  if (withErrors.length > 0) {
    return invalid('ROW_ERRORS', {
      rows: withErrors.map((row) => ({ rowNumber: row.rowNumber, issues: row.issues })),
    });
  }
  if (numberTaken(projectId, String(payload.workOrder?.number))) {
    return sendError(res, 409, 'CONFLICT');
  }

  const workOrder = newWorkOrder(projectId, payload.workOrder ?? {}, 'import');
  workOrder.items = included.map((row, index) => ({
    id: randomUUID(),
    lineNo: index + 1,
    code: row.code as string,
    description: row.description as string,
    unit: row.unit as string,
    quantity: row.quantity as string,
    unitPrice: row.unitPrice as string,
    workType: row.workType,
    contractItemId: parsed.contractLines.find((line) => line.code === row.code)?.id ?? null,
    source: 'import',
    sourceRow: row.rowNumber,
  }));
  workOrder.attachments.push({
    id: randomUUID(),
    kind: 'import_source',
    fileName: file.filename ?? 'import.xlsx',
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    data: file.data,
    createdAt: new Date().toISOString(),
  });
  workOrders.set(workOrder.id, workOrder);
  send(res, 201, detailOut(workOrder));
}

async function handleCad(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  method: string,
  [id, sub]: (string | undefined)[],
): Promise<void> {
  if (id === undefined) {
    if (method === 'GET') {
      const items = [...cadFiles.values()].reverse().map(cadSummary);
      return send(res, 200, CadFileListResponseSchema.parse({ items }));
    }
    if (method === 'POST') {
      const file = (await readMultipart(req)).find((part) => part.name === 'file');
      const name = file?.filename ?? '';
      if (!file || !/\.(dxf|dwg)$/i.test(name)) return sendError(res, 415, 'UNSUPPORTED_FILE');
      const record: CadRecord = {
        id: randomUUID(),
        originalName: name,
        format: name.toLowerCase().endsWith('.dwg') ? 'dwg' : 'dxf',
        // The size the mock really received: lets a test prove a large upload was not truncated.
        sizeBytes: file.data.length,
        sha256: createHash('sha256').update(file.data).digest('hex'),
        data: file.data.length < 1_000_000 ? file.data : null,
        createdAt: new Date().toISOString(),
        queuedAt: Date.now(),
      };
      cadFiles.set(record.id, record);
      return send(res, 201, CadFileSummarySchema.parse(cadSummary(record)));
    }
  }

  const file = id ? cadFiles.get(id) : undefined;
  if (!file) return sendError(res, 404, 'NOT_FOUND');
  const processed = cadStatus(file) === 'processed';

  if (sub === undefined && method === 'GET') return send(res, 200, cadDetail(file));
  if (sub === 'content') {
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.originalName)}`,
    });
    return void res.end(file.data ?? Buffer.alloc(0));
  }
  if (sub === 'mapping') return handleMapping(req, res, method, mockCad(file), helpers);
  if (sub === 'log')
    return send(res, 200, CadFileLogResponseSchema.parse({ log: 'ezdxf: recovered 0 issues\n' }));
  if (sub === 'reprocess' && method === 'POST') {
    file.queuedAt = Date.now();
    return send(res, 202, CadFileSummarySchema.parse(cadSummary(file)));
  }
  if (sub === 'layers') {
    return send(
      res,
      200,
      CadLayerListResponseSchema.parse({ items: processed ? cadLayers() : [] }),
    );
  }
  if (sub === 'inserts')
    return send(res, 200, CadInsertPageSchema.parse(page(processed ? cadInserts() : [], url)));
  if (sub === 'texts') {
    const unreadableOnly = url.searchParams.get('readable') === 'false';
    const items = cadTexts().filter((text) => !unreadableOnly || !text.readable);
    return send(res, 200, CadTextPageSchema.parse(page(processed ? items : [], url)));
  }
  if (sub === 'curves')
    return send(res, 200, CadCurvePageSchema.parse(page(processed ? cadCurves() : [], url)));
  return sendError(res, 404, 'NOT_FOUND');
}

configureContracts({ readMultipart, readFixture, parsePreview, helpers });

const adminTokens = { accessToken: ADMIN_ACCESS, refreshToken: ADMIN_REFRESH, expiresIn: 900 };
const adminState = createAdminState({
  id: PROJECT_ID,
  name: ME.memberships[0]?.projectName ?? '',
  contractId: seedContractId,
});

createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://mock');
    const route = `${req.method} ${url.pathname}`;
    if (route === 'POST /auth/login') {
      const body = await readJson(req);
      if (body.email === EMAIL && body.password === PASSWORD) return send(res, 200, tokens);
      if (body.email === ADMIN_EMAIL && body.password === PASSWORD) {
        return send(res, 200, adminTokens);
      }
      return sendError(res, 401, 'INVALID_CREDENTIALS');
    }
    if (route === 'POST /auth/refresh') {
      const body = await readJson(req);
      if (body.refreshToken === REFRESH) return send(res, 200, tokens);
      if (body.refreshToken === ADMIN_REFRESH) return send(res, 200, adminTokens);
      return sendError(res, 401, 'TOKEN_INVALID');
    }
    if (route === 'GET /health') return send(res, 200, { ok: true });
    if (route === 'POST /auth/logout') return send(res, 204);

    const isAdmin = req.headers.authorization === `Bearer ${ADMIN_ACCESS}`;
    const authorised = isAdmin || req.headers.authorization === `Bearer ${ACCESS}`;
    if (!authorised) {
      req.resume();
      return sendError(res, 401, 'TOKEN_EXPIRED');
    }
    if (route === 'GET /auth/me') return send(res, 200, isAdmin ? ADMIN_ME : ME);

    const segments = url.pathname.split('/').filter(Boolean);
    if (segments[0] === 'admin') {
      if (!isAdmin) return sendError(res, 403, 'FORBIDDEN');
      return await handleAdmin(req, res, segments, adminState, helpers);
    }
    if (segments[0] === 'projects') return await handleProject(req, res, url, segments);
    return sendError(res, 404, 'NOT_FOUND');
  } catch (error) {
    console.error(error);
    if (!res.headersSent) sendError(res, 500, 'INTERNAL');
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`mock API listening on ${PORT}`);
});
