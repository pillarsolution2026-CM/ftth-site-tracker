import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import LokiJSAdapter from '@nozbe/watermelondb/adapters/lokijs';
import { polylineLength } from '@ftth/geo';
import { translate } from '@ftth/i18n';
import { testRandom } from '../../../shared/crypto/test-random';
import { createVault } from '../../../shared/crypto/vault';
import { I18nProvider } from '../../../shared/i18n/I18nProvider';
import { InMemoryLocaleStorage } from '../../../shared/storage/locale-storage';
import { CadScreen } from '../../cad/components/CadScreen';
import { PendingScreen } from '../../sync/components/PendingScreen';
import { boundsOf, fitBounds, toScreen, toWorld } from '../../cad/model/viewport';
import { createLocalDatabase } from '../../sync/db/database';
import { localSchema } from '../../sync/db/schema';
import { WatermelonSyncStore } from '../../sync/db/watermelon-sync-store';
import { FieldProvider, type FieldDeps } from '../../sync/hooks/FieldProvider';
import type { AsBuiltDeps } from '../hooks/useAsBuiltEditor';
import { bundleWith, E, N, PROJECT, REVISION, ROUTE, USER } from '../model/test-fixtures';

/**
 * The As-Built flow on the real components and the real local database (LokiJS adapter): open
 * As-Built mode, reshape the route by dragging a grip, save, and find the op in the outbox. Touch
 * events are the responder events the canvas receives; nothing here runs on a device.
 */

const t = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) =>
  translate('ar', key, params);
const vault = createVault(async () => new Uint8Array(32).fill(5), testRandom);
const bundle = bundleWith();
const SIZE = { width: 400, height: 600 };
const viewport = fitBounds(
  boundsOf(bundle.features) ?? { minX: 0, minY: 0, maxX: 1, maxY: 1 },
  400,
  600,
);

const px = (x: number, y: number) => {
  const { sx, sy } = toScreen(viewport, x, y);
  return { pageX: sx, pageY: sy };
};
const touch = (x: number, y: number) => ({ nativeEvent: { touches: [px(x, y)] } });

function setup() {
  const files = new Map<string, string>();
  const db = createLocalDatabase(
    new LokiJSAdapter({
      schema: localSchema,
      useWebWorker: false,
      useIncrementalIndexedDB: false,
      dbName: `asbuilt-flow-${Math.random()}`,
    }),
  );
  const deps: FieldDeps = {
    db,
    baseUrl: 'http://api.test',
    files: {
      readText: async (name) => files.get(name) ?? null,
      writeText: async (name, text) => void files.set(name, text),
    },
    readFileBytes: async () => new Uint8Array(),
    vault,
    accessToken: async () => 'token',
    refreshSession: async () => true,
    deviceId: async () => '00000000-0000-4000-8000-0000000000d1',
    onOnline: () => () => undefined,
    onForeground: () => () => undefined,
    // The phone is offline for the whole test.
    fetchFn: (async () => {
      throw new TypeError('Network request failed');
    }) as unknown as typeof fetch,
  };
  return { db, deps, files };
}

let ids = 0;
const asBuiltDeps: AsBuiltDeps = {
  newId: () => `00000000-0000-4000-8000-00000000c${(++ids).toString().padStart(3, '0')}`,
  now: () => new Date('2026-10-31T09:00:00.000Z'),
  locate: async () => null,
};

// Full screen flows (render, LokiJS, encryption, sync) take well under a second alone but share a
// small CI runner with every other package's tests; one hit Jest's 5 s default there (PR #22 CI).
jest.setTimeout(30_000);

describe('As-Built mode on the CAD screen', () => {
  it('reshapes a route by dragging a grip, shows the live length, saves one op to the outbox offline', async () => {
    const { db, deps, files } = setup();
    files.set(`bundle-${USER}-${PROJECT}.json`, await vault.sealText(JSON.stringify(bundle)));
    await render(
      <I18nProvider storage={new InMemoryLocaleStorage()}>
        <FieldProvider projectId={PROJECT} userId={USER} deps={deps}>
          <CadScreen
            onUpdate={() => undefined}
            onOpenPending={() => undefined}
            asBuilt={asBuiltDeps}
          />
        </FieldProvider>
      </I18nProvider>,
    );
    // Layout first so the viewport fits the drawing; then the As-Built toggle appears.
    const area = await screen.findByTestId('cad-area');
    await fireEvent(area, 'layout', { nativeEvent: { layout: { x: 0, y: 0, ...SIZE } } });
    await fireEvent.press(await screen.findByTestId('asbuilt-toggle'));
    expect(screen.getByText(t('asbuilt.exit'))).toBeTruthy();
    for (const tool of ['move', 'reshape', 'draw', 'symbol', 'label']) {
      expect(screen.getByTestId(`tool-${tool}`).props.accessibilityLabel).toBe(
        t(`asbuilt.tools.${tool as 'move'}`),
      );
    }
    // Layout of the As-Built canvas (its own onLayout, same size).
    const canvasArea = await screen.findByTestId('cad-area');
    await fireEvent(canvasArea, 'layout', { nativeEvent: { layout: { x: 0, y: 0, ...SIZE } } });
    expect(await screen.findByTestId('asbuilt-canvas')).toBeTruthy();
    // The design is dashed-only when unchanged: drawn once, no design copy underneath.
    expect(screen.queryByTestId(`design-${ROUTE}`)).toBeNull();

    // Reshape tool is active: tap the route to select it → grips appear.
    await fireEvent(canvasArea, 'responderGrant', touch(E + 25, N + 15));
    await fireEvent(canvasArea, 'responderRelease', { nativeEvent: { touches: [] } });
    expect(await screen.findByTestId('grip-vertex-1')).toBeTruthy();
    expect(screen.getByTestId('grip-midpoint-0')).toBeTruthy();
    expect(screen.getByTestId('asbuilt-save').props.accessibilityState.disabled).toBe(true);

    // Drag the middle vertex from (E+50, N+30) to (E+50, N+60).
    const target = toWorld(viewport, px(E + 50, N + 60).pageX, px(E + 50, N + 60).pageY);
    await fireEvent(canvasArea, 'responderGrant', touch(E + 50, N + 30));
    await fireEvent(canvasArea, 'responderMove', touch(target.x, target.y));
    const preview = [{ x: E, y: N }, target, { x: E + 100, y: N }];
    // Live length while dragging equals polylineLength of the previewed route.
    await waitFor(() =>
      expect(String(screen.getByTestId('asbuilt-length').props.children)).toContain(
        polylineLength(preview).toFixed(2),
      ),
    );
    await fireEvent(canvasArea, 'responderRelease', { nativeEvent: { touches: [] } });
    expect(String(screen.getByTestId('asbuilt-length').props.children)).toContain(
      polylineLength(preview).toFixed(2),
    );
    await waitFor(() =>
      expect(screen.getByTestId('asbuilt-save').props.accessibilityState.disabled).toBe(false),
    );
    expect(screen.getByTestId('asbuilt-undo').props.accessibilityState.disabled).toBe(false);

    // Save: one reshape op with the final geometry sits in the outbox, nothing was sent.
    await fireEvent.press(screen.getByTestId('asbuilt-save'));
    expect(await screen.findByTestId('asbuilt-saved')).toBeTruthy();
    const store = new WatermelonSyncStore(db, PROJECT, USER, async () => new Uint8Array(), vault);
    const entries = await store.entries();
    expect(entries).toHaveLength(1);
    const op = entries[0]?.op;
    expect(op).toMatchObject({
      kind: 'asbuilt_edit.record',
      capturedAt: '2026-10-31T09:00:00.000Z',
      payload: {
        kind: 'reshape',
        featureId: ROUTE,
        designRevisionId: REVISION,
        baseVersion: 0,
        gps: null,
        note: null,
      },
    });
    const coords =
      op?.kind === 'asbuilt_edit.record' &&
      'geometry' in op.payload &&
      op.payload.geometry.type === 'LineString'
        ? op.payload.geometry.coordinates
        : [];
    expect(coords).toHaveLength(3);
    expect(coords[0]).toEqual([E, N]);
    expect(coords[2]).toEqual([E + 100, N]);
    expect(coords[1]?.[0]).toBeCloseTo(target.x, 6);
    expect(coords[1]?.[1]).toBeCloseTo(target.y, 6);
    expect(polylineLength(coords.map(([x, y]) => ({ x: x ?? 0, y: y ?? 0 })))).toBeCloseTo(
      polylineLength(preview),
      9,
    );
    // The session is reset: nothing more to save.
    expect(screen.getByTestId('asbuilt-save').props.accessibilityState.disabled).toBe(true);
  });

  it('is not offered without the device services', async () => {
    const { deps, files } = setup();
    files.set(`bundle-${USER}-${PROJECT}.json`, await vault.sealText(JSON.stringify(bundle)));
    await render(
      <I18nProvider storage={new InMemoryLocaleStorage()}>
        <FieldProvider projectId={PROJECT} userId={USER} deps={deps}>
          <CadScreen onUpdate={() => undefined} onOpenPending={() => undefined} />
        </FieldProvider>
      </I18nProvider>,
    );
    await fireEvent(await screen.findByTestId('cad-area'), 'layout', {
      nativeEvent: { layout: { x: 0, y: 0, ...SIZE } },
    });
    expect(await screen.findByTestId('cad-canvas')).toBeTruthy();
    expect(screen.queryByTestId('asbuilt-toggle')).toBeNull();
  });

  it('inserts a symbol with a tap, offers the label tool and cancels back to the drawing', async () => {
    const { deps, files } = setup();
    files.set(`bundle-${USER}-${PROJECT}.json`, await vault.sealText(JSON.stringify(bundle)));
    await render(
      <I18nProvider storage={new InMemoryLocaleStorage()}>
        <FieldProvider projectId={PROJECT} userId={USER} deps={deps}>
          <CadScreen
            onUpdate={() => undefined}
            onOpenPending={() => undefined}
            asBuilt={asBuiltDeps}
          />
        </FieldProvider>
      </I18nProvider>,
    );
    await fireEvent(await screen.findByTestId('cad-area'), 'layout', {
      nativeEvent: { layout: { x: 0, y: 0, ...SIZE } },
    });
    await fireEvent.press(await screen.findByTestId('asbuilt-toggle'));
    const area = await screen.findByTestId('cad-area');
    await fireEvent(area, 'layout', { nativeEvent: { layout: { x: 0, y: 0, ...SIZE } } });
    await fireEvent.press(screen.getByTestId('tool-symbol'));
    await fireEvent.press(screen.getByTestId('symbol-joint'));
    await fireEvent(area, 'responderGrant', touch(E + 70, N + 20));
    await fireEvent(area, 'responderRelease', { nativeEvent: { touches: [] } });
    await waitFor(() =>
      expect(screen.getByTestId('asbuilt-save').props.accessibilityState.disabled).toBe(false),
    );
    await fireEvent.press(screen.getByTestId('tool-label'));
    expect(screen.getByTestId('label-input')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('asbuilt-cancel'));
    expect(await screen.findByTestId('asbuilt-toggle')).toBeTruthy();
    expect(screen.queryByTestId('asbuilt-save')).toBeNull();
  });

  it('lists my As-Built edits with their status in the pending screen', async () => {
    const { db, deps, files } = setup();
    files.set(`bundle-${USER}-${PROJECT}.json`, await vault.sealText(JSON.stringify(bundle)));
    const store = new WatermelonSyncStore(db, PROJECT, USER, async () => new Uint8Array(), vault);
    const clientOpId = '00000000-0000-4000-8000-0000000000f9';
    await store.enqueueAsBuiltEdits([
      {
        kind: 'asbuilt_edit.record',
        clientOpId,
        capturedAt: '2026-10-31T09:00:00.000Z',
        payload: {
          kind: 'label',
          featureId: ROUTE,
          designRevisionId: REVISION,
          baseVersion: 0,
          label: 'R-1 معدل',
          note: null,
          gps: null,
        },
      },
    ]);
    await render(
      <I18nProvider storage={new InMemoryLocaleStorage()}>
        <FieldProvider projectId={PROJECT} userId={USER} deps={deps}>
          <PendingScreen onBack={() => undefined} />
        </FieldProvider>
      </I18nProvider>,
    );
    expect(await screen.findByTestId(`asbuilt-entry-${clientOpId}`)).toBeTruthy();
    expect(screen.getByText(/لم يُرسل/)).toBeTruthy();
  });
});
