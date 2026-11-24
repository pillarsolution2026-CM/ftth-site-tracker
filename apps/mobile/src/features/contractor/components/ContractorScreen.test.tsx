import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { ContractorPortalResponse, MeResponse } from '@ftth/shared';
import { translate } from '@ftth/i18n';
import { testRandom } from '../../../shared/crypto/test-random';
import { createVault } from '../../../shared/crypto/vault';
import { I18nProvider } from '../../../shared/i18n/I18nProvider';
import { InMemoryLocaleStorage } from '../../../shared/storage/locale-storage';
import { ApiError, type AuthApi } from '../../auth/api/api-client';
import { AuthProvider } from '../../auth/hooks/AuthProvider';
import { createOfflineProfile } from '../model/offline-profile';
import {
  createPortalCache,
  PORTAL_CACHE_FILE,
  PORTAL_CACHE_MAX_AGE_MS,
} from '../model/portal-cache';
import { HomeSwitch } from './HomeSwitch';

jest.mock('expo-router', () => ({ useRouter: () => ({ replace: jest.fn(), push: jest.fn() }) }));

const ID = (n: number) => `3f0c1c1e-6d1f-4a39-8a3e-7a0c2f1b9d${String(n).padStart(2, '0')}`;
const has = (text: string) => new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
const ar = (key: Parameters<typeof translate>[1]) => translate('ar', key);

const CONTRACTOR_ME: MeResponse = {
  id: ID(1),
  email: 'c@example.com',
  displayName: 'Contractor user',
  locale: 'ar',
  isAdmin: false,
  memberships: [],
  contractor: { id: ID(2), name: 'Delta Fibre' },
};
const SUPERVISOR_ME: MeResponse = {
  ...CONTRACTOR_ME,
  displayName: 'Mona',
  contractor: null,
  memberships: [
    { projectId: ID(9), projectName: 'North ring', role: 'supervisor', zoneIds: [], siteIds: [] },
  ],
};

const PORTAL: ContractorPortalResponse = {
  serverTime: '2026-11-21T10:30:00+00:00',
  contractor: { id: ID(2), name: 'Delta Fibre' },
  totals: [{ currency: 'EGP', approved: '100.5', pending: '2250.125', rejected: '30' }],
  registrations: [
    {
      registrationId: ID(3),
      projectId: ID(4),
      projectName: 'North ring',
      workOrderNumber: 'WO-7',
      currency: 'EGP',
      registeredOn: '2026-10-01',
      lines: [
        {
          contractorLineId: ID(5),
          code: 'DUCT-01',
          description: 'Duct laying',
          unit: 'm',
          scope: null,
          quantity: '500',
          prices: [
            { effectiveFrom: '2026-01-01', unitPrice: '1.5' },
            { effectiveFrom: '2026-11-01', unitPrice: '1.75' },
          ],
          recordedQuantity: '120.5',
        },
      ],
    },
  ],
  work: [
    {
      key: 'u1:1',
      registrationId: ID(3),
      contractorLineId: ID(5),
      element: { featureType: 'route', code: 'R-12' },
      workDate: '2026-11-20',
      quantity: '40',
      status: 'pending',
      reviewReason: null,
      unitPrice: '1.75',
      value: '70',
    },
    {
      key: 'u2:1',
      registrationId: ID(3),
      contractorLineId: ID(5),
      element: { featureType: 'route', code: 'R-11' },
      workDate: '2026-11-10',
      quantity: '20',
      status: 'rejected',
      reviewReason: 'Depth too low',
      unitPrice: '1.5',
      value: '30',
    },
    {
      key: 'u3:1',
      registrationId: ID(3),
      contractorLineId: ID(5),
      element: { featureType: 'route', code: null },
      workDate: '2026-11-05',
      quantity: '67',
      status: 'approved',
      reviewReason: null,
      unitPrice: '1.5',
      value: '100.5',
    },
  ],
};

function memoryFiles() {
  const files = new Map<string, string>();
  return {
    files,
    api: {
      readText: async (name: string) => files.get(name) ?? null,
      writeText: async (name: string, text: string) => void files.set(name, text),
      deleteText: async (name: string) => void files.delete(name),
    },
  };
}

async function setup(
  me: MeResponse,
  contractorPortal: () => Promise<ContractorPortalResponse>,
  seeded = false,
) {
  const { files, api: fileApi } = memoryFiles();
  const vault = createVault(async () => new Uint8Array(32).fill(7), testRandom);
  const cache = createPortalCache(vault, fileApi, () => Date.parse(PORTAL.serverTime));
  if (seeded) await cache.write({ me, portal: PORTAL });
  const logout = jest.fn(async () => undefined);
  const auth: AuthApi = {
    login: jest.fn(),
    me: async () => me,
    contractorPortal,
    logout,
    hasSession: async () => true,
    accessToken: async () => 'token',
    refreshSession: async () => true,
  };
  const onOpenProject = jest.fn();
  await render(
    <I18nProvider storage={new InMemoryLocaleStorage()}>
      <AuthProvider api={auth} onSignedOut={() => cache.clear()}>
        <HomeSwitch onOpenProject={onOpenProject} portalApi={auth} portalCache={cache} />
      </AuthProvider>
    </I18nProvider>,
  );
  return { files, cache, logout, auth };
}

describe('contractor home routing', () => {
  it('opens the read-only contractor screen, not the projects, for a contractor account', async () => {
    await setup(CONTRACTOR_ME, async () => PORTAL);
    expect(await screen.findByTestId('portal-name')).toHaveTextContent('Delta Fibre');
    expect(screen.queryByTestId(`project-${ID(9)}`)).toBeNull();
  });

  it('keeps the projects list for a supervisor and never asks for the portal', async () => {
    const portal = jest.fn(async () => PORTAL);
    await setup(SUPERVISOR_ME, portal);
    expect(await screen.findByTestId(`project-${ID(9)}`)).toBeTruthy();
    expect(screen.queryByTestId('portal-name')).toBeNull();
    expect(portal).not.toHaveBeenCalled();
  });
});

describe('ContractorScreen', () => {
  it('shows three separate totals, his lines and the work, newest first, as exact strings', async () => {
    await setup(CONTRACTOR_ME, async () => PORTAL);
    const totals = await screen.findByTestId('totals-EGP');
    expect(totals).toHaveTextContent(has(ar('mobileContractor.approved')));
    expect(totals).toHaveTextContent(has('100.5 EGP'));
    expect(totals).toHaveTextContent(has('2250.125 EGP'));
    expect(totals).toHaveTextContent(has('30 EGP'));
    expect(totals).toHaveTextContent(has(ar('mobileContractor.pending')));
    expect(totals).toHaveTextContent(has(ar('mobileContractor.rejected')));

    const line = screen.getByTestId(`line-${ID(5)}`);
    expect(line).toHaveTextContent(has('DUCT-01'));
    expect(line).toHaveTextContent(has('Duct laying'));
    expect(line).toHaveTextContent(has(ar('mobileContractor.wholeLine')));
    expect(line).toHaveTextContent(has('500'));
    expect(line).toHaveTextContent(has('120.5'));
    expect(line).toHaveTextContent(has('1.75 EGP'));

    const first = screen.getByTestId('work-u1:1');
    expect(first).toHaveTextContent(has('2026-11-20'));
    expect(first).toHaveTextContent(has('R-12'));
    expect(first).toHaveTextContent(has('70 EGP'));
    expect(screen.getByTestId('work-u2:1')).toHaveTextContent(has('Depth too low'));
    expect(screen.getByTestId('portal-updated')).toBeTruthy();
  });

  it('filters the work by status', async () => {
    await setup(CONTRACTOR_ME, async () => PORTAL);
    await screen.findByTestId('work-u1:1');
    await fireEvent.press(screen.getByTestId('filter-rejected'));
    expect(screen.queryByTestId('work-u1:1')).toBeNull();
    expect(screen.getByTestId('work-u2:1')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('filter-approved'));
    expect(screen.getByTestId('work-u3:1')).toBeTruthy();
    expect(screen.queryByTestId('work-u2:1')).toBeNull();
    await fireEvent.press(screen.getByTestId('filter-all'));
    expect(screen.getByTestId('work-u1:1')).toBeTruthy();
  });

  it('keeps the last answer sealed on the phone, never as plain JSON', async () => {
    const { files } = await setup(CONTRACTOR_ME, async () => PORTAL);
    await screen.findByTestId('totals-EGP');
    await waitFor(() => expect(files.has(PORTAL_CACHE_FILE)).toBe(true));
    const stored = files.get(PORTAL_CACHE_FILE) ?? '';
    expect(stored.startsWith('v1:')).toBe(true);
    expect(stored).not.toContain('Delta Fibre');
    expect(stored).not.toContain('DUCT-01');
    expect(stored).not.toContain('{');
  });

  it('shows the cached answer with its time when the fetch fails (offline)', async () => {
    await setup(
      CONTRACTOR_ME,
      async () => {
        throw new ApiError('NETWORK', 0);
      },
      true,
    );
    expect(await screen.findByTestId('totals-EGP')).toHaveTextContent(has('2250.125 EGP'));
    expect(screen.getByTestId('portal-offline')).toBeTruthy();
    expect(screen.getByTestId('portal-updated')).toBeTruthy();
    expect(screen.queryByTestId('portal-failed')).toBeNull();
  });

  it('says so when offline with nothing saved yet', async () => {
    await setup(CONTRACTOR_ME, async () => {
      throw new ApiError('NETWORK', 0);
    });
    expect(await screen.findByTestId('portal-failed')).toBeTruthy();
  });

  it('clears the cache and goes back to login on 403', async () => {
    const { files, logout } = await setup(
      CONTRACTOR_ME,
      async () => {
        throw new ApiError('FORBIDDEN', 403);
      },
      true,
    );
    await waitFor(() => expect(logout).toHaveBeenCalled());
    expect(files.has(PORTAL_CACHE_FILE)).toBe(false);
  });

  it('clears the cache on logout', async () => {
    const { files, logout } = await setup(CONTRACTOR_ME, async () => PORTAL);
    await screen.findByTestId('totals-EGP');
    await waitFor(() => expect(files.has(PORTAL_CACHE_FILE)).toBe(true));
    await fireEvent.press(screen.getByTestId('portal-logout'));
    await waitFor(() => expect(logout).toHaveBeenCalled());
    expect(files.has(PORTAL_CACHE_FILE)).toBe(false);
  });
});

describe('portal cache', () => {
  it('returns null for an altered or foreign file', async () => {
    const { files, api } = memoryFiles();
    const vault = createVault(async () => new Uint8Array(32).fill(7), testRandom);
    const cache = createPortalCache(vault, api);
    await cache.write({ me: CONTRACTOR_ME, portal: PORTAL });
    expect((await cache.read())?.portal.contractor.name).toBe('Delta Fibre');
    files.set(PORTAL_CACHE_FILE, JSON.stringify({ me: CONTRACTOR_ME, portal: PORTAL }));
    expect(await cache.read()).toBeNull();
  });
});

describe('offline snapshot safety', () => {
  const vault = createVault(async () => new Uint8Array(32).fill(7), testRandom);
  const jwt = (sub: string) =>
    `h.${btoa(JSON.stringify({ sub })).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')}.s`;
  const serverMs = Date.parse(PORTAL.serverTime);

  it('refuses and wipes a snapshot older than the maximum age', async () => {
    const { files, api } = memoryFiles();
    const fresh = createPortalCache(vault, api, () => serverMs + PORTAL_CACHE_MAX_AGE_MS);
    await fresh.write({ me: CONTRACTOR_ME, portal: PORTAL });
    expect(await fresh.read()).not.toBeNull();
    const stale = createPortalCache(vault, api, () => serverMs + PORTAL_CACHE_MAX_AGE_MS + 1);
    expect(await stale.read()).toBeNull();
    expect(files.has(PORTAL_CACHE_FILE)).toBe(false);
  });

  it('signs in offline only when the cached profile is the stored session user', async () => {
    const { files, api } = memoryFiles();
    const cache = createPortalCache(vault, api, () => serverMs);
    await cache.write({ me: CONTRACTOR_ME, portal: PORTAL });
    expect(await createOfflineProfile(cache, async () => jwt(CONTRACTOR_ME.id))()).toEqual(
      CONTRACTOR_ME,
    );
    expect(await createOfflineProfile(cache, async () => jwt(ID(77)))()).toBeNull();
    expect(files.has(PORTAL_CACHE_FILE)).toBe(false);

    await cache.write({ me: CONTRACTOR_ME, portal: PORTAL });
    expect(await createOfflineProfile(cache, async () => null)()).toBeNull();
    expect(files.has(PORTAL_CACHE_FILE)).toBe(false);
  });

  it('refuses an expired snapshot for the offline profile', async () => {
    const { files, api } = memoryFiles();
    await createPortalCache(vault, api, () => serverMs).write({
      me: CONTRACTOR_ME,
      portal: PORTAL,
    });
    const late = createPortalCache(vault, api, () => serverMs + PORTAL_CACHE_MAX_AGE_MS + 1);
    expect(await createOfflineProfile(late, async () => jwt(CONTRACTOR_ME.id))()).toBeNull();
    expect(files.has(PORTAL_CACHE_FILE)).toBe(false);
  });
});
