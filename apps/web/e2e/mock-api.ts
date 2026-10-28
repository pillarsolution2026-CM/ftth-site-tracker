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
  WorkTypeSchema,
  type WorkType,
  WorkOrderAttachmentListResponseSchema,
  WorkOrderAttachmentSchema,
  WorkOrderDetailSchema,
  WorkOrderImportPreviewResponseSchema,
  WorkOrderItemSchema,
  WorkOrderListResponseSchema,
} from '@ftth/shared';
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

// ---------- exact decimals (mock only) ----------

interface Dec {
  int: bigint;
  scale: number;
}

function parseDec(text: string): Dec {
  const [whole = '0', fraction = ''] = text.split('.');
  return { int: BigInt(whole + fraction), scale: fraction.length };
}

function formatDec(value: Dec): string {
  const negative = value.int < 0n;
  const digits = (negative ? -value.int : value.int).toString().padStart(value.scale + 1, '0');
  const whole = digits.slice(0, digits.length - value.scale);
  const fraction = digits.slice(digits.length - value.scale).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

function mulDec(a: string, b: string): string {
  const x = parseDec(a);
  const y = parseDec(b);
  return formatDec({ int: x.int * y.int, scale: x.scale + y.scale });
}

function sumDec(values: string[]): string {
  const parsed = values.map(parseDec);
  const scale = parsed.reduce((max, v) => Math.max(max, v.scale), 0);
  const total = parsed.reduce((sum, v) => sum + v.int * 10n ** BigInt(scale - v.scale), 0n);
  return formatDec({ int: total, scale });
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
    projectId: PROJECT_ID,
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
  header: Record<string, unknown>,
  source: 'manual' | 'import',
): WorkOrderRecord {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
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

function numberTaken(number: string, exceptId?: string): boolean {
  return [...workOrders.values()].some((w) => w.number === number && w.id !== exceptId);
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

function parsePreview(file: Part, options: { sheetName?: string; mapping?: Mapping }) {
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
  const duplicateCodes = [...byCode.entries()]
    .filter(([, rowNumbers]) => rowNumbers.length > 1)
    .map(([code, rowNumbers]) => ({ code, rowNumbers }));
  for (const duplicate of duplicateCodes) {
    for (const row of rows) {
      if (row.code !== duplicate.code) continue;
      row.issues.push({
        code: 'DUPLICATE_CODE',
        severity: 'warning',
        field: 'code',
        params: { otherRows: duplicate.rowNumbers.filter((n) => n !== row.rowNumber).join(', ') },
      });
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
  if (projectId !== PROJECT_ID) return sendError(res, 404, 'NOT_FOUND');
  const method = req.method ?? 'GET';

  if (resource === 'work-orders')
    return handleWorkOrders(req, res, method, [id, sub, subId, subSub]);
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
  [id, sub, subId, subSub]: (string | undefined)[],
): Promise<void> {
  if (id === undefined) {
    if (method === 'GET') {
      const items = [...workOrders.values()]
        .sort((a, b) => a.number.localeCompare(b.number))
        .map(summaryOut);
      return send(res, 200, WorkOrderListResponseSchema.parse({ items }));
    }
    if (method === 'POST') {
      const body = await readJson(req);
      if (typeof body.number !== 'string' || body.number.trim() === '') {
        return sendError(res, 400, 'VALIDATION_FAILED');
      }
      if (numberTaken(body.number)) return sendError(res, 409, 'CONFLICT');
      const workOrder = newWorkOrder(body, 'manual');
      workOrders.set(workOrder.id, workOrder);
      return send(res, 201, detailOut(workOrder));
    }
  }

  if (id === 'import') {
    const parts = await readMultipart(req);
    const file = parts.find((part) => part.name === 'file');
    const payload = JSON.parse(
      parts.find((part) => part.name === 'payload')?.data.toString('utf8') ?? '{}',
    ) as Record<string, any>;
    if (!file || !readFixture(file.data)) return sendError(res, 415, 'UNSUPPORTED_FILE');

    if (sub === 'preview') {
      const parsed = parsePreview(file, payload);
      return parsed ? send(res, 200, parsed.response) : sendError(res, 415, 'UNSUPPORTED_FILE');
    }
    if (sub === undefined && method === 'POST') return commitImport(res, file, payload);
  }

  const workOrder = id ? workOrders.get(id) : undefined;
  if (!workOrder) return sendError(res, 404, 'NOT_FOUND');

  if (sub === undefined) {
    if (method === 'GET') return send(res, 200, detailOut(workOrder));
    if (method === 'DELETE') {
      workOrders.delete(workOrder.id);
      return send(res, 204);
    }
    if (method === 'PATCH') {
      const body = await readJson(req);
      if (body.expectedVersion !== workOrder.version) return sendError(res, 409, 'CONFLICT');
      if (typeof body.number === 'string' && numberTaken(body.number, workOrder.id)) {
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
  const body = await readJson(req);
  const touch = () => {
    workOrder.version += 1;
    workOrder.updatedAt = new Date().toISOString();
  };
  const duplicate = (code: string, exceptId?: string) =>
    workOrder.items.some((item) => item.code === code && item.id !== exceptId);

  if (itemId === undefined && method === 'POST') {
    const code = String(body.code ?? '');
    if (duplicate(code) && body.acceptDuplicateCode !== true)
      return sendError(res, 409, 'CONFLICT');
    const item: ItemRecord = {
      id: randomUUID(),
      lineNo: Math.max(0, ...workOrder.items.map((i) => i.lineNo)) + 1,
      code,
      description: String(body.description),
      unit: String(body.unit),
      quantity: String(body.quantity),
      unitPrice: String(body.unitPrice),
      workType: WorkTypeSchema.parse(body.workType),
      source: 'manual',
      sourceRow: null,
    };
    workOrder.items.push(item);
    touch();
    return send(res, 201, itemOut(workOrder.id, item));
  }

  const item = workOrder.items.find((candidate) => candidate.id === itemId);
  if (!item) return sendError(res, 404, 'NOT_FOUND');
  if (method === 'PATCH') {
    if (
      typeof body.code === 'string' &&
      duplicate(body.code, item.id) &&
      body.acceptDuplicateCode !== true
    ) {
      return sendError(res, 409, 'CONFLICT');
    }
    for (const field of ['code', 'description', 'unit', 'quantity', 'unitPrice'] as const) {
      if (typeof body[field] === 'string') item[field] = body[field];
    }
    if (body.workType !== undefined) item.workType = WorkTypeSchema.parse(body.workType);
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

function commitImport(res: ServerResponse, file: Part, payload: Record<string, any>): void {
  const parsed = parsePreview(file, { sheetName: payload.sheetName, mapping: payload.mapping });
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
  const accepted = new Set<string>(payload.acceptedDuplicateCodes ?? []);
  const included = parsed.rows.filter((row) => !excluded.has(row.rowNumber));
  if (included.length === 0) return invalid('NO_ROWS_INCLUDED');
  const withErrors = included.filter(parsed.hasError);
  if (withErrors.length > 0) {
    return invalid('ROW_ERRORS', {
      rows: withErrors.map((row) => ({ rowNumber: row.rowNumber, issues: row.issues })),
    });
  }
  const counts = new Map<string, number>();
  for (const row of included)
    counts.set(row.code as string, (counts.get(row.code as string) ?? 0) + 1);
  const unresolved = [...counts.entries()]
    .filter(([code, n]) => n > 1 && !accepted.has(code))
    .map(([code]) => code);
  if (unresolved.length > 0)
    return invalid('UNRESOLVED_DUPLICATES', { duplicateCodes: unresolved });
  if (numberTaken(String(payload.workOrder?.number))) return sendError(res, 409, 'CONFLICT');

  const workOrder = newWorkOrder(payload.workOrder ?? {}, 'import');
  workOrder.items = included.map((row, index) => ({
    id: randomUUID(),
    lineNo: index + 1,
    code: row.code as string,
    description: row.description as string,
    unit: row.unit as string,
    quantity: row.quantity as string,
    unitPrice: row.unitPrice as string,
    workType: row.workType,
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

createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://mock');
    const route = `${req.method} ${url.pathname}`;
    if (route === 'POST /auth/login') {
      const body = await readJson(req);
      if (body.email === EMAIL && body.password === PASSWORD) return send(res, 200, tokens);
      return sendError(res, 401, 'INVALID_CREDENTIALS');
    }
    if (route === 'POST /auth/refresh') {
      const body = await readJson(req);
      if (body.refreshToken === REFRESH) return send(res, 200, tokens);
      return sendError(res, 401, 'TOKEN_INVALID');
    }
    if (route === 'GET /health') return send(res, 200, { ok: true });
    if (route === 'POST /auth/logout') return send(res, 204);

    const authorised = req.headers.authorization === `Bearer ${ACCESS}`;
    if (!authorised) {
      req.resume();
      return sendError(res, 401, 'TOKEN_EXPIRED');
    }
    if (route === 'GET /auth/me') return send(res, 200, ME);

    const segments = url.pathname.split('/').filter(Boolean);
    if (segments[0] === 'projects') return await handleProject(req, res, url, segments);
    return sendError(res, 404, 'NOT_FOUND');
  } catch (error) {
    console.error(error);
    if (!res.headersSent) sendError(res, 500, 'INTERNAL');
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`mock API listening on ${PORT}`);
});
