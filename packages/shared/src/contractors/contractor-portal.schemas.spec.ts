import { describe, expect, it } from 'vitest';
import {
  ContractorPortalResponseSchema,
  CreateContractorAccountRequestSchema,
  MeResponseSchema,
  UpdateContractorAccountRequestSchema,
  hasPermission,
} from '../index.js';

const uuid = (n: number): string => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;

describe('contractor accounts (ADR-053)', () => {
  it('admin and pm manage the accounts; qc, supervisor and contractor do not', () => {
    expect(hasPermission(['pm'], 'contractor_accounts:manage')).toBe(true);
    expect(hasPermission(['admin'], 'contractor_accounts:manage')).toBe(true);
    for (const role of ['qc', 'supervisor', 'contractor'] as const) {
      expect(hasPermission([role], 'contractor_accounts:manage')).toBe(false);
    }
  });

  it('never accepts an admin flag on a new account and lower-cases the email', () => {
    const body = { email: 'A@B.CO', displayName: 'x', password: 'p'.repeat(12) };
    expect(CreateContractorAccountRequestSchema.parse(body).email).toBe('a@b.co');
    expect(CreateContractorAccountRequestSchema.safeParse({ ...body, isAdmin: true }).success).toBe(
      false,
    );
  });

  it('only stops or restarts an account', () => {
    expect(UpdateContractorAccountRequestSchema.safeParse({ isActive: false }).success).toBe(true);
    expect(
      UpdateContractorAccountRequestSchema.safeParse({ isActive: true, email: 'x@y.z' }).success,
    ).toBe(false);
  });

  it('defaults the contractor of /me to null for other users', () => {
    const me = MeResponseSchema.parse({
      id: uuid(1),
      email: 'a@b.co',
      displayName: 'a',
      locale: 'ar',
      isAdmin: false,
      memberships: [],
    });
    expect(me.contractor).toBeNull();
  });
});

describe('ContractorPortalResponseSchema', () => {
  const portal = {
    serverTime: '2026-11-21T10:00:00Z',
    contractor: { id: uuid(1), name: 'C' },
    registrations: [
      {
        registrationId: uuid(2),
        projectId: uuid(3),
        projectName: 'P',
        workOrderNumber: 'WO-1',
        currency: 'EGP',
        registeredOn: '2026-11-01',
        lines: [
          {
            contractorLineId: uuid(4),
            code: '1-1',
            description: 'd',
            unit: 'م',
            scope: null,
            quantity: '100',
            prices: [{ effectiveFrom: '2026-11-01', unitPrice: '12.5' }],
            recordedQuantity: '20',
          },
        ],
      },
    ],
    work: [
      {
        key: `${uuid(5)}:1`,
        registrationId: uuid(2),
        contractorLineId: uuid(4),
        element: { featureType: 'box', code: '283A' },
        workDate: '2026-11-10',
        quantity: '20',
        status: 'pending',
        reviewReason: null,
        unitPrice: '12.5',
        value: '250',
      },
    ],
    totals: [{ currency: 'EGP', approved: '0', pending: '250', rejected: '0' }],
  };

  it('parses a portal answer', () => {
    expect(ContractorPortalResponseSchema.safeParse(portal).success).toBe(true);
  });

  it('carries no contract price, photo or supervisor field', () => {
    const parsed = ContractorPortalResponseSchema.parse({
      ...portal,
      work: [{ ...portal.work[0], userId: uuid(9), photos: [], contractPrice: '99' }],
    });
    const text = JSON.stringify(parsed);
    for (const leaked of ['contractPrice', 'photos', 'userId']) expect(text).not.toContain(leaked);
  });
});
