import { describe, expect, it } from 'vitest';
import {
  CreateAssignmentRequestSchema,
  CreateProjectRequestSchema,
  CreateUserRequestSchema,
  UpdateProjectRequestSchema,
} from './admin.schemas.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const ZONE_ID = '22222222-2222-4222-8222-222222222222';

describe('CreateProjectRequestSchema', () => {
  const valid = {
    name: ' مشروع ',
    crsEpsg: 32636,
    contractId: USER_ID,
    locale: 'ar',
  };

  it('accepts a UTM project and trims names', () => {
    expect(CreateProjectRequestSchema.parse(valid).name).toBe('مشروع');
  });

  it('rejects a non-UTM CRS, a missing contract, and client/currency (taken from the contract)', () => {
    expect(CreateProjectRequestSchema.safeParse({ ...valid, crsEpsg: 4326 }).success).toBe(false);
    expect(CreateProjectRequestSchema.safeParse({ ...valid, contractId: undefined }).success).toBe(
      false,
    );
    expect(CreateProjectRequestSchema.safeParse({ ...valid, currency: 'EGP' }).success).toBe(false);
    expect(CreateProjectRequestSchema.safeParse({ ...valid, client: 'X' }).success).toBe(false);
    expect(CreateProjectRequestSchema.safeParse({ ...valid, id: USER_ID }).success).toBe(false);
  });
});

describe('UpdateProjectRequestSchema', () => {
  it('refuses the CRS, the currency, the client and an empty body', () => {
    expect(UpdateProjectRequestSchema.safeParse({ crsEpsg: 32635 }).success).toBe(false);
    expect(UpdateProjectRequestSchema.safeParse({ currency: 'USD' }).success).toBe(false);
    expect(UpdateProjectRequestSchema.safeParse({ client: 'X' }).success).toBe(false);
    expect(UpdateProjectRequestSchema.safeParse({}).success).toBe(false);
    expect(UpdateProjectRequestSchema.parse({ name: 'X' })).toEqual({ name: 'X' });
  });
});

describe('CreateUserRequestSchema', () => {
  const valid = { email: 'New@Example.com', displayName: 'New', password: 'a-long-password' };

  it('lower-cases the email and defaults the locale to Arabic', () => {
    expect(CreateUserRequestSchema.parse(valid)).toMatchObject({
      email: 'new@example.com',
      locale: 'ar',
    });
  });

  it('applies the create-admin password rule (12..128)', () => {
    expect(CreateUserRequestSchema.safeParse({ ...valid, password: 'short-pass1' }).success).toBe(
      false,
    );
    expect(CreateUserRequestSchema.safeParse({ ...valid, password: 'x'.repeat(129) }).success).toBe(
      false,
    );
  });

  it('rejects isAdmin so no request can create an admin', () => {
    expect(CreateUserRequestSchema.safeParse({ ...valid, isAdmin: true }).success).toBe(false);
  });
});

describe('CreateAssignmentRequestSchema', () => {
  it('needs a zone for supervisor and contractor', () => {
    expect(
      CreateAssignmentRequestSchema.safeParse({ userId: USER_ID, role: 'supervisor' }).success,
    ).toBe(false);
    expect(
      CreateAssignmentRequestSchema.safeParse({
        userId: USER_ID,
        role: 'contractor',
        zoneId: ZONE_ID,
      }).success,
    ).toBe(true);
  });

  it('forbids a zone for project-wide roles', () => {
    expect(
      CreateAssignmentRequestSchema.safeParse({ userId: USER_ID, role: 'pm', zoneId: ZONE_ID })
        .success,
    ).toBe(false);
    expect(CreateAssignmentRequestSchema.parse({ userId: USER_ID, role: 'qc' }).zoneId).toBeNull();
  });

  it('never assigns the admin role', () => {
    expect(
      CreateAssignmentRequestSchema.safeParse({ userId: USER_ID, role: 'admin' }).success,
    ).toBe(false);
  });
});
