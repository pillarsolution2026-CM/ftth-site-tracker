import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import LokiJSAdapter from '@nozbe/watermelondb/adapters/lokijs';
import { createProjectCrs } from '@ftth/geo';
import { translate } from '@ftth/i18n';
import type { OfflineBundle, SyncPushRequest } from '@ftth/shared';
import { I18nProvider } from '../../../shared/i18n/I18nProvider';
import { InMemoryLocaleStorage } from '../../../shared/storage/locale-storage';
import { CadScreen } from '../../cad/components/CadScreen';
import { PendingScreen } from '../../sync/components/PendingScreen';
import { createLocalDatabase } from '../../sync/db/database';
import { localSchema } from '../../sync/db/schema';
import { FieldProvider, type FieldDeps } from '../../sync/hooks/FieldProvider';
import type { CapturedPhoto } from '../model/update-wizard';
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
const E = 330_000;
const N = 3_340_000;

const bundle: OfflineBundle = {
  serverTime: '2026-10-30T08:00:00.000Z',
  project: { id: PROJECT, name: 'قليوب', crsEpsg: 32636 },
  scope: { kind: 'zones', zoneIds: ['00000000-0000-4000-8000-0000000000a5'] },
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

  fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (!this.online) throw new TypeError('Network request failed');
    const url = String(input);
    if (url.endsWith('/sync/bootstrap')) return json(200, bundle);
    if (url.endsWith('/sync/push')) {
      const request = JSON.parse(String(init?.body)) as SyncPushRequest;
      this.pushes.push(request);
      return json(200, {
        serverTime: '2026-10-30T09:00:00.000Z',
        results: request.ops.map((op, i) => ({
          clientOpId: op.clientOpId,
          outcome: 'applied',
          updateId: `00000000-0000-4000-8000-00000000${String(i).padStart(4, '0')}`,
        })),
      });
    }
    if (url.includes('/sync/changes')) {
      return json(200, {
        serverTime: '2026-10-30T09:00:00.000Z',
        cursor: '1',
        hasMore: false,
        updates: [],
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
  const files = new Map<string, unknown>();
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
      readJson: async (name) => files.get(name) ?? null,
      writeJson: async (name, value) => void files.set(name, value),
    },
    readFileBytes: async () => Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]),
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
    expect(files.has(`bundle-${USER}-${PROJECT}.json`)).toBe(true);
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
    files.set(`bundle-${USER}-${PROJECT}.json`, bundle);
    api.online = false;
    const onDone = jest.fn();
    const wizard = wizardDeps();
    await render(
      <I18nProvider storage={new InMemoryLocaleStorage()}>
        <FieldProvider projectId={PROJECT} userId={USER} deps={deps}>
          <UpdateWizardScreen
            feature={bundle.features[0] ?? (undefined as never)}
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
    await fireEvent.press(await screen.findByTestId('work-C-01-+1'));
    await fireEvent.press(screen.getByTestId('work-C-01-+1'));
    expect(screen.getByTestId('work-C-01-qty').props.children).toContain('2');
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
        lines: [{ workOrderItemId: ITEM, quantity: '2', role: 'work' }],
        note: 'حفر يدوي',
        label: '1-1',
        acknowledgedWarnings: ['GPS_FAR'],
      },
    });
    await waitFor(() => expect(api.uploaded.get(photo.photoId)).toBe(4));
    expect(await screen.findAllByText(/وصل للخادم/)).toBeTruthy();
  });
});
