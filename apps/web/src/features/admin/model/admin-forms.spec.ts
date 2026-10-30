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
const project = (overrides: Partial<Project>): Project => ({
  id: USER_ID,
  name: 'P',
  client: 'Client A',
  crsEpsg: 32636,
  currency: 'EGP',
  locale: 'ar',
  ...overrides,
});

describe('projectSuggestions', () => {
  it('pre-fills the most common existing values but never the client', () => {
    const result = projectSuggestions([
      project({ crsEpsg: 32635, currency: 'USD', locale: 'en' }),
      project({ crsEpsg: 32635, currency: 'USD', locale: 'en', client: 'Client B' }),
      project({}),
    ]);
    expect(result.initial).toEqual({
      name: '',
      client: '',
      crsEpsg: '32635',
      currency: 'USD',
      locale: 'en',
    });
    expect(result.crsEpsg).toEqual(['32635', '32636']);
    expect(result.clients).toEqual(['Client A', 'Client B']);
  });

  it('falls back to the first project values when none exist', () => {
    expect(projectSuggestions([]).initial).toMatchObject({ crsEpsg: '32636', currency: 'EGP' });
  });
});

describe('validateProjectForm', () => {
  const values = { name: 'P', client: 'C', crsEpsg: '32636', currency: 'egp', locale: 'ar' };

  it('upper-cases the currency and parses the EPSG code', () => {
    expect(validateProjectForm(values)).toEqual({
      ok: true,
      payload: { name: 'P', client: 'C', crsEpsg: 32636, currency: 'EGP', locale: 'ar' },
    });
  });

  it('flags a non-UTM CRS and empty names', () => {
    expect(validateProjectForm({ ...values, name: ' ', crsEpsg: '4326' })).toEqual({
      ok: false,
      errors: { name: 'validation.required', crsEpsg: 'admin.validation.crs' },
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
