import { describe, expect, it } from 'vitest';
import { FakeClock, FakeHasher } from '../testing/in-memory.js';
import { InMemoryIdentityAdminUow, makeSummary } from '../testing/in-memory-admin.js';
import { CreateAssignmentUseCase, RemoveAssignmentUseCase } from './admin-assignments.use-cases.js';
import { CreateUserUseCase, SetUserActiveUseCase } from './admin-users.use-cases.js';

const ACTOR = '00000000-0000-4000-8000-000000000001';
const PROJECT = '00000000-0000-4000-8000-0000000000aa';

describe('CreateUserUseCase', () => {
  it('stores only the hash and logs an event without the password', async () => {
    const uow = new InMemoryIdentityAdminUow();
    const user = await new CreateUserUseCase(uow, new FakeHasher()).execute(
      { email: 'new@example.com', displayName: 'New', password: 'secret-password', locale: 'ar' },
      ACTOR,
    );
    expect(user.isAdmin).toBe(false);
    expect(uow.users.hashes.get(user.id)).toBe('hashed:secret-password');
    expect(uow.events.events).toEqual([
      expect.objectContaining({ type: 'user.created', entityId: user.id, actorId: ACTOR }),
    ]);
    expect(JSON.stringify(uow.events.events)).not.toContain('secret-password');
  });
});

describe('SetUserActiveUseCase', () => {
  const run = (uow: InMemoryIdentityAdminUow, userId: string, active: boolean, actor = ACTOR) =>
    new SetUserActiveUseCase(uow, new FakeClock()).execute({ userId, active }, actor);

  it('deactivates a user, revokes their sessions and logs it', async () => {
    const target = makeSummary();
    const uow = new InMemoryIdentityAdminUow([target]);
    const result = await run(uow, target.id, false);
    expect(result.isActive).toBe(false);
    expect(uow.users.revoked).toEqual([target.id]);
    expect(uow.events.events.map((event) => event.type)).toEqual(['user.deactivated']);
  });

  it('is a no-op (no event) when the state already matches', async () => {
    const target = makeSummary();
    const uow = new InMemoryIdentityAdminUow([target]);
    await run(uow, target.id, true);
    expect(uow.events.events).toEqual([]);
  });

  it('still ends the sessions of a user already marked inactive (e.g. flipped in SQL)', async () => {
    const target = makeSummary({ isActive: false });
    const uow = new InMemoryIdentityAdminUow([target]);
    await run(uow, target.id, false);
    expect(uow.users.revoked).toEqual([target.id]);
    expect(uow.events.events).toEqual([]);
  });

  it('refuses admins, yourself and unknown users', async () => {
    const admin = makeSummary({ isAdmin: true });
    const uow = new InMemoryIdentityAdminUow([admin]);
    await expect(run(uow, admin.id, false)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(run(uow, ACTOR, false)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(run(uow, PROJECT, false)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(uow.users.revoked).toEqual([]);
  });
});

describe('CreateAssignmentUseCase', () => {
  const run = (uow: InMemoryIdentityAdminUow, userId: string) =>
    new CreateAssignmentUseCase(uow).execute(
      { projectId: PROJECT, userId, role: 'pm', zoneId: null },
      ACTOR,
    );

  it('assigns an active non-admin and logs it against the project', async () => {
    const user = makeSummary();
    const uow = new InMemoryIdentityAdminUow([user]);
    const created = await run(uow, user.id);
    expect(uow.events.events).toEqual([
      expect.objectContaining({
        projectId: PROJECT,
        type: 'assignment.created',
        entityId: created.id,
      }),
    ]);
  });

  it('refuses admins, deactivated and unknown users', async () => {
    const admin = makeSummary({ isAdmin: true });
    const inactive = makeSummary({ isActive: false });
    const uow = new InMemoryIdentityAdminUow([admin, inactive]);
    await expect(run(uow, admin.id)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { reason: 'USER_IS_ADMIN' },
    });
    await expect(run(uow, inactive.id)).rejects.toMatchObject({
      details: { reason: 'USER_INACTIVE' },
    });
    await expect(run(uow, PROJECT)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(uow.assignments.rows).toEqual([]);
  });
});

describe('RemoveAssignmentUseCase', () => {
  it('removes only inside the given project', async () => {
    const user = makeSummary();
    const uow = new InMemoryIdentityAdminUow([user]);
    const created = await new CreateAssignmentUseCase(uow).execute(
      { projectId: PROJECT, userId: user.id, role: 'qc', zoneId: null },
      ACTOR,
    );
    const remove = new RemoveAssignmentUseCase(uow);
    await expect(
      remove.execute({ projectId: ACTOR, assignmentId: created.id }, ACTOR),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await remove.execute({ projectId: PROJECT, assignmentId: created.id }, ACTOR);
    expect(uow.assignments.rows).toEqual([]);
    expect(uow.events.events.at(-1)).toMatchObject({ type: 'assignment.removed' });
  });
});
