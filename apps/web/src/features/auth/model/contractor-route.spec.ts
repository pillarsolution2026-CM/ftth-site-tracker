import { describe, expect, it } from 'vitest';
import type { MeResponse } from '@ftth/shared';
import { routeRedirect } from './contractor-route';

const base: MeResponse = {
  id: '0f8fad5b-d9cb-469f-a165-70867728950e',
  email: 'a@b.co',
  displayName: 'A',
  locale: 'en',
  isAdmin: false,
  memberships: [],
  contractor: null,
};
const contractor: MeResponse = {
  ...base,
  contractor: { id: '3c1c9f2e-6b3d-4e8a-9c7f-2d4b6a8c0e1f', name: 'Nile Cables' },
};

describe('routeRedirect', () => {
  it('sends a contractor from every other page to his own page', () => {
    expect(routeRedirect(contractor, '/ar', 'ar')).toBe('/ar/contractor');
    expect(routeRedirect(contractor, '/ar/admin/projects', 'ar')).toBe('/ar/contractor');
    expect(routeRedirect(contractor, '/en/projects/x/contractors', 'en')).toBe('/en/contractor');
  });

  it('leaves a contractor on his own page', () => {
    expect(routeRedirect(contractor, '/fr/contractor', 'fr')).toBeNull();
  });

  it('keeps other users off the contractor page and leaves their pages alone', () => {
    expect(routeRedirect(base, '/en/contractor', 'en')).toBe('/en');
    expect(routeRedirect(base, '/en/admin/projects', 'en')).toBeNull();
    expect(routeRedirect({ ...base, isAdmin: true }, '/en', 'en')).toBeNull();
  });
});
