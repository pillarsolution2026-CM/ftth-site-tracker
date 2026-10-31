import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { CreateWorkOrderRequest, WorkOrderImportCommitPayload } from '@ftth/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { systemClock, type IdGenerator } from '../../../common/clock.js';
import { InMemoryObjectStorage } from '../../../common/testing/in-memory-object-storage.js';
import type { ApprovedContract } from '../domain/contract-lines.js';
import { WorkOrder } from '../domain/work-order.js';
import { ExcelJsWorkbookReader } from '../infrastructure/exceljs-workbook-reader.js';
import { approvedContractFromSheet, itemIdOfRow } from '../testing/approved-contract.js';
import { fixedCurrency, InMemoryWorkOrderUnitOfWork } from '../testing/in-memory.js';
import {
  buildWorkOrderSheet,
  ITEM_ROWS,
  setCell,
  workOrderSheetRows,
} from '../testing/work-order-contract-sheets.js';
import { AddAttachmentUseCase, DeleteAttachmentUseCase } from './attachment.use-cases.js';
import { CreateWorkOrderUseCase } from './create-work-order.use-case.js';
import { DeleteWorkOrderUseCase } from './delete-work-order.use-case.js';
import { CommitImportUseCase, PreviewWorkOrderImportUseCase } from './import.use-cases.js';
import { UpdateWorkOrderUseCase } from './update-work-order.use-case.js';
import {
  AddWorkOrderItemUseCase,
  RemoveWorkOrderItemUseCase,
  UpdateWorkOrderItemUseCase,
} from './work-order-item.use-cases.js';
import { ListContractItemAvailabilityUseCase } from './work-order-queries.js';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const OTHER_PROJECT = '99999999-9999-4999-8999-999999999999';
const ACTOR = '22222222-2222-4222-8222-222222222222';
/** The owner's layout: code, work type, description, unit, quantity, unit price, amount. */
const MAPPING: WorkOrderImportCommitPayload['mapping'] = {
  code: 0,
  workType: 1,
  description: 2,
  unit: 3,
  quantity: 4,
  unitPrice: 5,
  amount: 6,
};

const TRENCH = itemIdOfRow(ITEM_ROWS.trench); // contract 300, price 12.5
const CHAMBER = itemIdOfRow(ITEM_ROWS.chamber); // contract 30, price 8000
const CABLE = itemIdOfRow(ITEM_ROWS.cable); // contract 15, price 2

let contract: ApprovedContract;
let uow: InMemoryWorkOrderUnitOfWork;
let storage: InMemoryObjectStorage;
let ids: IdGenerator;
let create: CreateWorkOrderUseCase;
let add: AddWorkOrderItemUseCase;
let update: UpdateWorkOrderItemUseCase;
let commit: CommitImportUseCase;
const reader = new ExcelJsWorkbookReader();

beforeEach(async () => {
  let n = 0;
  ids = { next: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}` };
  contract = await approvedContractFromSheet();
  uow = new InMemoryWorkOrderUnitOfWork(contract);
  storage = new InMemoryObjectStorage();
  create = new CreateWorkOrderUseCase(uow, fixedCurrency('EGP'), systemClock, ids);
  add = new AddWorkOrderItemUseCase(uow, systemClock, ids);
  update = new UpdateWorkOrderItemUseCase(uow, systemClock);
  commit = new CommitImportUseCase(
    reader,
    uow,
    uow.contracts,
    uow.orders,
    fixedCurrency('EGP'),
    storage,
    systemClock,
    ids,
  );
});

const request = (overrides: Partial<CreateWorkOrderRequest> = {}): CreateWorkOrderRequest => ({
  number: 'WO-1',
  lines: [
    { contractItemId: TRENCH, quantity: '2' },
    { contractItemId: CHAMBER, quantity: '1' },
  ],
  ...overrides,
});

const createIn = (
  projectId: string,
  overrides: Partial<CreateWorkOrderRequest> = {},
  currency = create,
) => currency.execute({ projectId, actorId: ACTOR, request: request(overrides) });

describe('work order use cases', () => {
  it('creates from contract lines with the project currency, a total, and one event', async () => {
    const { order } = await createIn(PROJECT);
    expect(order.header).toMatchObject({
      currency: 'EGP',
      version: 1,
      source: 'manual',
      createdById: ACTOR,
    });
    // 2 × 12.5 + 1 × 8000
    expect(order.total.toString()).toBe('8025');
    expect(order.items.map((i) => [i.code, i.contractItemId])).toEqual([
      ['1-1', TRENCH],
      ['1-2-1', CHAMBER],
    ]);
    expect(uow.events.types()).toEqual(['work_order.created']);
    expect(uow.events.events[0]?.payload).toMatchObject({
      total: '8025',
      itemCount: 2,
      contractItemIds: [TRENCH, CHAMBER],
    });
    // The contract was locked for the check.
    expect(uow.contracts.lockedLoads).toEqual([PROJECT]);
  });

  it('refuses without a contract, with a draft contract, and a second work order', async () => {
    uow.contracts.state = 'none';
    await expect(createIn(PROJECT)).rejects.toMatchObject({
      details: { reason: 'NO_CONTRACT' },
    });
    uow.contracts.state = 'draft';
    await expect(createIn(PROJECT)).rejects.toMatchObject({
      details: { reason: 'CONTRACT_NOT_APPROVED' },
    });
    uow.contracts.state = 'approved';
    await createIn(PROJECT);
    await expect(createIn(PROJECT, { number: 'WO-2' })).rejects.toMatchObject({
      details: { reason: 'WORK_ORDER_EXISTS' },
    });
  });

  it('refuses a contract item that is not in the contract and a repeated one', async () => {
    await expect(
      createIn(PROJECT, { lines: [{ contractItemId: 'unknown-item', quantity: '1' }] }),
    ).rejects.toMatchObject({ details: { reason: 'NOT_IN_CONTRACT' } });
    await expect(
      createIn(PROJECT, {
        lines: [
          { contractItemId: TRENCH, quantity: '1' },
          { contractItemId: TRENCH, quantity: '1' },
        ],
      }),
    ).rejects.toMatchObject({ details: { reason: 'CONTRACT_ITEM_REPEATED' } });
    expect(uow.orders.orders.size).toBe(0);
  });

  it('refuses a quantity above the contract with every number', async () => {
    await expect(
      createIn(PROJECT, { lines: [{ contractItemId: CABLE, quantity: '15.0001' }] }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      details: {
        reason: 'QUANTITY_EXCEEDS_CONTRACT',
        contractItemId: CABLE,
        code: '2-9-1',
        contractQuantity: '15',
        reservedQuantity: '0',
        requestedQuantity: '15.0001',
        availableQuantity: '15',
      },
    });
    expect(uow.orders.orders.size).toBe(0);
    // Exactly the contract quantity is allowed.
    await createIn(PROJECT, { lines: [{ contractItemId: CABLE, quantity: '15' }] });
  });

  it('reserves across projects of the same contract: the second gets the remainder', async () => {
    await createIn(PROJECT, { lines: [{ contractItemId: TRENCH, quantity: '250.5' }] });
    await expect(
      createIn(OTHER_PROJECT, { lines: [{ contractItemId: TRENCH, quantity: '50' }] }),
    ).rejects.toMatchObject({
      details: {
        reason: 'QUANTITY_EXCEEDS_CONTRACT',
        reservedQuantity: '250.5',
        availableQuantity: '49.5',
      },
    });
    const { order } = await createIn(OTHER_PROJECT, {
      lines: [{ contractItemId: TRENCH, quantity: '49.5' }],
    });
    expect(order.items).toHaveLength(1);
  });

  it('frees the reserved quantity when a line or the work order is deleted', async () => {
    const first = (
      await createIn(PROJECT, { lines: [{ contractItemId: CHAMBER, quantity: '30' }] })
    ).order;
    const second = () =>
      createIn(OTHER_PROJECT, { lines: [{ contractItemId: CHAMBER, quantity: '1' }] });
    await expect(second()).rejects.toMatchObject({
      details: { reason: 'QUANTITY_EXCEEDS_CONTRACT' },
    });
    await new RemoveWorkOrderItemUseCase(uow).execute({
      projectId: PROJECT,
      workOrderId: first.header.id,
      actorId: ACTOR,
      itemId: first.items[0]?.id ?? '',
    });
    await second();

    await new DeleteWorkOrderUseCase(uow, storage).execute({
      projectId: OTHER_PROJECT,
      workOrderId:
        [...uow.orders.orders.values()].find((order) => order.header.projectId === OTHER_PROJECT)
          ?.header.id ?? '',
      actorId: ACTOR,
    });
    expect((await uow.contracts.reservations(contract.id)).size).toBe(0);
  });

  it('refuses a number that is already used in the project', async () => {
    await createIn(PROJECT);
    await expect(createIn(PROJECT)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('updates the header under the optimistic version and logs only what changed', async () => {
    const { order } = await createIn(PROJECT);
    const updateHeader = new UpdateWorkOrderUseCase(uow);
    const view = await updateHeader.execute({
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
      updateHeader.execute({
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
    const { order } = await createIn(PROJECT);
    await expect(
      new UpdateWorkOrderUseCase(uow).execute({
        projectId: OTHER_PROJECT,
        workOrderId: order.header.id,
        actorId: ACTOR,
        request: { title: 'x', expectedVersion: 1 },
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      new DeleteWorkOrderUseCase(uow, storage).execute({
        projectId: OTHER_PROJECT,
        workOrderId: order.header.id,
        actorId: ACTOR,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('adds and removes lines, bumping the version and never compacting line numbers', async () => {
    const { order } = await createIn(PROJECT);
    const item = await add.execute({
      projectId: PROJECT,
      workOrderId: order.header.id,
      actorId: ACTOR,
      request: { contractItemId: CABLE, quantity: '1' },
    });
    expect(item).toMatchObject({ lineNo: 3, code: '2-9-1', contractItemId: CABLE });
    expect(item.unitPrice.toString()).toBe('2');

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
      request: { contractItemId: TRENCH, quantity: '1' },
    });
    expect(next.lineNo).toBe(4);
    expect(uow.orders.orders.get(order.header.id)?.header.version).toBe(4);
    expect(uow.events.types()).toEqual([
      'work_order.created',
      'work_order_item.added',
      'work_order_item.removed',
      'work_order_item.added',
    ]);
    expect(uow.events.events[1]?.payload).toMatchObject({ contractItemId: CABLE });
  });

  it('add line refuses every contract reason', async () => {
    const { order } = await createIn(PROJECT);
    const addTo = (contractItemId: string, quantity: string) =>
      add.execute({
        projectId: PROJECT,
        workOrderId: order.header.id,
        actorId: ACTOR,
        request: { contractItemId, quantity },
      });
    await expect(addTo('unknown-item', '1')).rejects.toMatchObject({
      details: { reason: 'NOT_IN_CONTRACT' },
    });
    await expect(addTo(TRENCH, '1')).rejects.toMatchObject({
      details: { reason: 'CONTRACT_ITEM_REPEATED' },
    });
    await expect(addTo(CABLE, '16')).rejects.toMatchObject({
      details: { reason: 'QUANTITY_EXCEEDS_CONTRACT', availableQuantity: '15' },
    });
    uow.contracts.state = 'draft';
    await expect(addTo(CABLE, '1')).rejects.toMatchObject({
      details: { reason: 'CONTRACT_NOT_APPROVED' },
    });
  });

  it('update changes only the quantity and checks the reservation without the line itself', async () => {
    const { order } = await createIn(PROJECT, {
      lines: [{ contractItemId: CHAMBER, quantity: '10' }],
    });
    // The other project holds 5 of the 30: this line may hold up to 25.
    await createIn(OTHER_PROJECT, { lines: [{ contractItemId: CHAMBER, quantity: '5' }] });
    const line = order.items[0];
    const change = (quantity: string) =>
      update.execute({
        projectId: PROJECT,
        workOrderId: order.header.id,
        actorId: ACTOR,
        itemId: line?.id ?? '',
        request: { quantity },
      });
    const raised = await change('25');
    expect(raised.quantity.toString()).toBe('25');
    expect(raised.unitPrice.toString()).toBe('8000');
    await expect(change('25.0001')).rejects.toMatchObject({
      details: {
        reason: 'QUANTITY_EXCEEDS_CONTRACT',
        reservedQuantity: '5',
        availableQuantity: '25',
      },
    });
    await change('1');
    expect(uow.events.events.at(-1)).toMatchObject({
      type: 'work_order_item.updated',
      payload: { before: { quantity: '25' }, after: { quantity: '1' } },
    });
  });

  it('update refuses a line saved before contract lines (LEGACY_ITEM)', async () => {
    const { order } = await createIn(PROJECT);
    const stored = uow.orders.orders.get(order.header.id);
    if (!stored) throw new Error('missing');
    uow.orders.orders.set(
      order.header.id,
      new WorkOrder(
        stored.header,
        stored.items.map((item) => ({ ...item, contractId: null, contractItemId: null })),
      ),
    );
    await expect(
      update.execute({
        projectId: PROJECT,
        workOrderId: order.header.id,
        actorId: ACTOR,
        itemId: order.items[0]?.id ?? '',
        request: { quantity: '1' },
      }),
    ).rejects.toMatchObject({ details: { reason: 'LEGACY_ITEM' } });
  });

  it('keeps the event snapshot when a work order is deleted and removes its stored files', async () => {
    const { order } = await createIn(PROJECT);
    const attach = new AddAttachmentUseCase(uow, uow.orders, storage, systemClock, ids, 1000);
    const attachment = await attach.execute({
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
      payload: { number: 'WO-1', total: '8025', items: [expect.anything(), expect.anything()] },
    });
  });
});

describe('contract item availability', () => {
  it('lists priced items with contract, reserved and available quantity', async () => {
    const list = new ListContractItemAvailabilityUseCase(uow.contracts, uow.orders);
    await createIn(PROJECT, { lines: [{ contractItemId: CHAMBER, quantity: '12.5' }] });
    await createIn(OTHER_PROJECT, { lines: [{ contractItemId: CHAMBER, quantity: '2' }] });

    const mine = await list.execute(PROJECT);
    expect(mine.contractNumber).toBe('C-1');
    expect(mine.rows.map((row) => row.item.code)).toEqual([
      '1-1',
      '1-2-1',
      '2-9-1',
      '2-9-1-1',
      '4-2-4',
    ]);
    const chamber = mine.rows.find((row) => row.item.id === CHAMBER);
    expect(chamber).toMatchObject({ workOrderItemId: expect.any(String) });
    expect(chamber?.reserved.toString()).toBe('14.5');
    expect(chamber?.available.toString()).toBe('15.5');
    const trench = mine.rows.find((row) => row.item.id === TRENCH);
    expect(trench).toMatchObject({ workOrderItemId: null });
    expect(trench?.available.toString()).toBe('300');

    // The other project sees the same numbers but its own line.
    const theirs = (await list.execute(OTHER_PROJECT)).rows.find((row) => row.item.id === CHAMBER);
    expect(theirs?.reserved.toString()).toBe('14.5');
    expect(theirs?.workOrderItemId).not.toBe(chamber?.workOrderItemId);
  });

  it('refuses without a contract and with a draft contract', async () => {
    const list = new ListContractItemAvailabilityUseCase(uow.contracts, uow.orders);
    uow.contracts.state = 'none';
    await expect(list.execute(PROJECT)).rejects.toMatchObject({
      details: { reason: 'NO_CONTRACT' },
    });
    uow.contracts.state = 'draft';
    await expect(list.execute(PROJECT)).rejects.toMatchObject({
      details: { reason: 'CONTRACT_NOT_APPROVED' },
    });
  });
});

describe('attachments', () => {
  it('accepts only PDF content named .pdf, and protects the imported source', async () => {
    const { order } = await createIn(PROJECT);
    const attach = new AddAttachmentUseCase(uow, uow.orders, storage, systemClock, ids, 1000);
    const send = (fileName: string, content: string) =>
      attach.execute({
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

describe('Excel import against the contract', () => {
  const payload = (
    file: Buffer,
    overrides: Partial<WorkOrderImportCommitPayload> = {},
  ): WorkOrderImportCommitPayload => ({
    fileSha256: createHash('sha256').update(file).digest('hex'),
    sheetName: 'WO',
    headerRow: 3,
    mapping: MAPPING,
    excludedRowNumbers: [],
    acceptedDuplicateCodes: [],
    workOrder: { number: 'IMP-1' },
    ...overrides,
  });
  const run = (
    file: Buffer,
    body: WorkOrderImportCommitPayload,
    projectId = PROJECT,
    name = 'wo.xlsx',
  ) =>
    commit.execute({
      projectId,
      actorId: ACTOR,
      file: { fileName: name, buffer: file },
      payload: body,
    });
  const preview = (file: Buffer, projectId = PROJECT) =>
    new PreviewWorkOrderImportUseCase(reader, uow.contracts, uow.orders).execute({
      projectId,
      file: { fileName: 'wo.xlsx', buffer: file },
      options: {},
    });

  it('previews a clean sheet without writing anything', async () => {
    const file = await buildWorkOrderSheet();
    const result = await preview(file);
    expect(result.file).toEqual({
      name: 'wo.xlsx',
      sizeBytes: file.length,
      sha256: createHash('sha256').update(file).digest('hex'),
    });
    expect(result.summary).toMatchObject({ errorRowCount: 0, headingCount: 3, rowCount: 8 });
    expect(storage.objects.size).toBe(0);
    expect(uow.orders.orders.size).toBe(0);
  });

  it('refuses before reading the file: no contract, draft, existing work order', async () => {
    const file = await buildWorkOrderSheet();
    uow.contracts.state = 'none';
    await expect(preview(file)).rejects.toMatchObject({ details: { reason: 'NO_CONTRACT' } });
    await expect(run(file, payload(file))).rejects.toMatchObject({
      details: { reason: 'NO_CONTRACT' },
    });
    uow.contracts.state = 'draft';
    await expect(preview(file)).rejects.toMatchObject({
      details: { reason: 'CONTRACT_NOT_APPROVED' },
    });
    await expect(run(file, payload(file))).rejects.toMatchObject({
      details: { reason: 'CONTRACT_NOT_APPROVED' },
    });
    uow.contracts.state = 'approved';
    await run(file, payload(file));
    // Not even a non-xlsx body gets as far as parsing.
    await expect(preview(Buffer.from('x'))).rejects.toMatchObject({
      details: { reason: 'WORK_ORDER_EXISTS' },
    });
    await expect(
      run(file, payload(file, { workOrder: { number: 'IMP-2' } })),
    ).rejects.toMatchObject({ details: { reason: 'WORK_ORDER_EXISTS' } });
  });

  it('creates the work order with lines linked to contract items, the xlsx as import_source and one event', async () => {
    const file = await buildWorkOrderSheet();
    const { order, attachments } = await run(file, payload(file));

    expect(order.header).toMatchObject({ source: 'import', number: 'IMP-1', currency: 'EGP' });
    expect(order.items.map((i) => [i.lineNo, i.code, i.source, i.sourceRow])).toEqual([
      [1, '1-1', 'import', 5],
      [2, '1-2-1', 'import', 7],
      [3, '2-9-1', 'import', 9],
      [4, '2-9-1-1', 'import', 10],
      [5, '4-2-4', 'import', 11],
    ]);
    expect(order.items.map((i) => i.contractItemId)).toEqual(
      [5, 7, 9, 10, 11].map((row) => itemIdOfRow(row)),
    );
    // 100×12.5 + 10×8000 + 5×2 + 3×3 + 2×10
    expect(order.total.toString()).toBe('81289');
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({
      kind: 'import_source',
      sha256: payload(file).fileSha256,
    });
    expect(storage.objects.get(attachments[0]?.storageKey ?? '')?.equals(file)).toBe(true);
    expect(uow.events.types()).toEqual(['work_order.imported']);
    expect(uow.events.events[0]?.payload).toMatchObject({ itemCount: 5, total: '81289' });
  });

  it('refuses a different file than the one previewed (FILE_CHANGED)', async () => {
    const file = await buildWorkOrderSheet();
    const other = await buildWorkOrderSheet(
      setCell(workOrderSheetRows(), ITEM_ROWS.cable, 'quantity', 4),
    );
    await expect(run(other, payload(file))).rejects.toMatchObject({
      code: 'IMPORT_INVALID',
      details: { reason: 'FILE_CHANGED' },
    });
    expect(storage.objects.size).toBe(0);
  });

  it('refuses rows that differ from the contract; excluding them lets the commit through', async () => {
    const rows = setCell(workOrderSheetRows(), ITEM_ROWS.chamber, 'unitPrice', 7999);
    const file = await buildWorkOrderSheet(rows);
    await expect(run(file, payload(file))).rejects.toMatchObject({
      code: 'IMPORT_INVALID',
      details: {
        reason: 'ROW_ERRORS',
        rows: [
          {
            rowNumber: ITEM_ROWS.chamber,
            issues: [{ code: 'CONTRACT_MISMATCH', field: 'unitPrice' }],
          },
        ],
      },
    });
    expect(storage.objects.size).toBe(0);
    const { order } = await run(file, payload(file, { excludedRowNumbers: [ITEM_ROWS.chamber] }));
    expect(order.items).toHaveLength(4);
  });

  it('ignores acceptedDuplicateCodes: a repeated code is an error unless a row is excluded', async () => {
    const rows = setCell(workOrderSheetRows(), ITEM_ROWS.joint, 'code', '2-9-1');
    const file = await buildWorkOrderSheet(rows);
    await expect(
      run(file, payload(file, { acceptedDuplicateCodes: ['2-9-1'] })),
    ).rejects.toMatchObject({ details: { reason: 'ROW_ERRORS' } });
    // Dropping the second row leaves one use of the code: no repeat any more.
    const { order } = await run(file, payload(file, { excludedRowNumbers: [ITEM_ROWS.joint] }));
    expect(order.items.map((i) => i.code)).toEqual(['1-1', '1-2-1', '2-9-1', '4-2-4']);
  });

  it('refuses a quantity above what other work orders left', async () => {
    await createIn(OTHER_PROJECT, { lines: [{ contractItemId: TRENCH, quantity: '250' }] });
    const file = await buildWorkOrderSheet();
    await expect(run(file, payload(file))).rejects.toMatchObject({
      details: {
        reason: 'ROW_ERRORS',
        rows: [{ rowNumber: ITEM_ROWS.trench, issues: [{ code: 'QUANTITY_EXCEEDS_CONTRACT' }] }],
      },
    });
  });

  it('deletes the stored object when the transaction fails', async () => {
    const file = await buildWorkOrderSheet();
    uow.failOnCommit = new Error('boom');
    await expect(run(file, payload(file))).rejects.toThrow('boom');
    expect(storage.objects.size).toBe(0);
  });

  it('refuses non-xlsx uploads', async () => {
    const file = await buildWorkOrderSheet();
    await expect(run(file, payload(file), PROJECT, 'wo.xls')).rejects.toMatchObject({
      code: 'UNSUPPORTED_FILE',
    });
    await expect(run(file, payload(file), PROJECT, 'wo.csv')).rejects.toMatchObject({
      code: 'UNSUPPORTED_FILE',
    });
    await expect(
      run(Buffer.from('a,b,c\n1,2,3'), payload(file), PROJECT, 'wo.xlsx'),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_FILE' });
  });
});
