import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import LokiJSAdapter from '@nozbe/watermelondb/adapters/lokijs';
import { createProjectCrs } from '@ftth/geo';
import { ltr, translate } from '@ftth/i18n';
import type { OfflineBundle, OpRejectionCode, SyncPushRequest } from '@ftth/shared';
import { testRandom } from '../../../shared/crypto/test-random';
import { createVault } from '../../../shared/crypto/vault';
import { I18nProvider } from '../../../shared/i18n/I18nProvider';
import { InMemoryLocaleStorage } from '../../../shared/storage/locale-storage';
import { CadScreen } from '../../cad/components/CadScreen';
import { PendingScreen } from '../../sync/components/PendingScreen';
import { createLocalDatabase } from '../../sync/db/database';
import { localSchema } from '../../sync/db/schema';
import { FieldProvider, type FieldDeps } from '../../sync/hooks/FieldProvider';
import type { CapturedPhoto, UpdateTarget } from '../model/update-wizard';
import { UpdateWizardScreen, type UpdateWizardDeps } from './UpdateWizardScreen';

/**
 * The supervisor's flow on the real components and the real local database (LokiJS adapter of
 * WatermelonDB), against a fake API: download the drawing, pick the box under the crosshair, go
 * through the 6 steps, save offline, then sync when the network returns.
 */

const t = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) =>
  translate('ar', key, params);

const PROJECT = '00000000-0000-4000-8000-0000000000a1';
const USER = '00000000-0000-4000-8000-0000000000e1';
const REVISION = '00000000-0000-4000-8000-0000000000a2';
const BOX = '00000000-0000-4000-8000-0000000000a3';
const ITEM = '00000000-0000-4000-8000-0000000000a4';
const DRAWING_1 = '00000000-0000-4000-8000-0000000000b1';
const DRAWING_2 = '00000000-0000-4000-8000-0000000000b2';
const CONTRACTOR_A = '00000000-0000-4000-8000-0000000000e2';
const CONTRACTOR_B = '00000000-0000-4000-8000-0000000000e3';
const SITE = '00000000-0000-4000-8000-0000000000b3';
const E = 330_000;
const N = 3_340_000;

const bundle: OfflineBundle = {
  serverTime: '2026-10-30T08:00:00.000Z',
  project: { id: PROJECT, name: 'قليوب', crsEpsg: 32636 },
  scope: { kind: 'sites', siteIds: ['00000000-0000-4000-8000-0000000000a5'] },
  drawings: [],
  // (the drawings tests below build their own bundles with `withDrawings`)
  revision: {
    id: REVISION,
    revNo: 1,
    publishedAt: '2026-10-29T08:00:00.000Z',
    tilesAvailable: true,
  },
  features: [
    {
      id: BOX,
      type: 'box',
      code: '1-1',
      layer: 'sub',
      geometry: { type: 'Point', coordinates: [E, N] },
      lengthM: null,
    },
  ],
  asBuilt: [],
  elementGroups: [],
  catalog: [
    {
      id: ITEM,
      workOrderId: '00000000-0000-4000-8000-0000000000a6',
      workOrderNumber: 'WO-1',
      lineNo: 1,
      code: 'C-01',
      description: 'تركيب صندوق',
      unit: 'عدد',
      quantity: '10',
      workType: 'civil',
      recordedQuantity: '0',
      group: null,
      needsDimensions: false,
      contractors: [
        {
          contractorLineId: CONTRACTOR_A,
          contractorId: '00000000-0000-4000-8000-0000000000d2',
          contractorName: 'شركة الأمل',
          scope: 'حفر',
          quantity: '20',
          recordedQuantity: '15',
          // ADR-057: offered on work dates from 25 Oct on.
          registeredOn: '2026-10-25',
        },
        {
          contractorLineId: CONTRACTOR_B,
          contractorId: '00000000-0000-4000-8000-0000000000d3',
          contractorName: 'شركة النور',
          scope: null,
          quantity: '50',
          recordedQuantity: '0',
          registeredOn: null,
        },
      ],
    },
  ],
  settings: {
    gpsWarningDistanceM: 50,
    suggestedQuantity: 'unavailable',
    photoRequirements: {
      status: 'unavailable',
      byWorkType: {},
      fallback: [{ key: 'general', minCount: 1 }],
    },
  },
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

class FakeApi {
  online = true;
  pushes: SyncPushRequest[] = [];
  uploaded = new Map<string, number>();
  /** The drawingId of each bootstrap request (null: none asked). */
  bootstraps: (string | null)[] = [];
  failDrawings = new Set<string>();
  /** Refuse every pushed op with this code (null: apply them). */
  rejectWith: OpRejectionCode | null = null;
  /** Drawings the server lists; empty keeps the single-drawing bundle of the older tests. */
  drawings: OfflineBundle['drawings'] = [];
  /** Scope the server reports (ADR-054); null keeps the bundle's own. */
  scope: OfflineBundle['scope'] | null = null;

  bundleFor(asked: string | null): OfflineBundle {
    if (this.scope) return { ...bundle, scope: this.scope, drawings: this.drawings };
    if (this.drawings.length === 0) return bundle;
    const held = asked ?? DRAWING_1;
    const entry = this.drawings.find((d) => d.drawingId === held);
    return {
      ...bundle,
      drawings: this.drawings,
      revision: entry ? { ...entry.revision, drawingId: held } : null,
    };
  }

  fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (!this.online) throw new TypeError('Network request failed');
    const url = String(input);
    if (url.includes('/sync/bootstrap')) {
      const asked = /drawingId=([^&]+)/.exec(url)?.[1] ?? null;
      this.bootstraps.push(asked);
      if (asked !== null && this.failDrawings.has(asked)) return json(500, { code: 'X' });
      return json(200, this.bundleFor(asked));
    }
    if (url.endsWith('/sync/push')) {
      const request = JSON.parse(String(init?.body)) as SyncPushRequest;
      this.pushes.push(request);
      return json(200, {
        serverTime: '2026-10-30T09:00:00.000Z',
        results: request.ops.map((op, i) =>
          this.rejectWith
            ? { clientOpId: op.clientOpId, outcome: 'rejected', code: this.rejectWith }
            : {
                clientOpId: op.clientOpId,
                outcome: 'applied',
                updateId: `00000000-0000-4000-8000-00000000${String(i).padStart(4, '0')}`,
              },
        ),
      });
    }
    if (url.includes('/sync/changes')) {
      return json(200, {
        serverTime: '2026-10-30T09:00:00.000Z',
        cursor: '1',
        hasMore: false,
        updates: [],
        asBuiltEdits: [],
      });
    }
    const photo = /\/sync\/photos\/([^/]+)(\/content)?$/.exec(url);
    if (photo?.[1]) {
      const id = photo[1];
      if (photo[2]) this.uploaded.set(id, (init?.body as Uint8Array).length);
      const received = this.uploaded.get(id) ?? 0;
      return json(200, {
        photoId: id,
        sizeBytes: 4,
        receivedBytes: received,
        state: received === 4 ? 'stored' : 'receiving',
      });
    }
    return json(404, { code: 'NOT_FOUND', message: url });
  });
}

function setup() {
  const api = new FakeApi();
  const files = new Map<string, string>();
  const listeners: { online: (() => void)[] } = { online: [] };
  const deps: FieldDeps = {
    db: createLocalDatabase(
      new LokiJSAdapter({
        schema: localSchema,
        useWebWorker: false,
        useIncrementalIndexedDB: false,
        dbName: `flow-${Math.random()}`,
      }),
    ),
    baseUrl: 'http://api.test',
    files: {
      readText: async (name) => files.get(name) ?? null,
      writeText: async (name, text) => void files.set(name, text),
    },
    readFileBytes: async () => vault.sealBytes(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9])),
    vault,
    accessToken: async () => 'token',
    refreshSession: async () => true,
    deviceId: async () => '00000000-0000-4000-8000-0000000000d1',
    onOnline: (callback) => {
      listeners.online.push(callback);
      return () => undefined;
    },
    onForeground: () => () => undefined,
    fetchFn: api.fetch as unknown as typeof fetch,
  };
  return { api, deps, files, goOnline: () => listeners.online.forEach((cb) => cb()) };
}

const vault = createVault(async () => new Uint8Array(32).fill(3), testRandom);

const crs = createProjectCrs(32636);
const photo: CapturedPhoto = {
  photoId: '00000000-0000-4000-8000-0000000000f1',
  requirementKey: 'general',
  fileUri: 'file:///photos/f1.jpg',
  sha256: 'b'.repeat(64),
  sizeBytes: 4,
  takenAt: '2026-10-30T08:30:00.000Z',
  gps: null,
};

function wizardDeps(): UpdateWizardDeps {
  // 120 m from the box: farther than the 50 m warning distance.
  const { lon, lat } = crs.toWgs84({ x: E + 120, y: N });
  return {
    capturePhoto: jest.fn(async () => photo),
    locate: jest.fn(async () => ({ lon, lat, accuracyM: 6, at: '2026-10-30T08:30:00.000Z' })),
    newId: () => '00000000-0000-4000-8000-0000000000c1',
    now: () => new Date('2026-10-30T08:31:00.000Z'),
    author: 'مشرف',
  };
}

// Full screen flows (render, LokiJS, encryption, sync) take well under a second alone but share a
// small CI runner with every other package's tests; one hit Jest's 5 s default there (PR #22 CI).
jest.setTimeout(30_000);

describe('supervisor field flow', () => {
  it('downloads the drawing and shows the box under the crosshair with its E/N', async () => {
    const { deps, files } = setup();
    const onUpdate = jest.fn();
    await render(
      <I18nProvider storage={new InMemoryLocaleStorage()}>
        <FieldProvider projectId={PROJECT} userId={USER} deps={deps}>
          <CadScreen onUpdate={onUpdate} onOpenPending={() => undefined} />
        </FieldProvider>
      </I18nProvider>,
    );
    await fireEvent.press(await screen.findByTestId('download-bundle'));
    const area = await screen.findByTestId('cad-area');
    // The drawing is cached sealed: no coordinates or names in clear on the phone.
    const cached = files.get(`bundle-${USER}-${PROJECT}.json`) ?? '';
    expect(cached.startsWith('v1:')).toBe(true);
    expect(cached).not.toContain('قليوب');
    // Layout gives the canvas a size; the viewport fits the single box at the centre.
    await fireEvent(area, 'layout', {
      nativeEvent: { layout: { x: 0, y: 0, width: 400, height: 600 } },
    });
    expect(await screen.findByTestId('cad-canvas')).toBeTruthy();
    expect(await screen.findByTestId('feature-card')).toBeTruthy();
    expect(screen.getByTestId('coordinates').props.children).toContain('330000.00');
    await fireEvent.press(screen.getByTestId('update-button'));
    expect(onUpdate).toHaveBeenCalledWith(BOX);
    // Layers: hiding boxes leaves nothing under the crosshair.
    await fireEvent.press(screen.getByTestId('layers-toggle'));
    await fireEvent.press(screen.getByTestId('layer-box'));
    expect(await screen.findByText(t('field.cad.nothingUnderCrosshair'))).toBeTruthy();
    await fireEvent.press(screen.getByTestId('mode-toggle'));
  });

  it('records an update through the 6 steps offline and syncs it when the network returns', async () => {
    const { api, deps, files, goOnline } = setup();
    files.set(`bundle-${USER}-${PROJECT}.json`, await vault.sealText(JSON.stringify(bundle)));
    api.online = false;
    const onDone = jest.fn();
    const wizard = wizardDeps();
    await render(
      <I18nProvider storage={new InMemoryLocaleStorage()}>
        <FieldProvider projectId={PROJECT} userId={USER} deps={deps}>
          <UpdateWizardScreen
            target={{ kind: 'feature', feature: bundle.features[0] ?? (undefined as never) }}
            deps={wizard}
            onDone={onDone}
            onCancel={() => undefined}
          />
          <PendingScreen onBack={() => undefined} />
        </FieldProvider>
      </I18nProvider>,
    );

    // 1 activity
    expect(await screen.findByTestId('step-indicator')).toBeTruthy();
    expect(screen.getByTestId('wizard-next').props.accessibilityState.disabled).toBe(true);
    await fireEvent.press(screen.getByTestId('activity-civil'));
    await fireEvent.press(screen.getByTestId('wizard-next'));
    // 2 work items: stepper buttons, no keyboard
    await fireEvent.press(await screen.findByTestId('work-C-01-self-+1'));
    await fireEvent.press(screen.getByTestId('work-C-01-self-+1'));
    expect(screen.getByTestId('work-C-01-self-qty').props.children).toContain('2');
    await fireEvent.press(screen.getByTestId('wizard-next'));
    // 3 materials (may stay empty because step 2 has a line)
    await fireEvent.press(screen.getByTestId('wizard-next'));
    // 4 label & location
    expect(await screen.findByTestId('label-input')).toBeTruthy();
    await fireEvent.changeText(screen.getByTestId('note-input'), 'حفر يدوي');
    await fireEvent.press(screen.getByTestId('wizard-next'));
    // 5 photos: mandatory
    expect(screen.getByTestId('wizard-next').props.accessibilityState.disabled).toBe(true);
    await fireEvent.press(screen.getByTestId('take-photo-general'));
    await waitFor(() =>
      expect(screen.getByTestId('wizard-next').props.accessibilityState.disabled).toBe(false),
    );
    await fireEvent.press(screen.getByTestId('wizard-next'));
    // 6 review: GPS is 120 m away → warning that must be acknowledged before saving
    expect(await screen.findByTestId('warning-GPS_FAR')).toBeTruthy();
    expect(screen.getByTestId('wizard-save').props.accessibilityState.disabled).toBe(true);
    await fireEvent.press(screen.getByTestId('acknowledge'));
    await fireEvent.press(screen.getByTestId('wizard-save'));
    await waitFor(() => expect(onDone).toHaveBeenCalled());

    // Saved on the device while offline; the status bar says so.
    expect(await screen.findAllByText(new RegExp(t('field.sync.offline')))).toBeTruthy();
    expect(screen.getAllByText(/لم يُرسل/).length).toBeGreaterThan(0);
    expect(api.pushes).toHaveLength(0);

    // Network back → the outbox drains, the photo is uploaded, the entry shows as on the server.
    api.online = true;
    await act(async () => {
      goOnline();
    });
    await waitFor(() => expect(api.pushes).toHaveLength(1));
    const op = api.pushes[0]?.ops[0];
    expect(op).toMatchObject({
      clientOpId: '00000000-0000-4000-8000-0000000000c1',
      capturedAt: '2026-10-30T08:31:00.000Z',
      payload: {
        featureId: BOX,
        designRevisionId: REVISION,
        workType: 'civil',
        lines: [
          { workOrderItemId: ITEM, quantity: '2', role: 'work', performer: { kind: 'self' } },
        ],
        note: 'حفر يدوي',
        label: '1-1',
        acknowledgedWarnings: ['GPS_FAR'],
      },
    });
    await waitFor(() => expect(api.uploaded.get(photo.photoId)).toBe(4));
    expect(await screen.findAllByText(/وصل للخادم/)).toBeTruthy();
  });

  describe('contractor of each work line (ADR-052)', () => {
    const press = (id: string) => fireEvent.press(screen.getByTestId(id));
    const disabled = (id: string) => screen.getByTestId(id).props.accessibilityState.disabled;

    /** One wizard after another: the second opens when the first is saved (same outbox). */
    function Harness({ wizard }: { wizard: UpdateWizardDeps }) {
      const [round, setRound] = useState(1);
      return (
        <UpdateWizardScreen
          key={round}
          target={{ kind: 'feature', feature: bundle.features[0] ?? (undefined as never) }}
          deps={{ ...wizard, newId: () => `00000000-0000-4000-8000-0000000000c${round}` }}
          onDone={() => setRound((r) => r + 1)}
          onCancel={() => undefined}
        />
      );
    }

    async function openWork() {
      const ctx = setup();
      ctx.files.set(`bundle-${USER}-${PROJECT}.json`, await vault.sealText(JSON.stringify(bundle)));
      ctx.api.online = false;
      await render(
        <I18nProvider storage={new InMemoryLocaleStorage()}>
          <FieldProvider projectId={PROJECT} userId={USER} deps={ctx.deps}>
            <Harness wizard={wizardDeps()} />
            <PendingScreen onBack={() => undefined} />
          </FieldProvider>
        </I18nProvider>,
      );
      await fireEvent.press(await screen.findByTestId('activity-civil'));
      await press('wizard-next');
      await screen.findByTestId(`work-C-01-${CONTRACTOR_A}`);
      return ctx;
    }

    /** From the work step to the saved update. */
    async function finish() {
      await press('wizard-next'); // materials (may stay empty)
      await press('wizard-next'); // location
      await press('wizard-next'); // photos
      await press('take-photo-general');
      await waitFor(() => expect(disabled('wizard-next')).toBe(false));
      await press('wizard-next');
      await press('acknowledge');
      await press('wizard-save');
    }

    it('offers each contractor of the line with scope and quantity left, and the company itself', async () => {
      await openWork();
      expect(screen.getByText('شركة الأمل')).toBeTruthy();
      expect(screen.getByText(new RegExp('نطاق الشغل: حفر'))).toBeTruthy();
      expect(screen.getByText(new RegExp(t('field.update.performerWholeLine')))).toBeTruthy();
      expect(
        screen.getByText(
          new RegExp(t('field.update.performerLeft', { left: ltr('5'), unit: 'عدد' })),
        ),
      ).toBeTruthy();
      expect(screen.getByText(t('field.update.performerSelf'))).toBeTruthy();
      expect(screen.getByTestId('work-C-01-self')).toBeTruthy();
    });

    it('splits one line between two contractors and the company, and sends each performer', async () => {
      const { api, goOnline } = await openWork();
      for (let i = 0; i < 3; i++) await press(`work-C-01-${CONTRACTOR_A}-+1`);
      await press(`work-C-01-${CONTRACTOR_B}-+10`);
      await press('work-C-01-self-+1');
      expect(disabled('wizard-next')).toBe(false);
      await finish();
      await waitFor(() => expect(screen.getAllByText(/لم يُرسل/).length).toBeGreaterThan(0));
      api.online = true;
      await act(async () => {
        goOnline();
      });
      await waitFor(() => expect(api.pushes).toHaveLength(1));
      expect(api.pushes[0]?.ops[0]).toMatchObject({
        payload: {
          lines: [
            {
              workOrderItemId: ITEM,
              quantity: '3',
              role: 'work',
              performer: { kind: 'contractor', contractorLineId: CONTRACTOR_A },
            },
            {
              workOrderItemId: ITEM,
              quantity: '10',
              role: 'work',
              performer: { kind: 'contractor', contractorLineId: CONTRACTOR_B },
            },
            { workOrderItemId: ITEM, quantity: '1', role: 'work', performer: { kind: 'self' } },
          ],
        },
      });
    });

    it('picks an earlier work date, hides a contractor not yet registered then, and sends the date (ADR-057)', async () => {
      const { api, goOnline } = await openWork();
      // Today in Cairo (the clock says 30 Oct, 10:31 in Cairo); no later day.
      expect(screen.getByTestId('work-date-input').props.value).toBe('2026-10-30');
      expect(disabled('work-date-next')).toBe(true);
      await act(async () => {
        fireEvent.changeText(screen.getByTestId('work-date-input'), '2026-11-02');
      });
      expect(screen.getByTestId('work-date-invalid')).toBeTruthy();
      await act(async () => {
        fireEvent.changeText(screen.getByTestId('work-date-input'), '2026-10-20');
      });
      expect(screen.queryByTestId('work-date-invalid')).toBeNull();
      // شركة الأمل is registered from 25 Oct: not offered on the 20th. The other one and the
      // company itself stay.
      expect(screen.queryByTestId(`work-C-01-${CONTRACTOR_A}`)).toBeNull();
      expect(screen.getByTestId(`work-C-01-${CONTRACTOR_B}`)).toBeTruthy();
      await press('work-date-previous');
      expect(screen.getByTestId('work-date-input').props.value).toBe('2026-10-19');
      await press('work-C-01-self-+1');
      await finish();
      await waitFor(() => expect(screen.getAllByText(/لم يُرسل/).length).toBeGreaterThan(0));
      api.online = true;
      await act(async () => {
        goOnline();
      });
      await waitFor(() => expect(api.pushes).toHaveLength(1));
      expect(api.pushes[0]?.ops[0]).toMatchObject({ payload: { workDate: '2026-10-19' } });
    });

    it('blocks a quantity above what is left of the contractor; the company itself has no limit', async () => {
      await openWork();
      // Bundle: 20 - 15 = 5 left. 6 is refused, naming the contractor and what is left.
      for (let i = 0; i < 6; i++) await press(`work-C-01-${CONTRACTOR_A}-+1`);
      const message = await screen.findByTestId(`contractor-exceeded-${CONTRACTOR_A}`);
      expect(JSON.stringify(message.props.children)).toContain('شركة الأمل');
      expect(screen.getByTestId('problem-CONTRACTOR_QUANTITY_EXCEEDED')).toBeTruthy();
      expect(disabled('wizard-next')).toBe(true);
      await press(`work-C-01-${CONTRACTOR_A}--1`);
      expect(screen.queryByTestId(`contractor-exceeded-${CONTRACTOR_A}`)).toBeNull();
      expect(disabled('wizard-next')).toBe(false);
      await press('work-C-01-self-+10');
      expect(disabled('wizard-next')).toBe(false);
    });

    it('counts the own unsent updates of the phone in what is left', async () => {
      await openWork();
      for (let i = 0; i < 4; i++) await press(`work-C-01-${CONTRACTOR_A}-+1`);
      await finish();
      // Second wizard: 5 - 4 = 1 left.
      await fireEvent.press(await screen.findByTestId('activity-civil'));
      await press('wizard-next');
      await screen.findByTestId(`work-C-01-${CONTRACTOR_A}`);
      expect(
        screen.getByText(
          new RegExp(t('field.update.performerLeft', { left: ltr('1'), unit: 'عدد' })),
        ),
      ).toBeTruthy();
      await press(`work-C-01-${CONTRACTOR_A}-+1`);
      expect(screen.queryByTestId(`contractor-exceeded-${CONTRACTOR_A}`)).toBeNull();
      await press(`work-C-01-${CONTRACTOR_A}-+1`);
      expect(await screen.findByTestId(`contractor-exceeded-${CONTRACTOR_A}`)).toBeTruthy();
      expect(disabled('wizard-next')).toBe(true);
    });

    it('records material lines without a performer', async () => {
      const { api, goOnline } = await openWork();
      await press('work-C-01-self-+1');
      await press('wizard-next');
      await press('material-C-01-+1');
      await finish();
      api.online = true;
      await act(async () => {
        goOnline();
      });
      await waitFor(() => expect(api.pushes).toHaveLength(1));
      expect(api.pushes[0]?.ops[0]).toMatchObject({
        payload: {
          lines: [
            { role: 'work', performer: { kind: 'self' } },
            { role: 'material', performer: null },
          ],
        },
      });
    });

    it('shows the translated reason when the server refuses a contractor quantity', async () => {
      const { api, goOnline } = await openWork();
      api.rejectWith = 'CONTRACTOR_QUANTITY_EXCEEDED';
      await press(`work-C-01-${CONTRACTOR_A}-+1`);
      await finish();
      api.online = true;
      await act(async () => {
        goOnline();
      });
      expect(
        await screen.findByText(t('field.pending.rejections.CONTRACTOR_QUANTITY_EXCEEDED')),
      ).toBeTruthy();
    });

    it('translates both refusal codes in Arabic, English and French', () => {
      for (const locale of ['ar', 'en', 'fr'] as const) {
        for (const code of ['CONTRACTOR_LINE_NOT_FOUND', 'CONTRACTOR_QUANTITY_EXCEEDED'] as const) {
          const key = `field.pending.rejections.${code}` as const;
          expect(translate(locale, key)).not.toBe(key);
        }
      }
    });
  });

  describe('drawings', () => {
    const drawing = (drawingId: string, kind: 'general' | 'secondary', ordinal: number) => ({
      drawingId,
      siteId: SITE,
      siteName: 'Alpha',
      kind,
      ordinal,
      revision: {
        id: drawingId.replace(/b(\d)$/, 'c$1'),
        revNo: 1,
        publishedAt: '2026-10-29T08:00:00.000Z',
        tilesAvailable: false,
      },
    });
    const renderScreen = async (deps: FieldDeps) =>
      render(
        <I18nProvider storage={new InMemoryLocaleStorage()}>
          <FieldProvider projectId={PROJECT} userId={USER} deps={deps}>
            <CadScreen onUpdate={() => undefined} onOpenPending={() => undefined} />
          </FieldProvider>
        </I18nProvider>,
      );

    it('downloads the other drawings in the background and keeps the open one', async () => {
      const { api, deps, files } = setup();
      api.drawings = [drawing(DRAWING_1, 'general', 1), drawing(DRAWING_2, 'secondary', 1)];
      await renderScreen(deps);
      await fireEvent.press(await screen.findByTestId('download-bundle'));
      await waitFor(() => expect(api.bootstraps).toContain(DRAWING_2));
      await waitFor(() =>
        expect(files.has(`bundle-${USER}-${PROJECT}-${DRAWING_2}.json`)).toBe(true),
      );
      await fireEvent.press(await screen.findByTestId('drawing-picker-toggle'));
      await screen.findByTestId('drawing-picker');
      expect(screen.getByTestId(`drawing-${DRAWING_2}`)).toBeTruthy();
      expect(screen.queryByTestId('drawing-unavailable')).toBeNull();
      // Fetched once only.
      expect(api.bootstraps.filter((id) => id === DRAWING_2)).toHaveLength(1);
    });

    it('says so, and keeps the open drawing, when a picked drawing is not on the phone', async () => {
      const { api, deps } = setup();
      api.drawings = [drawing(DRAWING_1, 'general', 1), drawing(DRAWING_2, 'secondary', 1)];
      api.failDrawings.add(DRAWING_2);
      await renderScreen(deps);
      await fireEvent.press(await screen.findByTestId('download-bundle'));
      await fireEvent.press(await screen.findByTestId('drawing-picker-toggle'));
      await fireEvent.press(await screen.findByTestId(`drawing-${DRAWING_2}`));
      expect(await screen.findByText(t('mobileSites.notOnPhoneOffline'))).toBeTruthy();
      expect(t('mobileSites.notOnPhoneOffline')).toBe(
        'الرسمة دي مش متحملة على الموبايل، اتصل بالنت عشان تتحمل',
      );
      // The drawing screen is still there (not replaced by the download screen).
      expect(screen.getByTestId('drawing-picker-toggle')).toBeTruthy();
    });
  });

  describe('supervisor sites (ADR-054)', () => {
    const renderScreen = (deps: FieldDeps) =>
      render(
        <I18nProvider storage={new InMemoryLocaleStorage()}>
          <FieldProvider projectId={PROJECT} userId={USER} deps={deps}>
            <CadScreen onUpdate={() => undefined} onOpenPending={() => undefined} />
          </FieldProvider>
        </I18nProvider>,
      );

    it('says the supervisor has no sites instead of showing an empty map', async () => {
      const { api, deps } = setup();
      api.scope = { kind: 'sites', siteIds: [] };
      await renderScreen(deps);
      await fireEvent.press(await screen.findByTestId('download-bundle'));
      expect(await screen.findByTestId('no-sites-message')).toBeTruthy();
      expect(t('mobileSites.noSites')).toBe('مالكش مواقع على المشروع ده. كلّم مدير المشروع.');
      expect(screen.queryByTestId('cad-area')).toBeNull();
    });

    it('treats a bundle cached with the retired zones scope as stale and downloads again', async () => {
      const { api, deps, files } = setup();
      const old = { ...bundle, scope: { kind: 'zones', zoneIds: [BOX] } };
      files.set(`bundle-${USER}-${PROJECT}.json`, await vault.sealText(JSON.stringify(old)));
      await renderScreen(deps);
      await fireEvent.press(await screen.findByTestId('download-bundle'));
      expect(await screen.findByTestId('cad-area')).toBeTruthy();
      expect(api.bootstraps.length).toBeGreaterThan(0);
    });
  });

  describe('groups, dimensions and planning (ADR-056)', () => {
    const DIG = '00000000-0000-4000-8000-0000000000a7';
    const PLAN = '00000000-0000-4000-8000-0000000000a8';
    const line = (
      id: string,
      code: string,
      workType: 'civil' | 'planning',
      group: { main: string; sub: string | null },
      extra: Partial<OfflineBundle['catalog'][number]> = {},
    ): OfflineBundle['catalog'][number] => ({
      id,
      workOrderId: '00000000-0000-4000-8000-0000000000a6',
      workOrderNumber: 'WO-1',
      lineNo: 1,
      code,
      description: `بند ${code}`,
      unit: 'عدد',
      quantity: '100',
      workType,
      recordedQuantity: '0',
      contractors: [],
      group,
      needsDimensions: false,
      ...extra,
    });
    const grouped: OfflineBundle = {
      ...bundle,
      elementGroups: [
        { element: 'box', mains: ['حفر', 'غير موجود'] },
        { element: 'planning', mains: ['As Built'] },
      ],
      catalog: [
        line(
          DIG,
          'D-01',
          'civil',
          { main: 'حفر', sub: 'يدوي' },
          { unit: 'م3', needsDimensions: true },
        ),
        line(ITEM, 'D-02', 'civil', { main: 'حفر', sub: null }),
        line(PLAN, 'P-01', 'planning', { main: 'As Built', sub: null }),
      ],
    };
    const press = (id: string) => fireEvent.press(screen.getByTestId(id));
    const disabled = (id: string) => screen.getByTestId(id).props.accessibilityState.disabled;

    async function open(target: UpdateTarget, sealed: OfflineBundle = grouped) {
      const ctx = setup();
      ctx.files.set(`bundle-${USER}-${PROJECT}.json`, await vault.sealText(JSON.stringify(sealed)));
      ctx.api.online = false;
      const onDone = jest.fn();
      await render(
        <I18nProvider storage={new InMemoryLocaleStorage()}>
          <FieldProvider projectId={PROJECT} userId={USER} deps={ctx.deps}>
            <UpdateWizardScreen
              target={target}
              deps={wizardDeps()}
              onDone={onDone}
              onCancel={() => undefined}
            />
          </FieldProvider>
        </I18nProvider>,
      );
      return { ...ctx, onDone };
    }
    const boxTarget: UpdateTarget = { kind: 'feature', feature: bundle.features[0] as never };

    /** From the work step to the saved update (materials and location stay empty). */
    async function finish() {
      await press('wizard-next'); // materials
      await press('wizard-next'); // location
      await press('wizard-next'); // photos
      await press('take-photo-general');
      await waitFor(() => expect(disabled('wizard-next')).toBe(false));
      await press('wizard-next');
    }

    it('walks main group, sub group and line with a breadcrumb and a way back', async () => {
      await open(boxTarget);
      await fireEvent.press(await screen.findByTestId('activity-civil'));
      await press('wizard-next');
      // Only the main groups of a box that have lines; the unused one is not listed.
      await screen.findByTestId('group-main-حفر');
      expect(screen.queryByText('غير موجود')).toBeNull();
      expect(screen.queryByTestId('group-back')).toBeNull();
      await press('group-main-حفر');
      expect(screen.getByTestId('group-breadcrumb').props.children).toContain('حفر');
      // The line without a sub group shows directly beside the sub group.
      expect(screen.getByTestId('work-D-02-self')).toBeTruthy();
      await press('group-sub-يدوي');
      expect(screen.getByTestId('group-breadcrumb').props.children).toContain('يدوي');
      expect(screen.getByTestId('work-D-01-self')).toBeTruthy();
      expect(screen.queryByTestId('work-D-02-self')).toBeNull();
      await press('group-back');
      expect(screen.getByTestId('group-sub-يدوي')).toBeTruthy();
      await press('group-back');
      expect(screen.getByTestId('group-main-حفر')).toBeTruthy();
    });

    it('shows the total of a line already given a quantity, and counts it on the group', async () => {
      await open(boxTarget);
      await fireEvent.press(await screen.findByTestId('activity-civil'));
      await press('wizard-next');
      await press('group-main-حفر');
      await press('work-D-02-self-+10');
      expect(screen.getByTestId('entered-D-02')).toBeTruthy();
      await press('group-back');
      expect(
        screen.getByText(new RegExp(t('field.update.groups.enteredLines', { count: ltr('1') }))),
      ).toBeTruthy();
    });

    it('types length, width and depth on a digging line and sends the dimensions', async () => {
      const { api, goOnline } = await open(boxTarget);
      await fireEvent.press(await screen.findByTestId('activity-civil'));
      await press('wizard-next');
      await press('group-main-حفر');
      await press('group-sub-يدوي');
      // No stepper on a dimensioned line; the quantity is computed.
      expect(screen.queryByTestId('work-D-01-self-+1')).toBeNull();
      await fireEvent.changeText(screen.getByTestId('work-D-01-self-length'), '10');
      await fireEvent.changeText(screen.getByTestId('work-D-01-self-width'), '0.35');
      expect(screen.getByTestId('work-D-01-self-qty').props.children).toContain('0');
      await fireEvent.changeText(screen.getByTestId('work-D-01-self-depth'), '0.9');
      expect(screen.getByTestId('work-D-01-self-qty').props.children).toContain('3.15');
      // A wrong value clears the quantity and says why.
      await fireEvent.changeText(screen.getByTestId('work-D-01-self-depth'), '0');
      expect(screen.getByTestId('work-D-01-self-dimensions-invalid')).toBeTruthy();
      // Editing replaces the set: one line for the performer.
      await fireEvent.changeText(screen.getByTestId('work-D-01-self-depth'), '1');
      expect(screen.getByTestId('work-D-01-self-qty').props.children).toContain('3.5');
      await finish();
      await press('acknowledge');
      await press('wizard-save');
      api.online = true;
      await act(async () => {
        goOnline();
      });
      await waitFor(() => expect(api.pushes).toHaveLength(1));
      expect(api.pushes[0]?.ops[0]).toMatchObject({
        payload: {
          featureId: BOX,
          lines: [
            {
              workOrderItemId: DIG,
              quantity: '3.5',
              role: 'work',
              performer: { kind: 'self' },
              dimensions: { lengthM: '10', widthM: '0.35', depthM: '1' },
            },
          ],
        },
      });
    });

    it('keeps the flat list when the server sends no map', async () => {
      await open(boxTarget, { ...grouped, elementGroups: [] });
      await fireEvent.press(await screen.findByTestId('activity-civil'));
      await press('wizard-next');
      expect(await screen.findByTestId('work-D-02-self')).toBeTruthy();
      expect(screen.queryByTestId('group-back')).toBeNull();
      expect(screen.queryByTestId('group-main-حفر')).toBeNull();
    });

    it('records a planning update on the drawing: no element, no GPS distance warning', async () => {
      const { api, goOnline, onDone } = await open({ kind: 'planning', drawingId: DRAWING_1 });
      // Planning is already the activity: the tool opens at the work step with the planning groups.
      await press('group-main-As Built');
      await press('work-P-01-self-+1');
      await finish();
      // The fix is 120 m from the box, but a planning update has no element to be far from.
      expect(screen.queryByTestId('warning-GPS_FAR')).toBeNull();
      expect(disabled('wizard-save')).toBe(false);
      await press('wizard-save');
      await waitFor(() => expect(onDone).toHaveBeenCalled());
      api.online = true;
      await act(async () => {
        goOnline();
      });
      await waitFor(() => expect(api.pushes).toHaveLength(1));
      const payload = (api.pushes[0]?.ops[0] as { payload: Record<string, unknown> }).payload;
      expect(payload).toMatchObject({
        featureId: null,
        drawingId: DRAWING_1,
        workType: 'planning',
        label: null,
        acknowledgedWarnings: [],
        workDate: '2026-10-30',
      });
    });

    it('lists a planning update in the pending screen without crashing on the empty element', async () => {
      const ctx = setup();
      ctx.files.set(
        `bundle-${USER}-${PROJECT}.json`,
        await vault.sealText(JSON.stringify(grouped)),
      );
      ctx.api.online = false;
      await render(
        <I18nProvider storage={new InMemoryLocaleStorage()}>
          <FieldProvider projectId={PROJECT} userId={USER} deps={ctx.deps}>
            <UpdateWizardScreen
              target={{ kind: 'planning', drawingId: DRAWING_1 }}
              deps={wizardDeps()}
              onDone={() => undefined}
              onCancel={() => undefined}
            />
            <PendingScreen onBack={() => undefined} />
          </FieldProvider>
        </I18nProvider>,
      );
      await press('group-main-As Built');
      await press('work-P-01-self-+1');
      await finish();
      await press('wizard-save');
      expect(await screen.findAllByText(/لم يُرسل/)).toBeTruthy();
      expect(
        screen.getAllByText(new RegExp(t('field.update.groups.planning'))).length,
      ).toBeGreaterThan(0);
    });

    it('offers the planning button of the open drawing on the CAD screen', async () => {
      const { api, deps } = setup();
      api.drawings = [
        {
          drawingId: DRAWING_1,
          siteId: SITE,
          siteName: 'Alpha',
          kind: 'general',
          ordinal: 1,
          revision: {
            id: REVISION,
            revNo: 1,
            publishedAt: '2026-10-29T08:00:00.000Z',
            tilesAvailable: false,
          },
        },
      ];
      const onPlanning = jest.fn();
      await render(
        <I18nProvider storage={new InMemoryLocaleStorage()}>
          <FieldProvider projectId={PROJECT} userId={USER} deps={deps}>
            <CadScreen
              onUpdate={() => undefined}
              onOpenPending={() => undefined}
              onPlanning={onPlanning}
            />
          </FieldProvider>
        </I18nProvider>,
      );
      await fireEvent.press(await screen.findByTestId('download-bundle'));
      await fireEvent(await screen.findByTestId('cad-area'), 'layout', {
        nativeEvent: { layout: { x: 0, y: 0, width: 400, height: 600 } },
      });
      await fireEvent.press(await screen.findByTestId('planning-button'));
      expect(onPlanning).toHaveBeenCalledWith(DRAWING_1);
    });
  });
});
