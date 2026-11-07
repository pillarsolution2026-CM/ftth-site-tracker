/* Test file: an index into a result that was just asserted to have that many rows. */
/* eslint-disable @typescript-eslint/no-non-null-assertion */
import type {
  ContractorImportTarget,
  ContractorImportPreviewResponse,
  ImportRowIssueCode,
} from '@ftth/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../../../common/app-error.js';
import { systemClock, type IdGenerator } from '../../../common/clock.js';
import { InMemoryObjectStorage } from '../../../common/testing/in-memory-object-storage.js';
import { Decimal } from '../../work-orders/domain/decimal.js';
import { ExcelJsWorkbookReader } from '../../work-orders/infrastructure/exceljs-workbook-reader.js';
import { buildXlsx, type SheetCell } from '../../work-orders/testing/xlsx-builder.js';
import type { WorkOrderLine } from '../domain/contractor.js';
import { InMemoryContractorUnitOfWork } from '../testing/in-memory.js';
import { GetProjectContractorsUseCase, viewOf } from './contractor-queries.js';
import { CreateContractorUseCase, UpdateContractorUseCase } from './contractor.use-cases.js';
import {
  CommitContractorImportUseCase,
  PreviewContractorImportUseCase,
} from './import.use-cases.js';
import {
  AddContractorPriceUseCase,
  RemoveContractorLineUseCase,
  RemoveRegistrationUseCase,
  UpdateContractorLineUseCase,
} from './registration.use-cases.js';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const OTHER_PROJECT = '99999999-9999-4999-8999-999999999999';
const NO_ORDER_PROJECT = '88888888-8888-4888-8888-888888888888';
const ACTOR = '22222222-2222-4222-8222-222222222222';
const ORDER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_ORDER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const BOX = '30000000-0000-4000-8000-000000000001';
const TRENCH = '30000000-0000-4000-8000-000000000002';
const LEGACY = '30000000-0000-4000-8000-000000000003';
const ELSEWHERE = '30000000-0000-4000-8000-000000000004';

const SCOPE_A = 'تركيب الخوصة';
const SCOPE_B = 'تركيب البوكس';
const SCOPE_C = 'لحام البوكس';

const line = (
  id: string,
  lineNo: number,
  code: string,
  overrides: Partial<WorkOrderLine> = {},
): WorkOrderLine => ({
  id,
  lineNo,
  code,
  description: `Item ${code}`,
  unit: 'm',
  workType: 'civil',
  unitPrice: Decimal.parse('12.5'),
  quantity: Decimal.parse('100'),
  contractItemId: `cccccccc-cccc-4ccc-8ccc-00000000000${lineNo}`,
  ...overrides,
});

const HEADER = ['البند', 'الوصف', 'الوحدة', 'نطاق الشغل', 'الكمية', 'السعر'];
/** code, scope, quantity, price; description and unit follow the work-order line. */
type SheetRow = [code: string, scope: string | null, quantity: SheetCell, price: SheetCell];
const DESCRIPTIONS: Record<string, [string, string]> = {
  '2-12-4-8': ['بوكس توزيع', 'عدد'],
  '1-1': ['حفر', 'م.ط'],
  OLD: ['قديم', 'm'],
};

let uow: InMemoryContractorUnitOfWork;
let storage: InMemoryObjectStorage;
let ids: IdGenerator;
let projects: { execute: (projectId: string) => Promise<{ currency: string }> };
let create: CreateContractorUseCase;
let update: UpdateContractorUseCase;
let preview: PreviewContractorImportUseCase;
let commit: CommitContractorImportUseCase;
let removeRegistration: RemoveRegistrationUseCase;
let updateLine: UpdateContractorLineUseCase;
let removeLine: RemoveContractorLineUseCase;
let addPrice: AddContractorPriceUseCase;

const person = (name: string) => ({
  name,
  contactName: 'Hassan',
  contactPhone: '+20 100 000 0000',
});
const newContractor = async (name: string) =>
  (await create.execute({ actorId: ACTOR, request: person(name) })).id;

beforeEach(() => {
  let n = 0;
  ids = { next: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}` };
  uow = new InMemoryContractorUnitOfWork();
  storage = new InMemoryObjectStorage();
  uow.registrations.workOrders.set(PROJECT, ORDER);
  uow.registrations.workOrders.set(OTHER_PROJECT, OTHER_ORDER);
  uow.registrations.lines.set(ORDER, [
    line(BOX, 1, '2-12-4-8', {
      description: 'بوكس توزيع',
      unit: 'عدد',
      quantity: Decimal.parse('225'),
      unitPrice: Decimal.parse('2033.12'),
    }),
    line(TRENCH, 2, '1-1', { description: 'حفر', unit: 'م.ط' }),
    line(LEGACY, 3, 'OLD', { description: 'قديم', contractItemId: null }),
  ]);
  uow.registrations.lines.set(OTHER_ORDER, [line(ELSEWHERE, 1, '1-1')]);
  projects = {
    execute: async (projectId) => {
      if ([PROJECT, OTHER_PROJECT, NO_ORDER_PROJECT].includes(projectId))
        return { currency: 'EGP' };
      throw new AppError('NOT_FOUND', 'Project not found');
    },
  };
  const reader = new ExcelJsWorkbookReader();
  create = new CreateContractorUseCase(uow, systemClock, ids);
  update = new UpdateContractorUseCase(uow);
  preview = new PreviewContractorImportUseCase(
    projects as never,
    uow.registrations,
    uow.contractors,
    reader,
  );
  commit = new CommitContractorImportUseCase(
    projects as never,
    reader,
    uow,
    uow.registrations,
    uow.contractors,
    storage,
    ids,
  );
  removeRegistration = new RemoveRegistrationUseCase(projects as never, uow);
  updateLine = new UpdateContractorLineUseCase(projects as never, uow);
  removeLine = new RemoveContractorLineUseCase(projects as never, uow);
  addPrice = new AddContractorPriceUseCase(projects as never, uow, ids);
});

const sheet = async (rows: SheetRow[]) =>
  buildXlsx([
    {
      name: 'Sheet1',
      rows: [
        HEADER,
        ...rows.map(([code, scope, quantity, price]) => {
          const [description, unit] = DESCRIPTIONS[code] ?? [`Item ${code}`, 'm'];
          return [code, description, unit, scope, quantity, price];
        }),
      ],
    },
  ]);

const newTarget = (contractorId: string, registeredOn = '2026-11-01'): ContractorImportTarget => ({
  kind: 'new',
  contractorId,
  registeredOn,
});

const previewOf = (
  rows: SheetRow[],
  target: ContractorImportTarget,
  projectId = PROJECT,
): Promise<ContractorImportPreviewResponse> =>
  sheet(rows).then((buffer) =>
    preview.execute({
      projectId,
      file: { fileName: 'contractor.xlsx', buffer },
      options: { target },
    }),
  );

/** Previews the sheet, then commits it with the mapping the preview suggested. */
async function upload(
  rows: SheetRow[],
  target: ContractorImportTarget,
  options: { projectId?: string; excluded?: number[] } = {},
) {
  const projectId = options.projectId ?? PROJECT;
  const buffer = await sheet(rows);
  const file = { fileName: 'contractor.xlsx', buffer };
  const shown = await preview.execute({ projectId, file, options: { target } });
  return commit.execute({
    projectId,
    actorId: ACTOR,
    file,
    payload: {
      fileSha256: shown.file.sha256,
      sheetName: shown.sheetName,
      headerRow: shown.headerRow ?? 1,
      mapping: {
        code: shown.suggestedMapping.code ?? 0,
        description: shown.suggestedMapping.description ?? 1,
        unit: shown.suggestedMapping.unit ?? 2,
        quantity: shown.suggestedMapping.quantity ?? 4,
        unitPrice: shown.suggestedMapping.unitPrice ?? 5,
        scope: shown.suggestedMapping.scope,
        workType: null,
        amount: null,
      },
      excludedRowNumbers: options.excluded ?? [],
      target,
    },
  });
}

const issueCodes = (response: ContractorImportPreviewResponse, index: number) =>
  response.rows[index]?.issues.map((issue) => issue.code) ?? [];

const conflict = async (promise: Promise<unknown>) => {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(AppError);
  const appError = error as AppError;
  expect(appError.code).toBe('CONFLICT');
  return appError.details as Record<string, unknown>;
};
const notFound = async (promise: Promise<unknown>) => {
  await expect(promise).rejects.toMatchObject({ code: 'NOT_FOUND' });
};
const rowErrors = async (promise: Promise<unknown>) => {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toMatchObject({ code: 'IMPORT_INVALID', details: { reason: 'ROW_ERRORS' } });
  return (
    (error as AppError).details as {
      rows: { rowNumber: number; issues: { code: ImportRowIssueCode; params?: object }[] }[];
    }
  ).rows;
};

describe('contractor list', () => {
  it('creates a contractor, writes an event without a project, and refuses a taken name', async () => {
    const created = await create.execute({
      actorId: ACTOR,
      request: { ...person('Gamma'), commercialRegister: 'CR-1', taxCard: null },
    });
    expect(created).toMatchObject({ name: 'Gamma', version: 1, workOrderCount: 0 });
    expect(uow.events.events[0]).toMatchObject({
      projectId: null,
      entity: 'contractor',
      type: 'contractor.created',
    });
    const details = await conflict(create.execute({ actorId: ACTOR, request: person('  gamma ') }));
    expect(details.reason).toBe('CONTRACTOR_NAME_TAKEN');
  });

  it('updates under the expected version and records before/after', async () => {
    const id = await newContractor('Alpha');
    const updated = await update.execute({
      contractorId: id,
      actorId: ACTOR,
      request: { expectedVersion: 1, contactName: 'Mona', taxCard: 'TC-9' },
    });
    expect(updated).toMatchObject({ contactName: 'Mona', taxCard: 'TC-9', version: 2 });
    expect(uow.events.events.at(-1)).toMatchObject({
      type: 'contractor.updated',
      payload: { before: { contactName: 'Hassan', taxCard: null }, version: 2 },
    });
    const details = await conflict(
      update.execute({
        contractorId: id,
        actorId: ACTOR,
        request: { expectedVersion: 1, contactName: 'X' },
      }),
    );
    expect(details).toMatchObject({ reason: 'STALE_VERSION', currentVersion: 2 });
    await newContractor('Beta');
    const taken = await conflict(
      update.execute({
        contractorId: id,
        actorId: ACTOR,
        request: { expectedVersion: 2, name: 'beta' },
      }),
    );
    expect(taken.reason).toBe('CONTRACTOR_NAME_TAKEN');
    await notFound(
      update.execute({
        contractorId: ids.next(),
        actorId: ACTOR,
        request: { expectedVersion: 1, name: 'Zed' },
      }),
    );
  });
});

describe('uploading a contractor sheet (new registration)', () => {
  it('registers with scoped lines, first prices on the registration date, the stored file and one event', async () => {
    const contractorId = await newContractor('Alpha');
    const view = await upload(
      [
        ['2-12-4-8', 'تركيب الخوصة ', 225, 300],
        ['2-12-4-8', SCOPE_B, 100, 900],
        ['1-1', null, 40, 10],
      ],
      newTarget(contractorId, '2026-11-03'),
    );
    const registration = view.registrations[0]!;
    expect(registration).toMatchObject({
      registeredOn: '2026-11-03',
      contractor: { name: 'Alpha' },
    });
    expect(
      registration.lines.map((l) => [
        l.item.code,
        l.scope,
        l.scopeKey,
        l.quantity.toString(),
        l.sourceRow,
      ]),
    ).toEqual([
      ['2-12-4-8', SCOPE_A, 'تركيب الخوصه', '225', 2],
      ['2-12-4-8', SCOPE_B, 'تركيب البوكس', '100', 3],
      ['1-1', null, null, '40', 4],
    ]);
    expect(
      registration.lines.map((l) => [
        l.prices[0]!.effectiveFrom,
        l.prices[0]!.unitPrice.toString(),
      ]),
    ).toEqual([
      ['2026-11-03', '300'],
      ['2026-11-03', '900'],
      ['2026-11-03', '10'],
    ]);
    expect(registration.files).toHaveLength(1);
    expect(storage.objects.has(registration.files[0]!.storageKey)).toBe(true);

    expect(uow.events.types()).toEqual([
      'contractor.created',
      'contractor_registration.registered',
    ]);
    expect(uow.events.events.at(-1)).toMatchObject({
      projectId: PROJECT,
      payload: {
        contractorName: 'Alpha',
        fileSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        sheetName: 'Sheet1',
        rowCount: 3,
        lineCount: 3,
        excludedRowCount: 0,
      },
    });
    expect(uow.registrations.locked).toContain(PROJECT);

    const box = view.availability.find((row) => row.item.id === BOX)!;
    expect(box.mode).toBe('scoped');
    expect(
      box.scopes.map((s) => [
        s.scope,
        s.reserved.toString(),
        s.available.toString(),
        s.highestPrice.toString(),
      ]),
    ).toEqual([
      [SCOPE_A, '225', '0', '300'],
      [SCOPE_B, '100', '125', '900'],
    ]);
    expect(box.scopesPriceTotal.toString()).toBe('1200');
    expect(box.priceRoom.toString()).toBe('833.12');
    expect(view.availability.find((row) => row.item.id === TRENCH)!.mode).toBe('whole');
    expect(view.availability.find((row) => row.item.id === LEGACY)!.mode).toBe('free');
  });

  it('preview writes nothing and reports row issues', async () => {
    const contractorId = await newContractor('Alpha');
    const shown = await previewOf(
      [
        ['2-12-4-8', SCOPE_A, 226, 300],
        ['9-9', null, 1, 1],
      ],
      newTarget(contractorId),
    );
    expect(issueCodes(shown, 0)).toEqual(['QUANTITY_EXCEEDS_WORK_ORDER']);
    expect(issueCodes(shown, 1)).toEqual(['NOT_IN_WORK_ORDER']);
    expect(shown.fileIssues).toEqual([]);
    expect(shown.suggestedMapping.scope).toBe(3);
    expect(uow.registrations.rows.size).toBe(0);
    expect(storage.objects.size).toBe(0);
  });

  it('owner example across contractors and sheets', async () => {
    const one = await newContractor('One');
    const two = await newContractor('Two');
    const three = await newContractor('Three');
    const four = await newContractor('Four');
    await upload(
      [
        ['2-12-4-8', SCOPE_A, 225, 300],
        ['2-12-4-8', SCOPE_B, 225, 900],
      ],
      newTarget(one),
    );
    await upload([['2-12-4-8', SCOPE_C, 150, 500]], newTarget(two));

    // 75 more of «لحام  البوكس» at exactly the room is fine: the key ignores the spacing.
    const over = await rowErrors(
      upload([['2-12-4-8', 'لحام  البوكس', 76, 833.12]], newTarget(three)),
    );
    expect(over[0]?.issues.map((i) => i.code)).toEqual(['QUANTITY_EXCEEDS_WORK_ORDER']);
    const expensive = await rowErrors(
      upload([['2-12-4-8', 'لحام  البوكس', 75, 834]], newTarget(three)),
    );
    expect(expensive[0]?.issues).toMatchObject([
      {
        code: 'PRICE_EXCEEDS_CONTRACT',
        params: { contractPrice: '2033.12', otherScopesPrice: '1200', maxAllowedPrice: '833.12' },
      },
    ]);
    const whole = await rowErrors(upload([['2-12-4-8', null, 1, 1]], newTarget(three)));
    expect(whole[0]?.issues.map((i) => i.code)).toContain('WHOLE_AND_SCOPES_MIXED');

    const ok = await upload([['2-12-4-8', 'لحام  البوكس', 75, 833.12]], newTarget(three));
    const box = ok.availability.find((row) => row.item.id === BOX)!;
    expect(box.scopes.find((s) => s.scope === SCOPE_C)).toMatchObject({
      reserved: Decimal.parse('225'),
      available: Decimal.zero,
      highestPrice: Decimal.parse('833.12'),
    });
    expect(box.priceRoom.toString()).toBe('0');
    // Nothing fits any more: even a new scope at 0.01.
    const full = await rowErrors(upload([['2-12-4-8', 'نطاق آخر', 1, 0.01]], newTarget(four)));
    expect(full[0]?.issues.map((i) => i.code)).toEqual(['PRICE_EXCEEDS_CONTRACT']);
  });

  it('refuses the same code and scope twice and keeps nothing', async () => {
    const contractorId = await newContractor('Alpha');
    const rows = await rowErrors(
      upload(
        [
          ['2-12-4-8', SCOPE_A, 10, 1],
          ['2-12-4-8', 'تركيب  الخوصة', 10, 1],
        ],
        newTarget(contractorId),
      ),
    );
    expect(rows.map((row) => row.issues.map((i) => i.code))).toEqual([
      ['CODE_SCOPE_REPEATED'],
      ['CODE_SCOPE_REPEATED'],
    ]);
    expect(uow.registrations.rows.size).toBe(0);
    expect(storage.objects.size).toBe(0);
  });

  it('lets excluded rows go and skips rows with an empty quantity', async () => {
    const contractorId = await newContractor('Alpha');
    const view = await upload(
      [
        ['2-12-4-8', SCOPE_A, 10, 100],
        ['9-9', null, 1, 1],
        ['1-1', null, null, 10],
      ],
      newTarget(contractorId),
      { excluded: [3] },
    );
    expect(view.registrations[0]!.lines).toHaveLength(1);
    expect(uow.events.events.at(-1)?.payload).toMatchObject({ rowCount: 3, excludedRowCount: 1 });
  });

  it('answers IMPORT_INVALID FILE_CHANGED when the file differs from the preview', async () => {
    const contractorId = await newContractor('Alpha');
    const buffer = await sheet([['2-12-4-8', SCOPE_A, 10, 100]]);
    const shown = await preview.execute({
      projectId: PROJECT,
      file: { fileName: 'c.xlsx', buffer },
      options: { target: newTarget(contractorId) },
    });
    const other = await sheet([['2-12-4-8', SCOPE_A, 11, 100]]);
    await expect(
      commit.execute({
        projectId: PROJECT,
        actorId: ACTOR,
        file: { fileName: 'c.xlsx', buffer: other },
        payload: {
          fileSha256: shown.file.sha256,
          sheetName: shown.sheetName,
          headerRow: 1,
          mapping: {
            code: 0,
            description: 1,
            unit: 2,
            quantity: 4,
            unitPrice: 5,
            scope: 3,
            workType: null,
            amount: null,
          },
          excludedRowNumbers: [],
          target: newTarget(contractorId),
        },
      }),
    ).rejects.toMatchObject({ code: 'IMPORT_INVALID', details: { reason: 'FILE_CHANGED' } });
    expect(storage.objects.size).toBe(0);
  });

  it('refuses an upload with nothing to include', async () => {
    const contractorId = await newContractor('Alpha');
    await expect(
      upload([['2-12-4-8', SCOPE_A, 10, 100]], newTarget(contractorId), { excluded: [2] }),
    ).rejects.toMatchObject({ details: { reason: 'NO_ROWS_INCLUDED' } });
  });

  it('refuses a non-xlsx file', async () => {
    const contractorId = await newContractor('Alpha');
    await expect(
      preview.execute({
        projectId: PROJECT,
        file: { fileName: 'c.csv', buffer: Buffer.from('a,b') },
        options: { target: newTarget(contractorId) },
      }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_FILE' });
  });

  it('404s an unknown project and contractor; 409 without a work order and when already registered', async () => {
    const contractorId = await newContractor('Alpha');
    const rows: SheetRow[] = [['2-12-4-8', SCOPE_A, 10, 100]];
    await notFound(previewOf(rows, newTarget(contractorId), ids.next()));
    await notFound(previewOf(rows, newTarget(ids.next())));
    const none = await conflict(previewOf(rows, newTarget(contractorId), NO_ORDER_PROJECT));
    expect(none.reason).toBe('NO_WORK_ORDER');
    await upload(rows, newTarget(contractorId));
    const again = await conflict(previewOf(rows, newTarget(contractorId)));
    expect(again.reason).toBe('CONTRACTOR_ALREADY_REGISTERED');
  });
});

describe('uploading a contractor sheet (append)', () => {
  let registrationId: string;
  let contractorId: string;

  beforeEach(async () => {
    contractorId = await newContractor('Alpha');
    const view = await upload(
      [['2-12-4-8', SCOPE_A, 100, 300]],
      newTarget(contractorId, '2026-11-01'),
    );
    registrationId = view.registrations[0]!.id;
    uow.events.events.length = 0;
  });

  it('appends lines with the registration date, a file and one event per line', async () => {
    const view = await upload(
      [
        ['2-12-4-8', SCOPE_B, 50, 900],
        ['1-1', null, 5, 10],
      ],
      { kind: 'append', registrationId },
    );
    const registration = view.registrations[0]!;
    expect(registration.lines).toHaveLength(3);
    expect(registration.files).toHaveLength(2);
    expect(registration.lines[1]!.prices[0]!.effectiveFrom).toBe('2026-11-01');
    expect(uow.events.types()).toEqual(['contractor_line.added', 'contractor_line.added']);
    expect(uow.events.events[0]).toMatchObject({
      payload: {
        registrationId,
        scope: SCOPE_B,
        rowCount: 2,
        lineCount: 2,
        fileSha256: expect.any(String),
      },
    });
  });

  it('refuses a line and scope the registration already holds (LINE_ALREADY_ASSIGNED)', async () => {
    const rows = await rowErrors(
      upload([['2-12-4-8', 'تركيب  الخوصة', 5, 300]], { kind: 'append', registrationId }),
    );
    expect(rows[0]?.issues.map((i) => i.code)).toContain('LINE_ALREADY_ASSIGNED');
  });

  it('404s a registration of another project', async () => {
    await notFound(
      previewOf([['1-1', null, 1, 1]], { kind: 'append', registrationId }, OTHER_PROJECT),
    );
  });
});

describe('quantity, price, line and registration edits', () => {
  let registrationId: string;
  let lineA: string;
  let lineB: string;

  beforeEach(async () => {
    const one = await newContractor('One');
    const view = await upload(
      [
        ['2-12-4-8', SCOPE_A, 225, 300],
        ['2-12-4-8', SCOPE_B, 225, 900],
      ],
      newTarget(one),
    );
    registrationId = view.registrations[0]!.id;
    lineA = view.registrations[0]!.lines[0]!.id;
    lineB = view.registrations[0]!.lines[1]!.id;
    await upload([['2-12-4-8', SCOPE_C, 150, 500]], newTarget(await newContractor('Two')));
    uow.events.events.length = 0;
  });

  it('checks a quantity per scope, counting other contractors on that scope only', async () => {
    // Scope A is held by this contractor alone: 225 is the cap, lowering is fine.
    const lowered = await updateLine.execute({
      projectId: PROJECT,
      actorId: ACTOR,
      registrationId,
      lineId: lineA,
      request: { quantity: '100' },
    });
    expect(lowered.registrations[0]!.lines[0]!.quantity.toString()).toBe('100');
    const details = await conflict(
      updateLine.execute({
        projectId: PROJECT,
        actorId: ACTOR,
        registrationId,
        lineId: lineA,
        request: { quantity: '225.0001' },
      }),
    );
    expect(details).toMatchObject({
      reason: 'QUANTITY_EXCEEDS_WORK_ORDER',
      scope: SCOPE_A,
      workOrderQuantity: '225',
      reservedQuantity: '0',
      availableQuantity: '225',
    });
    expect(uow.events.events[0]).toMatchObject({
      type: 'contractor_line.updated',
      payload: { scope: SCOPE_A, before: { quantity: '225' }, after: { quantity: '100' } },
    });
  });

  it('blocks a dated price when the scopes would add up above the contract price, allows lower', async () => {
    // Others on the line: B 900 + C 500 = 1400, so scope A may go up to 633.12.
    const blocked = await conflict(
      addPrice.execute({
        projectId: PROJECT,
        actorId: ACTOR,
        registrationId,
        lineId: lineA,
        request: { effectiveFrom: '2026-12-01', unitPrice: '633.13' },
      }),
    );
    expect(blocked).toMatchObject({
      reason: 'PRICE_EXCEEDS_CONTRACT',
      scope: SCOPE_A,
      contractPrice: '2033.12',
      otherScopesPrice: '1400',
      maxAllowedPrice: '633.12',
      requestedPrice: '633.13',
    });
    const up = await addPrice.execute({
      projectId: PROJECT,
      actorId: ACTOR,
      registrationId,
      lineId: lineA,
      request: { effectiveFrom: '2026-12-01', unitPrice: '633.12' },
    });
    expect(up.registrations[0]!.lines[0]!.prices.map((p) => p.unitPrice.toString())).toEqual([
      '300',
      '633.12',
    ]);
    // Lowering is allowed; the scope still counts at its highest price ever.
    const down = await addPrice.execute({
      projectId: PROJECT,
      actorId: ACTOR,
      registrationId,
      lineId: lineA,
      request: { effectiveFrom: '2027-01-01', unitPrice: '100' },
    });
    const box = down.availability.find((row) => row.item.id === BOX)!;
    expect(box.scopes.find((s) => s.scope === SCOPE_A)!.highestPrice.toString()).toBe('633.12');
    expect(box.priceRoom.toString()).toBe('0');
    const stale = await conflict(
      addPrice.execute({
        projectId: PROJECT,
        actorId: ACTOR,
        registrationId,
        lineId: lineA,
        request: { effectiveFrom: '2027-01-01', unitPrice: '50' },
      }),
    );
    expect(stale).toMatchObject({
      reason: 'PRICE_DATE_NOT_AFTER_LATEST',
      latestEffectiveFrom: '2027-01-01',
    });
    expect(uow.events.events[0]).toMatchObject({
      type: 'contractor_line.price_added',
      payload: { scope: SCOPE_A, previous: { unitPrice: '300' } },
    });
  });

  it('removes a line with a snapshot but never the last one', async () => {
    const view = await removeLine.execute({
      projectId: PROJECT,
      actorId: ACTOR,
      registrationId,
      lineId: lineB,
    });
    expect(view.registrations[0]!.lines).toHaveLength(1);
    expect(uow.events.events[0]).toMatchObject({
      type: 'contractor_line.removed',
      payload: { id: lineB, scope: SCOPE_B, quantity: '225', prices: [{ unitPrice: '900' }] },
    });
    const details = await conflict(
      removeLine.execute({ projectId: PROJECT, actorId: ACTOR, registrationId, lineId: lineA }),
    );
    expect(details.reason).toBe('LAST_LINE');
    expect(view.registrations).toHaveLength(2);
  });

  it('removes a registration with a full snapshot as the event payload', async () => {
    const view = await removeRegistration.execute({
      projectId: PROJECT,
      actorId: ACTOR,
      registrationId,
    });
    expect(view.registrations).toHaveLength(1);
    expect(uow.events.events[0]).toMatchObject({
      type: 'contractor_registration.removed',
      projectId: PROJECT,
      payload: {
        id: registrationId,
        contractorName: 'One',
        lines: [{ scope: SCOPE_A }, { scope: SCOPE_B }],
        files: [{ fileName: 'contractor.xlsx' }],
      },
    });
  });

  it('answers 404 for a registration or line of another project (no IDOR)', async () => {
    await notFound(
      removeRegistration.execute({ projectId: OTHER_PROJECT, actorId: ACTOR, registrationId }),
    );
    await notFound(
      updateLine.execute({
        projectId: OTHER_PROJECT,
        actorId: ACTOR,
        registrationId,
        lineId: lineA,
        request: { quantity: '1' },
      }),
    );
    await notFound(
      updateLine.execute({
        projectId: PROJECT,
        actorId: ACTOR,
        registrationId,
        lineId: ids.next(),
        request: { quantity: '1' },
      }),
    );
    await notFound(
      addPrice.execute({
        projectId: OTHER_PROJECT,
        actorId: ACTOR,
        registrationId,
        lineId: lineA,
        request: { effectiveFrom: '2027-01-01', unitPrice: '1' },
      }),
    );
    await notFound(
      removeLine.execute({
        projectId: OTHER_PROJECT,
        actorId: ACTOR,
        registrationId,
        lineId: lineA,
      }),
    );
  });
});

describe('project view', () => {
  it('is empty without a work order and 404 for an unknown project', async () => {
    const get = new GetProjectContractorsUseCase(projects as never, uow.registrations);
    expect(await get.execute(NO_ORDER_PROJECT)).toMatchObject({
      workOrderId: null,
      registrations: [],
      availability: [],
      currency: 'EGP',
    });
    await notFound(get.execute(ids.next()));
  });

  it('lists every work-order line with what is left and the price room', async () => {
    const view = await viewOf(uow.registrations, PROJECT, 'EGP');
    expect(
      view.availability.map((row) => [row.item.id, row.mode, row.priceRoom.toString()]),
    ).toEqual([
      [BOX, 'free', '2033.12'],
      [TRENCH, 'free', '12.5'],
      [LEGACY, 'free', '12.5'],
    ]);
  });
});
