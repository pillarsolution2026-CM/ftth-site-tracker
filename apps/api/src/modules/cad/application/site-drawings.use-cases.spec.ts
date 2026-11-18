import { beforeEach, describe, expect, it } from 'vitest';
import type { IdGenerator } from '../../../common/clock.js';
import { FakeClock, InMemoryCadUnitOfWork, InMemoryWorkOrderSites } from '../testing/in-memory.js';
import {
  AssignDrawingSiteUseCase,
  ListSiteDrawingsUseCase,
  WithdrawSiteDrawingUseCase,
} from './site-drawings.use-cases.js';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const ACTOR = '22222222-2222-4222-8222-222222222222';
const SITE_A = 'abababab-abab-4bab-8bab-abababababab';
const SITE_B = 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd';

let uow: InMemoryCadUnitOfWork;
let sites: InMemoryWorkOrderSites;
let clock: FakeClock;
let ids: IdGenerator;

const drawing = (
  id: string,
  siteId: string | null,
  kind: 'general' | 'secondary',
  ordinal: number,
) => ({
  id,
  projectId: PROJECT,
  siteId,
  kind,
  ordinal,
  withdrawnAt: null,
  withdrawnById: null,
  createdById: ACTOR,
  createdAt: new Date('2026-11-18T10:00:00Z'),
});

beforeEach(() => {
  let n = 0;
  ids = { next: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}` };
  uow = new InMemoryCadUnitOfWork();
  clock = new FakeClock(new Date('2026-11-18T10:00:00Z'));
  sites = new InMemoryWorkOrderSites();
  sites.sites = [
    { id: SITE_A, workOrderId: 'w', name: 'الموقع أ', position: 1 },
    { id: SITE_B, workOrderId: 'w', name: 'الموقع ب', position: 2 },
  ];
});

const assign = (drawingId: string, siteId: string) =>
  new AssignDrawingSiteUseCase(uow, sites).execute({
    projectId: PROJECT,
    drawingId,
    actorId: ACTOR,
    request: { siteId },
  });

describe('ListSiteDrawingsUseCase', () => {
  it('lists every site with its drawings (General first), then the unassigned ones', async () => {
    uow.drawings.rows.set('s1', drawing('s1', SITE_A, 'secondary', 1));
    uow.drawings.rows.set('g', drawing('g', SITE_A, 'general', 1));
    uow.drawings.rows.set('old', drawing('old', null, 'general', 1));
    const list = await new ListSiteDrawingsUseCase(uow, sites).execute(PROJECT);
    expect(list.sites.map((s) => s.name)).toEqual(['الموقع أ', 'الموقع ب']);
    expect(list.sites[0]?.drawings.map((d) => [d.kind, d.ordinal, d.siteName])).toEqual([
      ['general', 1, 'الموقع أ'],
      ['secondary', 1, 'الموقع أ'],
    ]);
    expect(list.sites[1]?.drawings).toEqual([]);
    expect(list.unassigned.map((d) => [d.id, d.siteId, d.siteName])).toEqual([['old', null, null]]);
  });

  it('leaves withdrawn drawings out', async () => {
    uow.drawings.rows.set('g', {
      ...drawing('g', SITE_A, 'general', 1),
      withdrawnAt: new Date(),
    });
    const list = await new ListSiteDrawingsUseCase(uow, sites).execute(PROJECT);
    expect(list.sites[0]?.drawings).toEqual([]);
  });
});

describe('AssignDrawingSiteUseCase', () => {
  it('links an unassigned drawing once and records the event', async () => {
    uow.drawings.rows.set('old', drawing('old', null, 'general', 1));
    await assign('old', SITE_A);
    expect(uow.drawings.rows.get('old')).toMatchObject({ siteId: SITE_A, ordinal: 1 });
    expect(uow.events.events[0]).toMatchObject({
      type: 'site_drawing.assigned',
      payload: { siteId: SITE_A, siteName: 'الموقع أ' },
    });
    await expect(assign('old', SITE_B)).rejects.toMatchObject({
      details: { reason: 'ALREADY_ASSIGNED' },
    });
  });

  it('a Secondary takes the next number of the site', async () => {
    uow.drawings.rows.set('s1', drawing('s1', SITE_A, 'secondary', 1));
    uow.drawings.rows.set('old', drawing('old', null, 'secondary', 1));
    await assign('old', SITE_A);
    expect(uow.drawings.rows.get('old')?.ordinal).toBe(2);
  });

  it('refuses a General when the site already has one, and a site that is not on the work order', async () => {
    uow.drawings.rows.set('g', drawing('g', SITE_A, 'general', 1));
    uow.drawings.rows.set('old', drawing('old', null, 'general', 1));
    await expect(assign('old', SITE_A)).rejects.toMatchObject({
      details: { reason: 'GENERAL_EXISTS' },
    });
    await expect(assign('old', '99999999-9999-4999-8999-999999999999')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('WithdrawSiteDrawingUseCase', () => {
  const withdraw = (drawingId: string) =>
    new WithdrawSiteDrawingUseCase(uow, clock, ids).execute({
      projectId: PROJECT,
      drawingId,
      actorId: ACTOR,
    });

  it('withdraws a drawing that was never published and discards its open revision', async () => {
    uow.drawings.rows.set('s1', drawing('s1', SITE_A, 'secondary', 1));
    uow.revisions.rows.set('rev', {
      id: 'rev',
      projectId: PROJECT,
      drawingId: 's1',
      status: 'draft',
      errorCode: null,
    } as never);
    await withdraw('s1');
    expect(uow.drawings.rows.get('s1')).toMatchObject({
      withdrawnAt: clock.now(),
      withdrawnById: ACTOR,
    });
    expect(uow.revisions.rows.get('rev')?.status).toBe('discarded');
    expect(uow.events.types()).toEqual(['design_revision.discarded', 'site_drawing.withdrawn']);
    await expect(withdraw('s1')).rejects.toMatchObject({
      details: { reason: 'ALREADY_WITHDRAWN' },
    });
  });

  it('refuses a drawing that was ever published', async () => {
    uow.drawings.rows.set('g', drawing('g', SITE_A, 'general', 1));
    uow.revisions.rows.set('rev', {
      id: 'rev',
      projectId: PROJECT,
      drawingId: 'g',
      status: 'published',
      revNo: 1,
    } as never);
    await expect(withdraw('g')).rejects.toMatchObject({
      code: 'CONFLICT',
      details: { reason: 'DRAWING_PUBLISHED' },
    });
    expect(uow.drawings.rows.get('g')?.withdrawnAt).toBeNull();
  });

  it('does not find a drawing of another project', async () => {
    uow.drawings.rows.set('g', drawing('g', SITE_A, 'general', 1));
    await expect(
      new WithdrawSiteDrawingUseCase(uow, clock, ids).execute({
        projectId: '99999999-9999-4999-8999-999999999999',
        drawingId: 'g',
        actorId: ACTOR,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
