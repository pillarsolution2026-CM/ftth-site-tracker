/* Test file: an index into a result that was just asserted to have that many rows. */
/* eslint-disable @typescript-eslint/no-non-null-assertion */
import type { RegisterContractorRequest } from '@ftth/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../../../common/app-error.js';
import { systemClock, type IdGenerator } from '../../../common/clock.js';
import { Decimal } from '../../work-orders/domain/decimal.js';
import type { WorkOrderLine } from '../domain/contractor.js';
import { InMemoryContractorUnitOfWork } from '../testing/in-memory.js';
import { GetProjectContractorsUseCase, viewOf } from './contractor-queries.js';
import { CreateContractorUseCase, UpdateContractorUseCase } from './contractor.use-cases.js';
import {
  AddContractorLineUseCase,
  AddContractorPriceUseCase,
  RegisterContractorUseCase,
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

const line = (
  id: string,
  lineNo: number,
  overrides: Partial<WorkOrderLine> = {},
): WorkOrderLine => ({
  id,
  lineNo,
  code: `C${lineNo}`,
  description: `Item ${lineNo}`,
  unit: 'm',
  workType: 'civil',
  unitPrice: Decimal.parse('12.5'),
  quantity: Decimal.parse('100'),
  contractItemId: `cccccccc-cccc-4ccc-8ccc-00000000000${lineNo}`,
  ...overrides,
});
const TRENCH = '30000000-0000-4000-8000-000000000001';
const CHAMBER = '30000000-0000-4000-8000-000000000002';
const LEGACY = '30000000-0000-4000-8000-000000000003';
const ELSEWHERE = '30000000-0000-4000-8000-000000000004';

let uow: InMemoryContractorUnitOfWork;
let ids: IdGenerator;
let projects: { execute: (projectId: string) => Promise<{ currency: string }> };
let create: CreateContractorUseCase;
let update: UpdateContractorUseCase;
let register: RegisterContractorUseCase;
let removeRegistration: RemoveRegistrationUseCase;
let addLine: AddContractorLineUseCase;
let updateLine: UpdateContractorLineUseCase;
let removeLine: RemoveContractorLineUseCase;
let addPrice: AddContractorPriceUseCase;
let contractorA: string;
let contractorB: string;

const person = (name: string) => ({
  name,
  contactName: 'Hassan',
  contactPhone: '+20 100 000 0000',
});

beforeEach(async () => {
  let n = 0;
  ids = { next: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}` };
  uow = new InMemoryContractorUnitOfWork();
  uow.registrations.workOrders.set(PROJECT, ORDER);
  uow.registrations.workOrders.set(OTHER_PROJECT, OTHER_ORDER);
  uow.registrations.lines.set(ORDER, [
    line(TRENCH, 1),
    line(CHAMBER, 2, { quantity: Decimal.parse('10'), unitPrice: Decimal.parse('8000') }),
    line(LEGACY, 3, { contractItemId: null }),
  ]);
  uow.registrations.lines.set(OTHER_ORDER, [line(ELSEWHERE, 1)]);
  projects = {
    execute: async (projectId) => {
      if (projectId === NO_ORDER_PROJECT || projectId === PROJECT || projectId === OTHER_PROJECT) {
        return { currency: 'EGP' };
      }
      throw new AppError('NOT_FOUND', 'Project not found');
    },
  };
  create = new CreateContractorUseCase(uow, systemClock, ids);
  update = new UpdateContractorUseCase(uow);
  register = new RegisterContractorUseCase(projects as never, uow, ids);
  removeRegistration = new RemoveRegistrationUseCase(projects as never, uow);
  addLine = new AddContractorLineUseCase(projects as never, uow, ids);
  updateLine = new UpdateContractorLineUseCase(projects as never, uow);
  removeLine = new RemoveContractorLineUseCase(projects as never, uow);
  addPrice = new AddContractorPriceUseCase(projects as never, uow, ids);
  contractorA = (await create.execute({ actorId: ACTOR, request: person('Alpha') })).id;
  contractorB = (await create.execute({ actorId: ACTOR, request: person('Beta') })).id;
  uow.events.events.length = 0;
});

const registerRequest = (
  contractorId: string,
  lines: RegisterContractorRequest['lines'],
  registeredOn = '2026-11-01',
): RegisterContractorRequest => ({ contractorId, registeredOn, lines });

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
      actorId: ACTOR,
    });
    const details = await conflict(create.execute({ actorId: ACTOR, request: person('  gamma ') }));
    expect(details.reason).toBe('CONTRACTOR_NAME_TAKEN');
  });

  it('updates with the expected version, records before/after, and refuses a stale version', async () => {
    const updated = await update.execute({
      contractorId: contractorA,
      actorId: ACTOR,
      request: { expectedVersion: 1, contactName: 'Mona', taxCard: 'TC-9' },
    });
    expect(updated).toMatchObject({ contactName: 'Mona', taxCard: 'TC-9', version: 2 });
    expect(uow.events.events.at(-1)).toMatchObject({
      type: 'contractor.updated',
      projectId: null,
      payload: {
        before: { contactName: 'Hassan', taxCard: null },
        after: { contactName: 'Mona', taxCard: 'TC-9' },
        version: 2,
      },
    });
    const details = await conflict(
      update.execute({
        contractorId: contractorA,
        actorId: ACTOR,
        request: { expectedVersion: 1, contactName: 'X' },
      }),
    );
    expect(details).toMatchObject({ reason: 'STALE_VERSION', currentVersion: 2 });
  });

  it('refuses renaming onto another contractor and 404s an unknown contractor', async () => {
    const details = await conflict(
      update.execute({
        contractorId: contractorA,
        actorId: ACTOR,
        request: { expectedVersion: 1, name: 'beta' },
      }),
    );
    expect(details.reason).toBe('CONTRACTOR_NAME_TAKEN');
    await notFound(
      update.execute({
        contractorId: ids.next(),
        actorId: ACTOR,
        request: { expectedVersion: 1, name: 'Zed' },
      }),
    );
  });
});

describe('RegisterContractorUseCase', () => {
  it('registers with lines and a first price on the registration date, in one event', async () => {
    const view = await register.execute({
      projectId: PROJECT,
      actorId: ACTOR,
      request: registerRequest(contractorA, [
        { workOrderItemId: TRENCH, quantity: '60', unitPrice: '11' },
        { workOrderItemId: CHAMBER, quantity: '4.5', unitPrice: '8000' },
      ]),
    });
    expect(view.registrations).toHaveLength(1);
    const registration = view.registrations[0]!;
    expect(registration.registeredOn).toBe('2026-11-01');
    expect(registration.lines.map((l) => l.item.code)).toEqual(['C1', 'C2']);
    expect(registration.lines[0]!.prices).toMatchObject([
      { effectiveFrom: '2026-11-01', createdById: ACTOR },
    ]);
    expect(registration.lines[0]!.prices[0]!.unitPrice.toString()).toBe('11');
    expect(uow.events.types()).toEqual(['contractor_registration.registered']);
    expect(uow.events.events[0]).toMatchObject({
      projectId: PROJECT,
      entity: 'contractor_registration',
      entityId: registration.id,
    });
    expect(uow.registrations.locked).toContain(PROJECT);

    const trench = view.availability.find((row) => row.item.id === TRENCH)!;
    expect(trench.reserved.toString()).toBe('60');
    expect(trench.available.toString()).toBe('40');
    const chamber = view.availability.find((row) => row.item.id === CHAMBER)!;
    expect(chamber.available.toString()).toBe('5.5');
    expect(view.availability.find((row) => row.item.id === LEGACY)!.item.contractItemId).toBeNull();
  });

  it('404s an unknown project and an unknown contractor; 409 NO_WORK_ORDER without an order', async () => {
    await notFound(
      register.execute({
        projectId: ids.next(),
        actorId: ACTOR,
        request: registerRequest(contractorA, [
          { workOrderItemId: TRENCH, quantity: '1', unitPrice: '1' },
        ]),
      }),
    );
    await notFound(
      register.execute({
        projectId: PROJECT,
        actorId: ACTOR,
        request: registerRequest(ids.next(), [
          { workOrderItemId: TRENCH, quantity: '1', unitPrice: '1' },
        ]),
      }),
    );
    const details = await conflict(
      register.execute({
        projectId: NO_ORDER_PROJECT,
        actorId: ACTOR,
        request: registerRequest(contractorA, [
          { workOrderItemId: TRENCH, quantity: '1', unitPrice: '1' },
        ]),
      }),
    );
    expect(details.reason).toBe('NO_WORK_ORDER');
  });

  it('refuses the same contractor twice on a work order', async () => {
    const request = registerRequest(contractorA, [
      { workOrderItemId: TRENCH, quantity: '1', unitPrice: '1' },
    ]);
    await register.execute({ projectId: PROJECT, actorId: ACTOR, request });
    const details = await conflict(
      register.execute({ projectId: PROJECT, actorId: ACTOR, request }),
    );
    expect(details.reason).toBe('CONTRACTOR_ALREADY_REGISTERED');
  });

  it('refuses a line of another work order and a legacy line', async () => {
    const elsewhere = await conflict(
      register.execute({
        projectId: PROJECT,
        actorId: ACTOR,
        request: registerRequest(contractorA, [
          { workOrderItemId: ELSEWHERE, quantity: '1', unitPrice: '1' },
        ]),
      }),
    );
    expect(elsewhere.reason).toBe('LINE_NOT_IN_WORK_ORDER');
    const legacy = await conflict(
      register.execute({
        projectId: PROJECT,
        actorId: ACTOR,
        request: registerRequest(contractorA, [
          { workOrderItemId: LEGACY, quantity: '1', unitPrice: '1' },
        ]),
      }),
    );
    expect(legacy.reason).toBe('LEGACY_ITEM');
  });

  it('caps the quantity across contractors: the exact remainder is fine, one more is refused with the numbers', async () => {
    await register.execute({
      projectId: PROJECT,
      actorId: ACTOR,
      request: registerRequest(contractorA, [
        { workOrderItemId: TRENCH, quantity: '60.25', unitPrice: '12.5' },
      ]),
    });
    const details = await conflict(
      register.execute({
        projectId: PROJECT,
        actorId: ACTOR,
        request: registerRequest(contractorB, [
          { workOrderItemId: TRENCH, quantity: '39.7501', unitPrice: '12.5' },
        ]),
      }),
    );
    expect(details).toMatchObject({
      reason: 'QUANTITY_EXCEEDS_WORK_ORDER',
      workOrderItemId: TRENCH,
      code: 'C1',
      workOrderQuantity: '100',
      reservedQuantity: '60.25',
      requestedQuantity: '39.7501',
      availableQuantity: '39.75',
    });
    const view = await register.execute({
      projectId: PROJECT,
      actorId: ACTOR,
      request: registerRequest(contractorB, [
        { workOrderItemId: TRENCH, quantity: '39.75', unitPrice: '12.5' },
      ]),
    });
    expect(view.availability[0]!.available.toString()).toBe('0');
  });

  it('refuses a price above the contract price and accepts the contract price itself', async () => {
    const details = await conflict(
      register.execute({
        projectId: PROJECT,
        actorId: ACTOR,
        request: registerRequest(contractorA, [
          { workOrderItemId: TRENCH, quantity: '1', unitPrice: '12.500001' },
        ]),
      }),
    );
    expect(details).toMatchObject({
      reason: 'PRICE_EXCEEDS_CONTRACT',
      workOrderItemId: TRENCH,
      code: 'C1',
      contractPrice: '12.5',
      requestedPrice: '12.500001',
    });
    await register.execute({
      projectId: PROJECT,
      actorId: ACTOR,
      request: registerRequest(contractorA, [
        { workOrderItemId: TRENCH, quantity: '1', unitPrice: '12.5' },
      ]),
    });
  });
});

describe('lines and prices', () => {
  let registrationId: string;
  let trenchLineId: string;

  beforeEach(async () => {
    const view = await register.execute({
      projectId: PROJECT,
      actorId: ACTOR,
      request: registerRequest(contractorA, [
        { workOrderItemId: TRENCH, quantity: '60', unitPrice: '11' },
      ]),
    });
    registrationId = view.registrations[0]!.id;
    trenchLineId = view.registrations[0]!.lines[0]!.id;
    uow.events.events.length = 0;
  });

  it('adds a line with its first price on the registration date and refuses a repeated line', async () => {
    const view = await addLine.execute({
      projectId: PROJECT,
      actorId: ACTOR,
      registrationId,
      request: { workOrderItemId: CHAMBER, quantity: '10', unitPrice: '7000' },
    });
    const added = view.registrations[0]!.lines.find((l) => l.item.id === CHAMBER)!;
    expect(added.prices.map((p) => p.effectiveFrom)).toEqual(['2026-11-01']);
    expect(uow.events.events[0]).toMatchObject({
      type: 'contractor_line.added',
      entity: 'contractor_line',
      projectId: PROJECT,
    });
    const details = await conflict(
      addLine.execute({
        projectId: PROJECT,
        actorId: ACTOR,
        registrationId,
        request: { workOrderItemId: CHAMBER, quantity: '1', unitPrice: '1' },
      }),
    );
    expect(details.reason).toBe('LINE_REPEATED');
  });

  it('checks the cap and the price ceiling when adding a line', async () => {
    const quantity = await conflict(
      addLine.execute({
        projectId: PROJECT,
        actorId: ACTOR,
        registrationId,
        request: { workOrderItemId: CHAMBER, quantity: '10.0001', unitPrice: '1' },
      }),
    );
    expect(quantity.reason).toBe('QUANTITY_EXCEEDS_WORK_ORDER');
    const price = await conflict(
      addLine.execute({
        projectId: PROJECT,
        actorId: ACTOR,
        registrationId,
        request: { workOrderItemId: CHAMBER, quantity: '1', unitPrice: '8000.01' },
      }),
    );
    expect(price.reason).toBe('PRICE_EXCEEDS_CONTRACT');
  });

  it('changes a quantity up to the work-order quantity, counting the line itself only once', async () => {
    const view = await updateLine.execute({
      projectId: PROJECT,
      actorId: ACTOR,
      registrationId,
      lineId: trenchLineId,
      request: { quantity: '100' },
    });
    expect(view.registrations[0]!.lines[0]!.quantity.toString()).toBe('100');
    expect(uow.events.events[0]).toMatchObject({
      type: 'contractor_line.updated',
      payload: { before: { quantity: '60' }, after: { quantity: '100' } },
    });
    const details = await conflict(
      updateLine.execute({
        projectId: PROJECT,
        actorId: ACTOR,
        registrationId,
        lineId: trenchLineId,
        request: { quantity: '100.0001' },
      }),
    );
    expect(details).toMatchObject({
      reason: 'QUANTITY_EXCEEDS_WORK_ORDER',
      reservedQuantity: '0',
      availableQuantity: '100',
    });
  });

  it('counts the other contractors when a quantity changes', async () => {
    await register.execute({
      projectId: PROJECT,
      actorId: ACTOR,
      request: registerRequest(contractorB, [
        { workOrderItemId: TRENCH, quantity: '30', unitPrice: '12' },
      ]),
    });
    const details = await conflict(
      updateLine.execute({
        projectId: PROJECT,
        actorId: ACTOR,
        registrationId,
        lineId: trenchLineId,
        request: { quantity: '70.5' },
      }),
    );
    expect(details).toMatchObject({ reservedQuantity: '30', availableQuantity: '70' });
  });

  it('appends dated prices, oldest first, and refuses the same or an earlier date', async () => {
    const view = await addPrice.execute({
      projectId: PROJECT,
      actorId: ACTOR,
      registrationId,
      lineId: trenchLineId,
      request: { effectiveFrom: '2026-12-01', unitPrice: '10.5' },
    });
    expect(
      view.registrations[0]!.lines[0]!.prices.map((p) => [p.effectiveFrom, p.unitPrice.toString()]),
    ).toEqual([
      ['2026-11-01', '11'],
      ['2026-12-01', '10.5'],
    ]);
    expect(uow.events.events[0]).toMatchObject({
      type: 'contractor_line.price_added',
      entityId: trenchLineId,
      payload: {
        effectiveFrom: '2026-12-01',
        unitPrice: '10.5',
        previous: { effectiveFrom: '2026-11-01', unitPrice: '11' },
      },
    });
    for (const effectiveFrom of ['2026-12-01', '2026-11-15', '2026-11-01']) {
      const details = await conflict(
        addPrice.execute({
          projectId: PROJECT,
          actorId: ACTOR,
          registrationId,
          lineId: trenchLineId,
          request: { effectiveFrom, unitPrice: '10' },
        }),
      );
      expect(details).toMatchObject({
        reason: 'PRICE_DATE_NOT_AFTER_LATEST',
        latestEffectiveFrom: '2026-12-01',
      });
    }
  });

  it('refuses a new price above the contract price', async () => {
    const details = await conflict(
      addPrice.execute({
        projectId: PROJECT,
        actorId: ACTOR,
        registrationId,
        lineId: trenchLineId,
        request: { effectiveFrom: '2026-12-01', unitPrice: '13' },
      }),
    );
    expect(details).toMatchObject({
      reason: 'PRICE_EXCEEDS_CONTRACT',
      contractPrice: '12.5',
      requestedPrice: '13',
    });
  });

  it('refuses to remove the last line of a registration (owner: the item list is required)', async () => {
    const details = await conflict(
      removeLine.execute({
        projectId: PROJECT,
        actorId: ACTOR,
        registrationId,
        lineId: trenchLineId,
      }),
    );
    expect(details).toMatchObject({ reason: 'LAST_LINE', registrationId });
  });

  it('removes a line and writes its snapshot with the price history', async () => {
    await addLine.execute({
      projectId: PROJECT,
      actorId: ACTOR,
      registrationId,
      request: { workOrderItemId: CHAMBER, quantity: '10', unitPrice: '7000' },
    });
    await addPrice.execute({
      projectId: PROJECT,
      actorId: ACTOR,
      registrationId,
      lineId: trenchLineId,
      request: { effectiveFrom: '2026-12-01', unitPrice: '10' },
    });
    uow.events.events.length = 0;
    const view = await removeLine.execute({
      projectId: PROJECT,
      actorId: ACTOR,
      registrationId,
      lineId: trenchLineId,
    });
    expect(view.registrations[0]!.lines.map((line) => line.item.id)).toEqual([CHAMBER]);
    expect(view.availability.find((row) => row.item.id === TRENCH)!.reserved.toString()).toBe('0');
    expect(uow.events.events[0]).toMatchObject({
      type: 'contractor_line.removed',
      payload: {
        id: trenchLineId,
        quantity: '60',
        prices: [
          { effectiveFrom: '2026-11-01', unitPrice: '11' },
          { effectiveFrom: '2026-12-01', unitPrice: '10' },
        ],
      },
    });
  });

  it('removes a registration with a full snapshot as the event payload', async () => {
    const view = await removeRegistration.execute({
      projectId: PROJECT,
      actorId: ACTOR,
      registrationId,
    });
    expect(view.registrations).toHaveLength(0);
    expect(uow.events.events[0]).toMatchObject({
      type: 'contractor_registration.removed',
      entityId: registrationId,
      projectId: PROJECT,
      payload: {
        id: registrationId,
        contractorName: 'Alpha',
        registeredOn: '2026-11-01',
        lines: [{ id: trenchLineId, code: 'C1', quantity: '60' }],
      },
    });
  });

  it('answers 404 for a registration or line of another project (no IDOR)', async () => {
    await notFound(
      removeRegistration.execute({ projectId: OTHER_PROJECT, actorId: ACTOR, registrationId }),
    );
    await notFound(
      addLine.execute({
        projectId: OTHER_PROJECT,
        actorId: ACTOR,
        registrationId,
        request: { workOrderItemId: ELSEWHERE, quantity: '1', unitPrice: '1' },
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
        lineId: trenchLineId,
        request: { effectiveFrom: '2027-01-01', unitPrice: '1' },
      }),
    );
    await notFound(
      removeLine.execute({
        projectId: OTHER_PROJECT,
        actorId: ACTOR,
        registrationId,
        lineId: trenchLineId,
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

  it('lists every work-order line with what is left', async () => {
    const view = await viewOf(uow.registrations, PROJECT, 'EGP');
    expect(view.availability.map((row) => [row.item.id, row.available.toString()])).toEqual([
      [TRENCH, '100'],
      [CHAMBER, '10'],
      [LEGACY, '100'],
    ]);
  });
});
