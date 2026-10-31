/* eslint-disable @typescript-eslint/no-explicit-any -- the mock reads loosely typed request JSON */
/**
 * Contract and BOQ routes of the mock API (`/admin/contracts/...` and `GET /projects/:id/contract`),
 * ADR-027. In-memory; bodies are validated and answers parsed with the shared schemas. Rules follow
 * docs/phase-2-contracts.md: approval is final and locks the BOQ, 409 carries `details.reason`,
 * the import replaces every line (headings become heading lines). Erasable TypeScript only.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  AddContractItemRequestSchema,
  ApproveContractRequestSchema,
  ContractAttachmentSchema,
  ContractDetailSchema,
  ContractListResponseSchema,
  CreateContractRequestSchema,
  UpdateContractItemRequestSchema,
  UpdateContractRequestSchema,
  parentCodeOf,
  type WorkType,
} from '@ftth/shared';
import type { Helpers } from './mock-design.ts';
import { mulDec, sumDec } from './mock-decimal.ts';

interface Part {
  name: string;
  filename: string | null;
  data: Buffer;
}

interface Deps {
  readMultipart: (req: IncomingMessage) => Promise<Part[]>;
  readFixture: (data: Buffer) => unknown;
  parsePreview: (file: Part, options: any) => any;
  helpers: Helpers;
}

let configured: Deps | null = null;
export function configureContracts(value: Deps): void {
  configured = value;
}

function deps(): Deps {
  if (!configured) throw new Error('configureContracts() was not called');
  return configured;
}

interface LineRecord {
  id: string;
  lineNo: number;
  kind: 'item' | 'heading';
  code: string;
  description: string | null;
  unit: string | null;
  quantity: string | null;
  unitPrice: string | null;
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

interface ContractRecord {
  id: string;
  number: string;
  name: string;
  client: string;
  currency: string;
  startsOn: string | null;
  durationDays: number | null;
  notes: string | null;
  status: 'draft' | 'approved';
  approvedAt: string | null;
  version: number;
  items: LineRecord[];
  attachments: AttachmentRecord[];
  createdAt: string;
  updatedAt: string;
}

const NOW = '2026-10-31T08:00:00.000Z';
const ADMIN_ID = '7d1f6a8e-3c4b-4f2a-9e1d-5b6c7a8d9e0f';

/** An approved contract the seeded project belongs to (the PM reads it). */
export const seedContractId = '5a1c9f2e-6b3d-4e8a-9c7f-2d4b6a8c0e1f';

const contracts = new Map<string, ContractRecord>();
const projectCounts = new Map<string, number>([[seedContractId, 1]]);

function line(
  lineNo: number,
  code: string,
  fields: Partial<LineRecord> & { kind: 'item' | 'heading' },
): LineRecord {
  return {
    id: randomUUID(),
    lineNo,
    code,
    description: null,
    unit: null,
    quantity: null,
    unitPrice: null,
    workType: null,
    source: 'import',
    sourceRow: lineNo + 1,
    ...fields,
  };
}

contracts.set(seedContractId, {
  id: seedContractId,
  number: 'C-SEED',
  name: 'عقد الشبكة',
  client: 'Client',
  currency: 'EGP',
  startsOn: '2026-01-01',
  durationDays: 365,
  notes: null,
  status: 'approved',
  approvedAt: NOW,
  version: 3,
  items: [
    line(1, '1', { kind: 'heading', description: 'أعمال مدنية' }),
    line(2, '1-1', {
      kind: 'item',
      description: 'حفر خندق',
      unit: 'م',
      quantity: '100',
      unitPrice: '12.5',
      workType: 'civil',
    }),
    line(3, '1-1-1', {
      kind: 'item',
      description: 'ردم',
      unit: 'م',
      quantity: '40',
      unitPrice: '3',
      workType: 'civil',
    }),
  ],
  attachments: [],
  createdAt: NOW,
  updatedAt: NOW,
});

/** A contract still in draft that a second seeded project belongs to ("approve it first"). */
export const seedDraftContractId = '6b2d0a3f-7c4e-4f9b-8d0a-3e5c7b9d1f20';

contracts.set(seedDraftContractId, {
  id: seedDraftContractId,
  number: 'C-DRAFT',
  name: 'عقد مسودة',
  client: 'Client',
  currency: 'EGP',
  startsOn: null,
  durationDays: null,
  notes: null,
  status: 'draft',
  approvedAt: null,
  version: 1,
  items: [
    line(1, 'D-1', {
      kind: 'item',
      description: 'بند مسودة',
      unit: 'م',
      quantity: '10',
      unitPrice: '1',
      workType: 'civil',
    }),
  ],
  attachments: [],
  createdAt: NOW,
  updatedAt: NOW,
});

/** What the work-order mock needs of a contract: status and its priced lines. */
export function contractView(contractId: string) {
  const contract = contracts.get(contractId);
  if (!contract) return undefined;
  return {
    id: contract.id,
    number: contract.number,
    status: contract.status,
    lines: contract.items.flatMap((item) =>
      item.kind === 'item' &&
      item.quantity !== null &&
      item.unitPrice !== null &&
      item.description !== null &&
      item.unit !== null &&
      item.workType !== null
        ? [
            {
              id: item.id,
              lineNo: item.lineNo,
              code: item.code,
              description: item.description,
              unit: item.unit,
              quantity: item.quantity,
              unitPrice: item.unitPrice,
              workType: item.workType,
            },
          ]
        : [],
    ),
  };
}

/** Client and currency a project copies from its contract; undefined for an unknown contract. */
export function contractTerms(
  contractId: string,
): { client: string; currency: string } | undefined {
  const contract = contracts.get(contractId);
  return contract ? { client: contract.client, currency: contract.currency } : undefined;
}

export function countProject(contractId: string): void {
  projectCounts.set(contractId, (projectCounts.get(contractId) ?? 0) + 1);
}

// ---------- output ----------

function itemsOut(contract: ContractRecord) {
  const codes = new Set(contract.items.map((item) => item.code));
  return contract.items.map((item) => ({
    id: item.id,
    contractId: contract.id,
    lineNo: item.lineNo,
    kind: item.kind,
    code: item.code,
    description: item.description,
    parentCode: parentCodeOf(item.code, codes),
    unit: item.unit,
    quantity: item.quantity,
    unitPrice: item.unitPrice,
    amount:
      item.kind === 'item' && item.quantity !== null && item.unitPrice !== null
        ? mulDec(item.quantity, item.unitPrice)
        : null,
    workType: item.workType,
    source: item.source,
    sourceRow: item.sourceRow,
  }));
}

function attachmentOut(contractId: string, attachment: AttachmentRecord) {
  return ContractAttachmentSchema.parse({
    id: attachment.id,
    contractId,
    kind: attachment.kind,
    fileName: attachment.fileName,
    contentType: attachment.contentType,
    sizeBytes: Math.max(1, attachment.data.length),
    sha256: createHash('sha256').update(attachment.data).digest('hex'),
    uploadedById: ADMIN_ID,
    createdAt: attachment.createdAt,
  });
}

function summaryOf(contract: ContractRecord) {
  const priced = contract.items.filter((item) => item.kind === 'item');
  return {
    id: contract.id,
    number: contract.number,
    name: contract.name,
    client: contract.client,
    currency: contract.currency,
    startsOn: contract.startsOn,
    durationDays: contract.durationDays,
    status: contract.status,
    approvedAt: contract.approvedAt,
    itemCount: priced.length,
    total: sumDec(
      priced.map((item) => mulDec(item.quantity ?? '0', item.unitPrice ?? '0')).concat('0'),
    ),
    projectCount: projectCounts.get(contract.id) ?? 0,
    version: contract.version,
    createdAt: contract.createdAt,
    updatedAt: contract.updatedAt,
  };
}

function detailOut(contract: ContractRecord) {
  const lines = new Map<string, number[]>();
  for (const item of contract.items)
    lines.set(item.code, [...(lines.get(item.code) ?? []), item.lineNo]);
  return ContractDetailSchema.parse({
    ...summaryOf(contract),
    notes: contract.notes,
    approvedById: contract.status === 'approved' ? ADMIN_ID : null,
    items: itemsOut(contract),
    attachments: contract.attachments.map((a) => attachmentOut(contract.id, a)),
    duplicateCodes: [...lines.entries()]
      .filter(([, lineNos]) => lineNos.length > 1)
      .map(([code, lineNos]) => ({ code, lineNos })),
  });
}

const touch = (contract: ContractRecord) => {
  contract.version += 1;
  contract.updatedAt = new Date().toISOString();
};

const numberTaken = (number: string, exceptId?: string) =>
  [...contracts.values()].some((c) => c.number === number && c.id !== exceptId);

/** `GET /projects/:projectId/contract`. */
export function handleProjectContract(
  res: ServerResponse,
  method: string,
  contractId: string | null,
): void {
  const { send, sendError } = deps().helpers;
  const contract = contractId ? contracts.get(contractId) : undefined;
  if (method !== 'GET') return sendError(res, 404, 'NOT_FOUND');
  if (!contract) return sendError(res, 404, 'NOT_FOUND');
  return send(res, 200, detailOut(contract));
}

function lineFromInput(input: any, lineNo: number, accepted: boolean): LineRecord {
  void accepted;
  return input.kind === 'heading'
    ? line(lineNo, input.code, {
        kind: 'heading',
        description: input.description ? input.description : null,
        source: 'manual',
        sourceRow: null,
      })
    : line(lineNo, input.code, {
        kind: 'item',
        description: input.description,
        unit: input.unit,
        quantity: input.quantity,
        unitPrice: input.unitPrice,
        workType: input.workType,
        source: 'manual',
        sourceRow: null,
      });
}

/** `/admin/contracts/...`; `segments` = ['admin', 'contracts', id, sub, subId, tail]. */
export async function handleContracts(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  segments: string[],
): Promise<void> {
  const { send, sendError, readJson } = deps().helpers;
  const method = req.method ?? 'GET';
  const [, , id, sub, subId, tail] = segments;
  const invalid = () => sendError(res, 400, 'VALIDATION_FAILED');
  const conflict = (reason: string) => sendError(res, 409, 'CONFLICT', { reason });

  if (id === undefined) {
    if (method === 'GET') {
      const items = [...contracts.values()].map(summaryOf);
      return send(res, 200, ContractListResponseSchema.parse({ items }));
    }
    if (method === 'POST') {
      const body = CreateContractRequestSchema.safeParse(await readJson(req));
      if (!body.success) return invalid();
      if (numberTaken(body.data.number)) return conflict('DUPLICATE_NUMBER');
      const now = new Date().toISOString();
      const contract: ContractRecord = {
        id: randomUUID(),
        number: body.data.number,
        name: body.data.name,
        client: body.data.client,
        currency: body.data.currency,
        startsOn: body.data.startsOn ?? null,
        durationDays: body.data.durationDays ?? null,
        notes: body.data.notes ?? null,
        status: 'draft',
        approvedAt: null,
        version: 1,
        items: [],
        attachments: [],
        createdAt: now,
        updatedAt: now,
      };
      contracts.set(contract.id, contract);
      return send(res, 201, detailOut(contract));
    }
  }

  const contract = id ? contracts.get(id) : undefined;
  if (!contract) return sendError(res, 404, 'NOT_FOUND');

  if (sub === undefined && method === 'GET') return send(res, 200, detailOut(contract));
  if (sub === undefined && method === 'PATCH') {
    const body = UpdateContractRequestSchema.safeParse(await readJson(req));
    if (!body.success) return invalid();
    if (body.data.expectedVersion !== contract.version) return conflict('STALE_VERSION');
    if (body.data.number !== undefined && numberTaken(body.data.number, contract.id)) {
      return conflict('DUPLICATE_NUMBER');
    }
    const { expectedVersion: _ignored, ...fields } = body.data;
    void _ignored;
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) (contract as any)[key] = value;
    }
    touch(contract);
    return send(res, 200, detailOut(contract));
  }

  if (sub === 'approve' && method === 'POST') {
    const body = ApproveContractRequestSchema.safeParse(await readJson(req));
    if (!body.success) return invalid();
    if (contract.status === 'approved') return conflict('CONTRACT_APPROVED');
    if (body.data.expectedVersion !== contract.version) return conflict('STALE_VERSION');
    if (!contract.items.some((item) => item.kind === 'item')) return conflict('NO_PRICED_ITEMS');
    contract.status = 'approved';
    contract.approvedAt = new Date().toISOString();
    touch(contract);
    return send(res, 200, detailOut(contract));
  }

  if (sub === 'items') return handleItems(req, res, url, contract, subId, deps().helpers);
  if (sub === 'import') return handleImport(req, res, method, contract, subId);
  if (sub === 'attachments') return handleAttachments(req, res, method, contract, subId, tail);
  return sendError(res, 404, 'NOT_FOUND');
}

async function handleItems(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  contract: ContractRecord,
  itemId: string | undefined,
  { send, sendError, readJson }: Helpers,
): Promise<void> {
  const method = req.method ?? 'GET';
  const conflict = (reason: string) => sendError(res, 409, 'CONFLICT', { reason });
  const invalid = () => sendError(res, 400, 'VALIDATION_FAILED');
  const duplicate = (code: string, exceptId?: string) =>
    contract.items.some((item) => item.code === code && item.id !== exceptId);

  if (itemId === undefined && method === 'POST') {
    const body = AddContractItemRequestSchema.safeParse(await readJson(req));
    if (!body.success) return invalid();
    if (contract.status === 'approved') return conflict('CONTRACT_APPROVED');
    if (body.data.expectedVersion !== contract.version) return conflict('STALE_VERSION');
    if (duplicate(body.data.item.code) && !body.data.acceptDuplicateCode) {
      return conflict('DUPLICATE_CODE');
    }
    const lineNo = body.data.lineNo ?? Math.max(0, ...contract.items.map((i) => i.lineNo)) + 1;
    if (contract.items.some((item) => item.lineNo === lineNo)) return conflict('LINE_TAKEN');
    contract.items.push(lineFromInput(body.data.item, lineNo, body.data.acceptDuplicateCode));
    contract.items.sort((a, b) => a.lineNo - b.lineNo);
    touch(contract);
    return send(res, 201, detailOut(contract));
  }

  const item = contract.items.find((candidate) => candidate.id === itemId);
  if (!item) return sendError(res, 404, 'NOT_FOUND');

  if (method === 'PATCH') {
    const body = UpdateContractItemRequestSchema.safeParse(await readJson(req));
    if (!body.success) return invalid();
    if (contract.status === 'approved') return conflict('CONTRACT_APPROVED');
    if (body.data.expectedVersion !== contract.version) return conflict('STALE_VERSION');
    if (
      duplicate(body.data.item.code, item.id) &&
      !body.data.acceptDuplicateCode &&
      body.data.item.code !== item.code
    ) {
      return conflict('DUPLICATE_CODE');
    }
    const next = lineFromInput(body.data.item, item.lineNo, body.data.acceptDuplicateCode);
    Object.assign(item, { ...next, id: item.id, source: item.source, sourceRow: item.sourceRow });
    touch(contract);
    return send(res, 200, detailOut(contract));
  }
  if (method === 'DELETE') {
    if (contract.status === 'approved') return conflict('CONTRACT_APPROVED');
    if (Number(url.searchParams.get('expectedVersion')) !== contract.version) {
      return conflict('STALE_VERSION');
    }
    contract.items = contract.items.filter((candidate) => candidate.id !== item.id);
    touch(contract);
    return send(res, 200, detailOut(contract));
  }
  return sendError(res, 404, 'NOT_FOUND');
}

async function handleImport(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  contract: ContractRecord,
  sub: string | undefined,
): Promise<void> {
  const { send, sendError } = deps().helpers;
  const parts = await deps().readMultipart(req);
  const file = parts.find((part) => part.name === 'file');
  const payload = JSON.parse(
    parts.find((part) => part.name === 'payload')?.data.toString('utf8') ?? '{}',
  ) as Record<string, any>;
  if (!file || !deps().readFixture(file.data)) return sendError(res, 415, 'UNSUPPORTED_FILE');

  if (sub === 'preview' && method === 'POST') {
    const parsed = deps().parsePreview(file, payload);
    return parsed ? send(res, 200, parsed.response) : sendError(res, 415, 'UNSUPPORTED_FILE');
  }
  if (sub !== undefined || method !== 'POST') return sendError(res, 404, 'NOT_FOUND');

  const conflict = (reason: string) => sendError(res, 409, 'CONFLICT', { reason });
  if (contract.status === 'approved') return conflict('CONTRACT_APPROVED');
  if (payload.expectedVersion !== contract.version) return conflict('STALE_VERSION');
  const invalid = (reason: string, extra: Record<string, unknown> = {}) =>
    sendError(res, 422, 'IMPORT_INVALID', {
      reason,
      fileIssues: [],
      rows: [],
      duplicateCodes: [],
      ...extra,
    });
  const parsed = deps().parsePreview(file, {
    sheetName: payload.sheetName,
    mapping: payload.mapping,
  });
  if (!parsed || parsed.response.file.sha256 !== payload.fileSha256) return invalid('FILE_CHANGED');

  const excluded = new Set<number>(payload.excludedRowNumbers ?? []);
  const accepted = new Set<string>(payload.acceptedDuplicateCodes ?? []);
  const included = parsed.rows.filter((row: any) => !excluded.has(row.rowNumber));
  if (included.length === 0) return invalid('NO_ROWS_INCLUDED');
  const withErrors = included.filter(parsed.hasError);
  if (withErrors.length > 0) {
    return invalid('ROW_ERRORS', {
      rows: withErrors.map((row: any) => ({ rowNumber: row.rowNumber, issues: row.issues })),
    });
  }
  const counts = new Map<string, number>();
  for (const row of included) counts.set(row.code, (counts.get(row.code) ?? 0) + 1);
  const unresolved = [...counts.entries()]
    .filter(([code, n]) => n > 1 && !accepted.has(code))
    .map(([code]) => code);
  if (unresolved.length > 0)
    return invalid('UNRESOLVED_DUPLICATES', { duplicateCodes: unresolved });

  contract.items = included.map((row: any, index: number) =>
    row.kind === 'heading'
      ? line(index + 1, row.code, {
          kind: 'heading',
          description: row.description,
          sourceRow: row.rowNumber,
        })
      : line(index + 1, row.code, {
          kind: 'item',
          description: row.description,
          unit: row.unit,
          quantity: row.quantity,
          unitPrice: row.unitPrice,
          workType: row.workType,
          sourceRow: row.rowNumber,
        }),
  );
  contract.attachments = contract.attachments.filter((a) => a.kind !== 'import_source');
  contract.attachments.push({
    id: randomUUID(),
    kind: 'import_source',
    fileName: file.filename ?? 'boq.xlsx',
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    data: file.data,
    createdAt: new Date().toISOString(),
  });
  touch(contract);
  return send(res, 200, detailOut(contract));
}

async function handleAttachments(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  contract: ContractRecord,
  attachmentId: string | undefined,
  _tail: string | undefined,
): Promise<void> {
  const { send, sendError } = deps().helpers;
  void _tail;
  if (attachmentId === undefined) {
    if (method !== 'POST') return sendError(res, 404, 'NOT_FOUND');
    const file = (await deps().readMultipart(req)).find((part) => part.name === 'file');
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
    contract.attachments.push(attachment);
    return send(res, 201, attachmentOut(contract.id, attachment));
  }
  const attachment = contract.attachments.find((candidate) => candidate.id === attachmentId);
  if (!attachment) return sendError(res, 404, 'NOT_FOUND');
  if (method === 'GET') {
    res.writeHead(200, {
      'content-type': attachment.contentType,
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(attachment.fileName)}`,
    });
    return void res.end(attachment.data);
  }
  if (method === 'DELETE') {
    if (attachment.kind === 'import_source') {
      return sendError(res, 409, 'CONFLICT', { reason: 'IMPORT_SOURCE' });
    }
    contract.attachments = contract.attachments.filter((a) => a.id !== attachment.id);
    return send(res, 204);
  }
  return sendError(res, 404, 'NOT_FOUND');
}
