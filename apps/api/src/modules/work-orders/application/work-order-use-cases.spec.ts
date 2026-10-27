import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { CreateWorkOrderRequest, WorkOrderImportCommitPayload } from '@ftth/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { systemClock, type IdGenerator } from '../../../common/clock.js';
import { InMemoryObjectStorage } from '../../../common/testing/in-memory-object-storage.js';
import { ExcelJsWorkbookReader } from '../infrastructure/exceljs-workbook-reader.js';
import { fixedCurrency, InMemoryWorkOrderUnitOfWork } from '../testing/in-memory.js';
import { buildXlsx, ENGLISH_HEADER } from '../testing/xlsx-builder.js';
import { AddAttachmentUseCase, DeleteAttachmentUseCase } from './attachment.use-cases.js';
import { CreateWorkOrderUseCase } from './create-work-order.use-case.js';
import { DeleteWorkOrderUseCase } from './delete-work-order.use-case.js';
import { CommitImportUseCase, PreviewImportUseCase } from './import.use-cases.js';
import { UpdateWorkOrderUseCase } from './update-work-order.use-case.js';
import {
  AddWorkOrderItemUseCase,
  RemoveWorkOrderItemUseCase,
} from './work-order-item.use-cases.js';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const ACTOR = '22222222-2222-4222-8222-222222222222';
const MAPPING: WorkOrderImportCommitPayload['mapping'] = {
  code: 0,
  description: 1,
  unit: 2,
  quantity: 3,
  unitPrice: 4,
  amount: null,
};

let uow: InMemoryWorkOrderUnitOfWork;
let storage: InMemoryObjectStorage;
let ids: IdGenerator;
let create: CreateWorkOrderUseCase;
let commit: CommitImportUseCase;
const reader = new ExcelJsWorkbookReader();

beforeEach(() => {
  let n = 0;
  ids = { next: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}` };
  uow = new InMemoryWorkOrderUnitOfWork();
  storage = new InMemoryObjectStorage();
  create = new CreateWorkOrderUseCase(uow, fixedCurrency('EGP'), systemClock, ids);
  commit = new CommitImportUseCase(reader, uow, fixedCurrency('EGP'), storage, systemClock, ids);
});

const request = (overrides: Partial<CreateWorkOrderRequest> = {}): CreateWorkOrderRequest => ({
  number: 'WO-1',
  items: [
    { code: 'A', description: 'd', unit: 'm', quantity: '2', unitPrice: '10.5' },
    { code: 'B', description: 'd', unit: 'm', quantity: '1', unitPrice: '0.25' },
  ],
  acceptedDuplicateCodes: [],
  ...overrides,
});

describe('work order use cases', () => {
  it('creates with the project currency, a total, and one event', async () => {
    const { order } = await create.execute({
      projectId: PROJECT,
      actorId: ACTOR,
      request: request(),
    });
    expect(order.header).toMatchObject({
      currency: 'EGP',
      version: 1,
      source: 'manual',
      createdById: ACTOR,
    });
    expect(order.total.toString()).toBe('21.25');
    expect(uow.events.types()).toEqual(['work_order.created']);
    expect(uow.events.events[0]?.payload).toMatchObject({ total: '21.25', itemCount: 2 });
  });

  it('refuses a number that is already used in the project', async () => {
    await create.execute({ projectId: PROJECT, actorId: ACTOR, request: request() });
    await expect(
      create.execute({ projectId: PROJECT, actorId: ACTOR, request: request() }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('updates the header under the optimistic version and logs only what changed', async () => {
    const { order } = await create.execute({
      projectId: PROJECT,
      actorId: ACTOR,
      request: request(),
    });
    const update = new UpdateWorkOrderUseCase(uow);
    const view = await update.execute({
      projectId: PROJECT,
      workOrderId: order.header.id,
      actorId: ACTOR,
      request: { title: 'Phase 1', number: 'WO-1', expectedVersion: 1 },
    });
    expect(view.order.header).toMatchObject({ title: 'Phase 1', version: 2 });
    expect(uow.events.events.at(-1)).toMatchObject({
      type: 'work_order.updated',
      payload: { before: { title: null }, after: { title: 'Phase 1' }, version: 2 },
    });

    await expect(
      update.execute({
        projectId: PROJECT,
        workOrderId: order.header.id,
        actorId: ACTOR,
        request: { title: 'stale', expectedVersion: 1 },
      }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      details: { reason: 'VERSION_MISMATCH', currentVersion: 2 },
    });
  });

  it('does not touch a work order of another project', async () => {
    const { order } = await create.execute({
      projectId: PROJECT,
      actorId: ACTOR,
      request: request(),
    });
    const other = '99999999-9999-4999-8999-999999999999';
    await expect(
      new UpdateWorkOrderUseCase(uow).execute({
        projectId: other,
        workOrderId: order.header.id,
        actorId: ACTOR,
        request: { title: 'x', expectedVersion: 1 },
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      new DeleteWorkOrderUseCase(uow, storage).execute({
        projectId: other,
        workOrderId: order.header.id,
        actorId: ACTOR,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('adds and removes items, bumping the version and never compacting line numbers', async () => {
    const { order } = await create.execute({
      projectId: PROJECT,
      actorId: ACTOR,
      request: request(),
    });
    const add = new AddWorkOrderItemUseCase(uow, systemClock, ids);
    const item = await add.execute({
      projectId: PROJECT,
      workOrderId: order.header.id,
      actorId: ACTOR,
      request: {
        code: 'C',
        description: 'd',
        unit: 'u',
        quantity: '1',
        unitPrice: '1',
        acceptDuplicateCode: false,
      },
    });
    expect(item.lineNo).toBe(3);

    await new RemoveWorkOrderItemUseCase(uow).execute({
      projectId: PROJECT,
      workOrderId: order.header.id,
      actorId: ACTOR,
      itemId: order.items[0]?.id ?? '',
    });
    const next = await add.execute({
      projectId: PROJECT,
      workOrderId: order.header.id,
      actorId: ACTOR,
      request: {
        code: 'D',
        description: 'd',
        unit: 'u',
        quantity: '1',
        unitPrice: '1',
        acceptDuplicateCode: false,
      },
    });
    expect(next.lineNo).toBe(4);
    expect(uow.orders.orders.get(order.header.id)?.header.version).toBe(4);
    expect(uow.events.types()).toEqual([
      'work_order.created',
      'work_order_item.added',
      'work_order_item.removed',
      'work_order_item.added',
    ]);
  });

  it('keeps the event snapshot when a work order is deleted and removes its stored files', async () => {
    const { order } = await create.execute({
      projectId: PROJECT,
      actorId: ACTOR,
      request: request(),
    });
    const add = new AddAttachmentUseCase(uow, uow.orders, storage, systemClock, ids, 1000);
    const attachment = await add.execute({
      projectId: PROJECT,
      workOrderId: order.header.id,
      actorId: ACTOR,
      file: { fileName: 'scope.pdf', stream: Readable.from([Buffer.from('%PDF-1.7 body')]) },
    });
    expect(storage.objects.has(attachment.storageKey)).toBe(true);

    await new DeleteWorkOrderUseCase(uow, storage).execute({
      projectId: PROJECT,
      workOrderId: order.header.id,
      actorId: ACTOR,
    });
    expect(uow.orders.orders.size).toBe(0);
    expect(storage.objects.size).toBe(0);
    expect(uow.events.events.at(-1)).toMatchObject({
      type: 'work_order.deleted',
      payload: { number: 'WO-1', total: '21.25', items: [expect.anything(), expect.anything()] },
    });
  });
});

describe('attachments', () => {
  it('accepts only PDF content named .pdf, and protects the imported source', async () => {
    const { order } = await create.execute({
      projectId: PROJECT,
      actorId: ACTOR,
      request: request(),
    });
    const add = new AddAttachmentUseCase(uow, uow.orders, storage, systemClock, ids, 1000);
    const send = (fileName: string, content: string) =>
      add.execute({
        projectId: PROJECT,
        workOrderId: order.header.id,
        actorId: ACTOR,
        file: { fileName, stream: Readable.from([Buffer.from(content)]) },
      });

    await expect(send('a.pdf', 'not a pdf')).rejects.toMatchObject({ code: 'UNSUPPORTED_FILE' });
    await expect(send('a.txt', '%PDF-1.4')).rejects.toMatchObject({ code: 'UNSUPPORTED_FILE' });
    await expect(send('a.pdf', '%PDF-1.4' + 'x'.repeat(2000))).rejects.toMatchObject({
      code: 'FILE_TOO_LARGE',
    });
    expect(storage.objects.size).toBe(0);

    const pdf = await send('عقد.pdf', '%PDF-1.4 ok');
    expect(pdf).toMatchObject({
      kind: 'document',
      contentType: 'application/pdf',
      fileName: 'عقد.pdf',
    });

    uow.attachments.rows.push({
      ...pdf,
      id: 'imp',
      kind: 'import_source',
      storageKey: 'projects/x/y',
    });
    await expect(
      new DeleteAttachmentUseCase(uow, storage).execute({
        projectId: PROJECT,
        workOrderId: order.header.id,
        attachmentId: 'imp',
        actorId: ACTOR,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await new DeleteAttachmentUseCase(uow, storage).execute({
      projectId: PROJECT,
      workOrderId: order.header.id,
      attachmentId: pdf.id,
      actorId: ACTOR,
    });
    expect(storage.objects.size).toBe(0);
  });
});

describe('Excel import', () => {
  const sheet = (rows: unknown[][]) =>
    buildXlsx([{ name: 'S', rows: [ENGLISH_HEADER.slice(0, 5), ...rows] as never }]);
  const payload = (
    file: Buffer,
    overrides: Partial<WorkOrderImportCommitPayload> = {},
  ): WorkOrderImportCommitPayload => ({
    fileSha256: createHash('sha256').update(file).digest('hex'),
    sheetName: 'S',
    headerRow: 1,
    mapping: MAPPING,
    excludedRowNumbers: [],
    acceptedDuplicateCodes: [],
    workOrder: { number: 'IMP-1' },
    ...overrides,
  });
  const run = (file: Buffer, body: WorkOrderImportCommitPayload, name = 'boq.xlsx') =>
    commit.execute({
      projectId: PROJECT,
      actorId: ACTOR,
      file: { fileName: name, buffer: file },
      payload: body,
    });

  it('previews without writing anything', async () => {
    const file = await sheet([['A', 'd', 'm', 2, 3]]);
    const preview = await new PreviewImportUseCase(reader).execute({
      file: { fileName: 'boq.xlsx', buffer: file },
      options: {},
    });
    expect(preview.file).toEqual({
      name: 'boq.xlsx',
      sizeBytes: file.length,
      sha256: createHash('sha256').update(file).digest('hex'),
    });
    expect(preview.summary.total).toBe('6');
    expect(storage.objects.size).toBe(0);
    expect(uow.orders.orders.size).toBe(0);
  });

  it('creates one work order with sheet-ordered lines, the xlsx as import_source and one event', async () => {
    const file = await sheet([['A', 'd', 'm', 2, 3], [], ['B', 'e', 'm', '١٫٥', 4]]);
    const { order, attachments } = await run(file, payload(file));

    expect(order.header).toMatchObject({ source: 'import', number: 'IMP-1', currency: 'EGP' });
    expect(order.items.map((i) => [i.lineNo, i.code, i.source, i.sourceRow])).toEqual([
      [1, 'A', 'import', 2],
      [2, 'B', 'import', 4],
    ]);
    expect(order.total.toString()).toBe('12');
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({
      kind: 'import_source',
      sha256: payload(file).fileSha256,
    });
    expect(storage.objects.get(attachments[0]?.storageKey ?? '')?.equals(file)).toBe(true);
    expect(uow.events.types()).toEqual(['work_order.imported']);
    expect(uow.events.events[0]?.payload).toMatchObject({
      itemCount: 2,
      total: '12',
      fileSha256: payload(file).fileSha256,
    });
  });

  it('refuses a different file than the one previewed (FILE_CHANGED)', async () => {
    const file = await sheet([['A', 'd', 'm', 2, 3]]);
    const other = await sheet([['A', 'd', 'm', 2, 4]]);
    await expect(run(other, payload(file))).rejects.toMatchObject({
      code: 'IMPORT_INVALID',
      details: { reason: 'FILE_CHANGED' },
    });
    expect(storage.objects.size).toBe(0);
  });

  it('walks the duplicate-code flow: refused, then accepted explicitly', async () => {
    const file = await sheet([
      ['A', 'd', 'm', 2, 3],
      ['A', 'e', 'm', 1, 3],
    ]);
    await expect(run(file, payload(file))).rejects.toMatchObject({
      code: 'IMPORT_INVALID',
      details: { reason: 'UNRESOLVED_DUPLICATES', duplicateCodes: ['A'] },
    });
    const { order } = await run(file, payload(file, { acceptedDuplicateCodes: ['A'] }));
    expect(order.duplicateCodes()).toEqual([{ code: 'A', lineNos: [1, 2] }]);
  });

  it('refuses rows with errors and lists them; excluding them lets the commit through', async () => {
    const file = await sheet([
      ['A', 'd', 'm', 2, 3],
      ['B', 'd', 'm', 'oops', 3],
    ]);
    await expect(run(file, payload(file))).rejects.toMatchObject({
      details: { reason: 'ROW_ERRORS', rows: [{ rowNumber: 3 }] },
    });
    const { order } = await run(file, payload(file, { excludedRowNumbers: [3] }));
    expect(order.items).toHaveLength(1);
  });

  it('deletes the stored object when the transaction fails (number taken)', async () => {
    const file = await sheet([['A', 'd', 'm', 2, 3]]);
    await run(file, payload(file));
    const objectsBefore = storage.objects.size;
    await expect(run(file, payload(file))).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(storage.objects.size).toBe(objectsBefore);
  });

  it('refuses non-xlsx uploads', async () => {
    const file = await sheet([['A', 'd', 'm', 2, 3]]);
    await expect(run(file, payload(file), 'boq.xls')).rejects.toMatchObject({
      code: 'UNSUPPORTED_FILE',
    });
    await expect(run(file, payload(file), 'boq.csv')).rejects.toMatchObject({
      code: 'UNSUPPORTED_FILE',
    });
    await expect(run(Buffer.from('a,b,c\n1,2,3'), payload(file), 'boq.xlsx')).rejects.toMatchObject(
      {
        code: 'UNSUPPORTED_FILE',
      },
    );
  });
});
