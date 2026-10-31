import { describe, expect, it } from 'vitest';
import type { Project } from '@ftth/shared';
import {
  projectSuggestions,
  validateAssignmentForm,
  validateProjectForm,
  validateUserForm,
} from './admin-forms';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const ZONE_ID = '22222222-2222-4222-8222-222222222222';
const CONTRACT_ID = '33333333-3333-4333-8333-333333333333';
const project = (overrides: Partial<Project>): Project => ({
  id: USER_ID,
  name: 'P',
  client: 'Client A',
  crsEpsg: 32636,
  currency: 'EGP',
  locale: 'ar',
  contractId: CONTRACT_ID,
  ...overrides,
});

describe('projectSuggestions', () => {
  it('pre-fills the most common existing values but never the contract', () => {
    const result = projectSuggestions([
      project({ crsEpsg: 32635, locale: 'en' }),
      project({ crsEpsg: 32635, locale: 'en', client: 'Client B' }),
      project({}),
    ]);
    expect(result.initial).toEqual({
      name: '',
      contractId: '',
      crsEpsg: '32635',
      locale: 'en',
    });
    expect(result.crsEpsg).toEqual(['32635', '32636']);
  });

  it('falls back to the first project values when none exist', () => {
    expect(projectSuggestions([]).initial).toMatchObject({ crsEpsg: '32636', locale: 'ar' });
  });
});

describe('validateProjectForm', () => {
  const values = { name: 'P', contractId: CONTRACT_ID, crsEpsg: '32636', locale: 'ar' };

  it('parses the EPSG code and sends the chosen contract (no client, no currency)', () => {
    expect(validateProjectForm(values)).toEqual({
      ok: true,
      payload: { name: 'P', contractId: CONTRACT_ID, crsEpsg: 32636, locale: 'ar' },
    });
  });

  it('flags a non-UTM CRS, empty names and a missing contract', () => {
    expect(validateProjectForm({ ...values, name: ' ', crsEpsg: '4326', contractId: '' })).toEqual({
      ok: false,
      errors: {
        name: 'validation.required',
        crsEpsg: 'admin.validation.crs',
        contractId: 'admin.validation.contract',
      },
    });
  });
});

describe('validateUserForm', () => {
  it('applies the 12-character password rule', () => {
    const result = validateUserForm({
      email: 'a@b.co',
      displayName: 'A',
      password: 'short',
      locale: 'ar',
    });
    expect(result).toEqual({ ok: false, errors: { password: 'admin.validation.password' } });
  });
});

describe('validateAssignmentForm', () => {
  it('requires a zone for a supervisor', () => {
    expect(validateAssignmentForm({ userId: USER_ID, role: 'supervisor', zoneId: '' })).toEqual({
      ok: false,
      errors: { zoneId: 'admin.assignments.zoneRequired' },
    });
  });

  it('drops a stale zone for a project-wide role', () => {
    expect(validateAssignmentForm({ userId: USER_ID, role: 'qc', zoneId: ZONE_ID })).toEqual({
      ok: true,
      payload: { userId: USER_ID, role: 'qc', zoneId: null },
    });
  });
});
