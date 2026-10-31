import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { ContractImportCommitPayload, ContractItemInput } from '@ftth/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { systemClock, type IdGenerator } from '../../../common/clock.js';
import { InMemoryObjectStorage } from '../../../common/testing/in-memory-object-storage.js';
import { ExcelJsWorkbookReader } from '../../work-orders/infrastructure/exceljs-workbook-reader.js';
import { buildOwnerBoqXlsx } from '../../work-orders/testing/owner-boq-sheet.js';
import { InMemoryContractUnitOfWork } from '../testing/in-memory.js';
import {
  AddContractAttachmentUseCase,
  DeleteContractAttachmentUseCase,
} from './attachment.use-cases.js';
import {
  AddContractItemUseCase,
  ApproveContractUseCase,
  CreateContractUseCase,
  RemoveContractItemUseCase,
  UpdateContractItemUseCase,
  UpdateContractUseCase,
} from './contract.use-cases.js';
import { CommitContractImportUseCase, PreviewContractImportUseCase } from './import.use-cases.js';

const ACTOR = '22222222-2222-4222-8222-222222222222';
const MAPPING: ContractImportCommitPayload['mapping'] = {
  code: 0,
  workType: 1,
  description: 2,
  unit: 3,
  quantity: 4,
  unitPrice: 5,
  amount: 6,
};

let uow: InMemoryContractUnitOfWork;
let storage: InMemoryObjectStorage;
let ids: IdGenerator;
const reader = new ExcelJsWorkbookReader();

beforeEach(() => {
  let n = 0;
  ids = { next: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}` };
  uow = new InMemoryContractUnitOfWork();
  storage = new InMemoryObjectStorage();
});

const create = () => new CreateContractUseCase(uow, systemClock, ids);
const add = () => new AddContractItemUseCase(uow, systemClock, ids);

const item = (code: string, quantity = '2', unitPrice = '10.5'): ContractItemInput => ({
  kind: 'item',
  code,
  description: 'd',
  unit: 'm',
  quantity,
  unitPrice,
  workType: 'civil',
});

async function newContract() {
  return create().execute({
    actorId: ACTOR,
    request: { number: 'C-1', name: 'عقد', client: 'العميل', currency: 'EGP' },
  });
}

describe('contract use cases', () => {
  it('creates a draft with a project-less event', async () => {
    const view = await newContract();
    expect(view.contract.header).toMatchObject({ status: 'draft', version: 1, createdById: ACTOR });
    expect(uow.events.events[0]).toMatchObject({
      type: 'contract.created',
      projectId: null,
      entity: 'contract',
      payload: { number: 'C-1', currency: 'EGP' },
    });
  });

  it('refuses a duplicate number', async () => {
    await newContract();
    await expect(newContract()).rejects.toMatchObject({
      code: 'CONFLICT',
      details: { reason: 'DUPLICATE_NUMBER' },
    });
  });

  it('updates the header with a before/after event and checks the version', async () => {
    const { contract } = await newContract();
    const id = contract.header.id;
    const update = new UpdateContractUseCase(uow);
    const view = await update.execute({
      contractId: id,
      actorId: ACTOR,
      request: { expectedVersion: 1, name: 'اسم جديد', notes: null },
    });
    expect(view.contract.header).toMatchObject({ name: 'اسم جديد', version: 2 });
    expect(uow.events.events.at(-1)).toMatchObject({
      type: 'contract.updated',
      payload: { before: { name: 'عقد' }, after: { name: 'اسم جديد' }, version: 2 },
    });
    await expect(
      update.execute({
        contractId: id,
        actorId: ACTOR,
        request: { expectedVersion: 1, name: 'x' },
      }),
    ).rejects.toMatchObject({ details: { reason: 'STALE_VERSION' } });
    await expect(
      update.execute({
        contractId: ACTOR,
        actorId: ACTOR,
        request: { expectedVersion: 1, name: 'x' },
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('adds, updates and removes lines with events, bumping the version each time', async () => {
    const { contract } = await newContract();
    const id = contract.header.id;
    let view = await add().execute({
      contractId: id,
      actorId: ACTOR,
      request: { item: item('A'), acceptDuplicateCode: false, expectedVersion: 1 },
    });
    expect(view.contract.header.version).toBe(2);
    view = await add().execute({
      contractId: id,
      actorId: ACTOR,
      request: {
        item: { kind: 'heading', code: 'H' },
        acceptDuplicateCode: false,
        expectedVersion: 2,
      },
    });
    expect(view.contract.lines.map((l) => [l.lineNo, l.kind])).toEqual([
      [1, 'item'],
      [2, 'heading'],
    ]);
    expect(view.contract.total.toString()).toBe('21');

    const first = view.contract.lines[0];
    if (!first) throw new Error('no line');
    view = await new UpdateContractItemUseCase(uow, systemClock).execute({
      contractId: id,
      itemId: first.id,
      actorId: ACTOR,
      request: { item: item('A', '3', '1'), acceptDuplicateCode: false, expectedVersion: 3 },
    });
    expect(view.contract.total.toString()).toBe('3');

    view = await new RemoveContractItemUseCase(uow).execute({
      contractId: id,
      itemId: first.id,
      actorId: ACTOR,
      expectedVersion: 4,
    });
    expect(view.contract.lines).toHaveLength(1);
    expect(uow.events.types()).toEqual([
      'contract.created',
      'contract_item.added',
      'contract_item.added',
      'contract_item.updated',
      'contract_item.removed',
    ]);
  });

  it('refuses stale versions and duplicate codes unless accepted', async () => {
    const { contract } = await newContract();
    const id = contract.header.id;
    await add().execute({
      contractId: id,
      actorId: ACTOR,
      request: { item: item('A'), acceptDuplicateCode: false, expectedVersion: 1 },
    });
    await expect(
      add().execute({
        contractId: id,
        actorId: ACTOR,
        request: { item: item('B'), acceptDuplicateCode: false, expectedVersion: 1 },
      }),
    ).rejects.toMatchObject({ details: { reason: 'STALE_VERSION' } });
    await expect(
      add().execute({
        contractId: id,
        actorId: ACTOR,
        request: { item: item('A'), acceptDuplicateCode: false, expectedVersion: 2 },
      }),
    ).rejects.toMatchObject({ details: { reason: 'DUPLICATE_CODE' } });
    const view = await add().execute({
      contractId: id,
      actorId: ACTOR,
      request: { item: item('A'), acceptDuplicateCode: true, expectedVersion: 2 },
    });
    expect(view.contract.duplicateCodes()).toEqual([{ code: 'A', lineNos: [1, 2] }]);
  });

  it('approves with a full BOQ snapshot, then refuses every BOQ change', async () => {
    const { contract } = await newContract();
    const id = contract.header.id;
    const approve = new ApproveContractUseCase(uow, systemClock);
    await expect(
      approve.execute({ contractId: id, actorId: ACTOR, request: { expectedVersion: 1 } }),
    ).rejects.toMatchObject({ details: { reason: 'NO_PRICED_ITEMS' } });

    await add().execute({
      contractId: id,
      actorId: ACTOR,
      request: {
        item: { kind: 'heading', code: 'H', description: 'قسم' },
        acceptDuplicateCode: false,
        expectedVersion: 1,
      },
    });
    await add().execute({
      contractId: id,
      actorId: ACTOR,
      request: { item: item('A', '2', '10.5'), acceptDuplicateCode: false, expectedVersion: 2 },
    });
    await expect(
      approve.execute({ contractId: id, actorId: ACTOR, request: { expectedVersion: 2 } }),
    ).rejects.toMatchObject({ details: { reason: 'STALE_VERSION' } });

    const view = await approve.execute({
      contractId: id,
      actorId: ACTOR,
      request: { expectedVersion: 3 },
    });
    expect(view.contract.header).toMatchObject({
      status: 'approved',
      approvedById: ACTOR,
      version: 4,
    });
    const event = uow.events.events.at(-1);
    expect(event).toMatchObject({
      type: 'contract.approved',
      projectId: null,
      payload: { total: '21', itemCount: 1, headingCount: 1, version: 4 },
    });
    expect((event?.payload as { lines: unknown[] }).lines).toHaveLength(2);

    const locked = { code: 'CONFLICT', details: { reason: 'CONTRACT_APPROVED' } };
    await expect(
      add().execute({
        contractId: id,
        actorId: ACTOR,
        request: { item: item('B'), acceptDuplicateCode: false, expectedVersion: 4 },
      }),
    ).rejects.toMatchObject(locked);
    await expect(
      approve.execute({ contractId: id, actorId: ACTOR, request: { expectedVersion: 4 } }),
    ).rejects.toMatchObject(locked);
    await expect(
      new RemoveContractItemUseCase(uow).execute({
        contractId: id,
        itemId: view.contract.lines[0]?.id ?? '',
        actorId: ACTOR,
        expectedVersion: 4,
      }),
    ).rejects.toMatchObject(locked);
    // The header stays editable.
    const updated = await new UpdateContractUseCase(uow).execute({
      contractId: id,
      actorId: ACTOR,
      request: { expectedVersion: 4, notes: 'ملاحظة' },
    });
    expect(updated.contract.header.notes).toBe('ملاحظة');
  });
});

describe('contract BOQ import', () => {
  const payload = async (
    file: Buffer,
    overrides: Partial<ContractImportCommitPayload> = {},
  ): Promise<ContractImportCommitPayload> => ({
    fileSha256: createHash('sha256').update(file).digest('hex'),
    sheetName: 'BOQ',
    headerRow: 3,
    mapping: MAPPING,
    excludedRowNumbers: [],
    acceptedDuplicateCodes: [],
    expectedVersion: 1,
    ...overrides,
  });
  const commit = () =>
    new CommitContractImportUseCase(reader, uow, uow.contracts, storage, systemClock, ids);

  it('previews a draft contract and refuses an approved one', async () => {
    const { contract } = await newContract();
    const file = await buildOwnerBoqXlsx();
    const preview = new PreviewContractImportUseCase(uow.contracts, reader);
    const result = await preview.execute({
      contractId: contract.header.id,
      file: { fileName: 'boq.xlsx', buffer: file },
      options: {},
    });
    expect(result.summary).toMatchObject({ rowCount: 10, headingCount: 4, total: '1335' });
    await add().execute({
      contractId: contract.header.id,
      actorId: ACTOR,
      request: { item: item('A'), acceptDuplicateCode: false, expectedVersion: 1 },
    });
    await new ApproveContractUseCase(uow, systemClock).execute({
      contractId: contract.header.id,
      actorId: ACTOR,
      request: { expectedVersion: 2 },
    });
    await expect(
      preview.execute({
        contractId: contract.header.id,
        file: { fileName: 'boq.xlsx', buffer: file },
        options: {},
      }),
    ).rejects.toMatchObject({ details: { reason: 'CONTRACT_APPROVED' } });
  });

  it('replaces all lines with items and headings, keeps the source file and writes one event', async () => {
    const { contract } = await newContract();
    const id = contract.header.id;
    await add().execute({
      contractId: id,
      actorId: ACTOR,
      request: { item: item('OLD'), acceptDuplicateCode: false, expectedVersion: 1 },
    });
    const file = await buildOwnerBoqXlsx();

    const view = await commit().execute({
      contractId: id,
      actorId: ACTOR,
      file: { fileName: 'boq.xlsx', buffer: file },
      payload: await payload(file, { expectedVersion: 2 }),
    });

    expect(view.contract.lines.map((l) => l.code)).toEqual([
      '1',
      '1-1',
      '1-2',
      '1-2-1',
      '2',
      '2-9-1',
      '2-9-1-1',
      '2-12',
      '4-2-4',
      '4-2-5',
    ]);
    expect(view.contract.items).toHaveLength(6);
    expect(view.contract.total.toString()).toBe('1335');
    const heading = view.contract.lines.find((l) => l.code === '2-12');
    expect(heading).toMatchObject({ kind: 'heading', description: null, sourceRow: 11 });
    expect(view.contract.lines.every((l) => l.source === 'import')).toBe(true);
    // Units are kept exactly as typed.
    expect(view.contract.lines.at(-1)?.unit).toBe('BULDING\n(1 to 8 unit/flat per building)');

    expect(view.attachments).toHaveLength(1);
    expect(storage.objects.get(view.attachments[0]?.storageKey ?? '')?.equals(file)).toBe(true);
    expect(uow.events.events.at(-1)).toMatchObject({
      type: 'contract.imported',
      projectId: null,
      payload: { itemCount: 6, headingCount: 4, replacedLineCount: 1, total: '1335' },
    });
  });

  it('refuses a stale version, a changed file and error rows without touching anything', async () => {
    const { contract } = await newContract();
    const id = contract.header.id;
    const file = await buildOwnerBoqXlsx();
    await expect(
      commit().execute({
        contractId: id,
        actorId: ACTOR,
        file: { fileName: 'boq.xlsx', buffer: file },
        payload: await payload(file, { expectedVersion: 5 }),
      }),
    ).rejects.toMatchObject({ details: { reason: 'STALE_VERSION' } });
    await expect(
      commit().execute({
        contractId: id,
        actorId: ACTOR,
        file: { fileName: 'boq.xlsx', buffer: file },
        payload: await payload(file, { fileSha256: 'a'.repeat(64) }),
      }),
    ).rejects.toMatchObject({ code: 'IMPORT_INVALID', details: { reason: 'FILE_CHANGED' } });
    // A column mapped to two fields
    // is a file issue.
    await expect(
      commit().execute({
        contractId: id,
        actorId: ACTOR,
        file: { fileName: 'boq.xlsx', buffer: file },
        payload: await payload(file, { mapping: { ...MAPPING, unit: 2 } }),
      }),
    ).rejects.toMatchObject({ code: 'IMPORT_INVALID', details: { reason: 'FILE_ISSUES' } });
    expect((await uow.contracts.findById(id))?.lines).toHaveLength(0);
    expect(storage.objects.size).toBe(0);
  });

  it('deletes the stored file when the transaction fails', async () => {
    const { contract } = await newContract();
    const file = await buildOwnerBoqXlsx();
    uow.failOnCommit = new Error('db down');
    await expect(
      commit().execute({
        contractId: contract.header.id,
        actorId: ACTOR,
        file: { fileName: 'boq.xlsx', buffer: file },
        payload: await payload(file),
      }),
    ).rejects.toThrow('db down');
    expect(storage.objects.size).toBe(0);
  });
});

describe('contract attachments', () => {
  const pdf = () => ({
    fileName: 'contract.pdf',
    stream: Readable.from(Buffer.from('%PDF-1.7 x')),
  });

  it('stores a PDF in any status, refuses other files, and protects the import source', async () => {
    const { contract } = await newContract();
    const id = contract.header.id;
    const addPdf = new AddContractAttachmentUseCase(
      uow,
      uow.contracts,
      storage,
      systemClock,
      ids,
      1000,
    );
    const attachment = await addPdf.execute({ contractId: id, actorId: ACTOR, file: pdf() });
    expect(attachment).toMatchObject({ kind: 'document', contentType: 'application/pdf' });
    expect(storage.objects.has(attachment.storageKey)).toBe(true);
    expect(uow.events.types().at(-1)).toBe('contract_attachment.added');

    await expect(
      addPdf.execute({
        contractId: id,
        actorId: ACTOR,
        file: { fileName: 'a.pdf', stream: Readable.from(Buffer.from('not a pdf at all')) },
      }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_FILE' });
    await expect(
      addPdf.execute({ contractId: ACTOR, actorId: ACTOR, file: pdf() }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const remove = new DeleteContractAttachmentUseCase(uow, storage);
    await remove.execute({ contractId: id, attachmentId: attachment.id, actorId: ACTOR });
    expect(storage.objects.size).toBe(0);
    expect(uow.events.types().at(-1)).toBe('contract_attachment.removed');

    await uow.attachments.insert({
      ...attachment,
      id: 'src',
      kind: 'import_source',
      storageKey: 'contracts/x/src.xlsx',
    });
    await expect(
      remove.execute({ contractId: id, attachmentId: 'src', actorId: ACTOR }),
    ).rejects.toMatchObject({ details: { reason: 'IMPORT_SOURCE_PROTECTED' } });
  });
});
