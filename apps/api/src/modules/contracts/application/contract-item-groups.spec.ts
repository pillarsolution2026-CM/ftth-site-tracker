import type { ContractItemInput } from '@ftth/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { systemClock, type IdGenerator } from '../../../common/clock.js';
import { toDetailDto } from '../interface/contract.presenter.js';
import { InMemoryContractUnitOfWork } from '../testing/in-memory.js';
import { GetContractUseCase } from './contract-queries.js';
import {
  AddContractItemUseCase,
  ApproveContractUseCase,
  CreateContractUseCase,
  SetContractItemGroupUseCase,
} from './contract.use-cases.js';

const ACTOR = '22222222-2222-4222-8222-222222222222';

let uow: InMemoryContractUnitOfWork;
let ids: IdGenerator;

beforeEach(() => {
  let n = 0;
  ids = { next: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}` };
  uow = new InMemoryContractUnitOfWork();
});

const line = (code: string, description: string): ContractItemInput => ({
  kind: 'item',
  code,
  description,
  unit: 'm',
  quantity: '2',
  unitPrice: '10',
  workType: 'civil',
});

/** A contract with a heading, a line the rule groups («end caps») and one it cannot («zzz»). */
async function contractWithLines() {
  const created = await new CreateContractUseCase(uow, systemClock, ids).execute({
    actorId: ACTOR,
    request: { number: 'C-1', name: 'عقد', client: 'العميل', currency: 'EGP' },
  });
  const id = created.contract.header.id;
  const add = new AddContractItemUseCase(uow, systemClock, ids);
  let version = 1;
  const inputs: ContractItemInput[] = [
    { kind: 'heading', code: 'H', description: 'قسم' },
    line('H-1', 'end caps'),
    line('H-2', 'zzz'),
  ];
  for (const item of inputs) {
    const view = await add.execute({
      contractId: id,
      actorId: ACTOR,
      request: { item, acceptDuplicateCode: false, expectedVersion: version },
    });
    version = view.contract.header.version;
  }
  return { id, version };
}

const setGroup = () => new SetContractItemGroupUseCase(uow, systemClock, ids);
const approve = () => new ApproveContractUseCase(uow, systemClock);
const getUseCase = () => new GetContractUseCase(uow.contracts, uow.attachments, uow.itemGroups);
const idOf = (code: string) =>
  [...uow.contracts.rows.values()][0]?.lines.find((l) => l.code === code)?.id ?? '';
const groupOf = async (id: string, code: string) =>
  toDetailDto(await getUseCase().execute(id)).items.find((i) => i.code === code)?.group;

describe('contract item groups (ADR-048)', () => {
  it('shows the rule, the manual choice and the ungrouped count on the detail', async () => {
    const { id, version } = await contractWithLines();
    const before = toDetailDto(await getUseCase().execute(id));
    expect(before.ungroupedItemCount).toBe(1);
    expect(before.items.find((i) => i.code === 'H')?.group).toBeNull();
    expect(await groupOf(id, 'H-1')).toMatchObject({
      source: 'rule',
      group: { main: 'طبات', sub: null },
    });
    expect(await groupOf(id, 'H-2')).toMatchObject({ source: 'none', group: null });

    await setGroup().execute({
      contractId: id,
      itemId: idOf('H-2'),
      actorId: ACTOR,
      request: { main: 'مخصص', sub: 'فرعي', expectedVersion: version },
    });
    const after = toDetailDto(await getUseCase().execute(id));
    expect(after.ungroupedItemCount).toBe(0);
    expect(await groupOf(id, 'H-2')).toMatchObject({
      source: 'manual',
      group: { main: 'مخصص', sub: 'فرعي' },
    });
  });

  it('records the choice and an event with before and after, and bumps the version', async () => {
    const { id, version } = await contractWithLines();
    const itemId = idOf('H-2');
    const first = await setGroup().execute({
      contractId: id,
      itemId,
      actorId: ACTOR,
      request: { main: 'أ', expectedVersion: version },
    });
    expect(first.contract.header.version).toBe(version + 1);
    expect(uow.events.events.at(-1)).toMatchObject({
      type: 'contract_item.group_set',
      entity: 'contract_item',
      entityId: itemId,
      projectId: null,
      actorId: ACTOR,
      payload: { itemId, code: 'H-2', before: null, after: { main: 'أ', sub: null } },
    });
    await setGroup().execute({
      contractId: id,
      itemId,
      actorId: ACTOR,
      request: { main: 'ب', sub: 'ج', expectedVersion: version + 1 },
    });
    expect(uow.events.events.at(-1)).toMatchObject({
      payload: { before: { main: 'أ', sub: null }, after: { main: 'ب', sub: 'ج' } },
    });
    expect(uow.itemGroups.rows).toHaveLength(2);
  });

  it('overrides the rule with a manual choice and goes back to it with main null', async () => {
    const { id, version } = await contractWithLines();
    const itemId = idOf('H-1');
    await setGroup().execute({
      contractId: id,
      itemId,
      actorId: ACTOR,
      request: { main: 'يدوي', expectedVersion: version },
    });
    expect(await groupOf(id, 'H-1')).toMatchObject({
      source: 'manual',
      ruleGroup: { main: 'طبات' },
    });
    await setGroup().execute({
      contractId: id,
      itemId,
      actorId: ACTOR,
      request: { main: null, expectedVersion: version + 1 },
    });
    expect(await groupOf(id, 'H-1')).toMatchObject({ source: 'rule', group: { main: 'طبات' } });
    expect(uow.events.events.at(-1)).toMatchObject({
      payload: { before: { main: 'يدوي', sub: null }, after: null },
    });
  });

  it('refuses a heading, an unknown item and a stale version', async () => {
    const { id, version } = await contractWithLines();
    await expect(
      setGroup().execute({
        contractId: id,
        itemId: idOf('H'),
        actorId: ACTOR,
        request: { main: 'أ', expectedVersion: version },
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED', details: { reason: 'ITEM_IS_HEADING' } });
    await expect(
      setGroup().execute({
        contractId: id,
        itemId: '99999999-9999-4999-8999-999999999999',
        actorId: ACTOR,
        request: { main: 'أ', expectedVersion: version },
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      setGroup().execute({
        contractId: id,
        itemId: idOf('H-2'),
        actorId: ACTOR,
        request: { main: 'أ', expectedVersion: version - 1 },
      }),
    ).rejects.toMatchObject({ details: { reason: 'STALE_VERSION' } });
    expect(uow.itemGroups.rows).toHaveLength(0);
  });

  it('refuses to approve while a line has no group, then approves after a manual group', async () => {
    const { id, version } = await contractWithLines();
    await expect(
      approve().execute({ contractId: id, actorId: ACTOR, request: { expectedVersion: version } }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      details: { reason: 'CONTRACT_ITEMS_UNGROUPED', codes: ['H-2'] },
    });
    await setGroup().execute({
      contractId: id,
      itemId: idOf('H-2'),
      actorId: ACTOR,
      request: { main: 'أ', expectedVersion: version },
    });
    const view = await approve().execute({
      contractId: id,
      actorId: ACTOR,
      request: { expectedVersion: version + 1 },
    });
    expect(view.contract.header.status).toBe('approved');
  });

  it('lets the admin change a group after approval', async () => {
    const { id, version } = await contractWithLines();
    await setGroup().execute({
      contractId: id,
      itemId: idOf('H-2'),
      actorId: ACTOR,
      request: { main: 'أ', expectedVersion: version },
    });
    const approved = await approve().execute({
      contractId: id,
      actorId: ACTOR,
      request: { expectedVersion: version + 1 },
    });
    const view = await setGroup().execute({
      contractId: id,
      itemId: idOf('H-2'),
      actorId: ACTOR,
      request: { main: 'ب', expectedVersion: approved.contract.header.version },
    });
    expect(view.contract.header.version).toBe(approved.contract.header.version + 1);
    expect(view.manualGroups.get(idOf('H-2'))?.group).toEqual({ main: 'ب', sub: null });
  });
});
