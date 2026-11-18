import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import type { Database } from '@nozbe/watermelondb';
import type {
  AsBuiltEdit,
  OfflineBundle,
  OfflineDrawing,
  RecordAsBuiltEditOp,
  SyncOp,
} from '@ftth/shared';
import {
  createHttpTransport,
  SyncEngine,
  TransportError,
  type OutboxEntry,
  type SyncOutcome,
} from '@ftth/sync';
import { fetchOfflineBundle } from '../api/bundle-api';
import {
  WatermelonSyncStore,
  type LocalPhotoFile,
  type OutboxSummary,
  type ReadFileBytes,
} from '../db/watermelon-sync-store';
import type { Vault } from '../../../shared/crypto/vault';
import {
  EMPTY_INDEX,
  loadCachedBundle,
  loadDrawingIndex,
  saveBundle,
  saveDrawingIndex,
  withDownloadedBundle,
  type DrawingIndex,
  type TextFiles,
} from '../model/bundle-cache';
import { pickInitialDrawing } from '../model/drawing-picker';
import { SyncScheduler } from '../model/sync-scheduler';

/** Everything the field screens need from the device; the app wires the native ones. */
export interface FieldDeps {
  db: Database;
  baseUrl: string;
  files: TextFiles;
  /** Raw (sealed) bytes of a file; the store opens them with `vault`. */
  readFileBytes: ReadFileBytes;
  /** Seals what the app keeps on the phone (ADR-025). */
  vault: Vault;
  accessToken(): Promise<string | null>;
  refreshSession(): Promise<boolean>;
  /** Stable id of this installation (sent with every push). */
  deviceId(): Promise<string>;
  /** Calls back when connectivity returns; returns an unsubscribe function. */
  onOnline(callback: () => void): () => void;
  /** Calls back when the app comes to the foreground. */
  onForeground(callback: () => void): () => void;
  fetchFn?: typeof fetch;
}

export type BundleStatus = 'loading' | 'missing' | 'downloading' | 'ready' | 'error';
export type SyncState = 'idle' | 'syncing' | SyncOutcome;

interface FieldContextValue {
  projectId: string;
  bundle: OfflineBundle | null;
  bundleStatus: BundleStatus;
  syncState: SyncState;
  summary: OutboxSummary;
  lastSyncAt: string | null;
  entries: OutboxEntry[];
  /** Server copies of As-Built edits pulled by sync (ADR-030). */
  asBuiltEdits: AsBuiltEdit[];
  userId: string;
  store: WatermelonSyncStore;
  /** Published drawings of the project as last downloaded (ADR-049 part B). */
  drawings: OfflineDrawing[];
  /** drawingId to the revision number held on the phone: what works offline. */
  downloadedDrawings: Readonly<Record<string, number>>;
  /** Downloads the given drawing (default: the one open now, else the server default). */
  download(drawingId?: string | null): Promise<void>;
  /** Opens a drawing from the phone, or downloads it when it is not there yet. */
  selectDrawing(drawing: OfflineDrawing): Promise<void>;
  syncNow(): void;
  /** Saves an update and its photos on the device, then asks for a sync. */
  record(op: SyncOp, files: readonly LocalPhotoFile[]): Promise<void>;
  /** Saves all As-Built edits of one session in one local transaction, then asks for a sync. */
  recordAsBuilt(ops: readonly RecordAsBuiltEditOp[]): Promise<void>;
}

const FieldContext = createContext<FieldContextValue | null>(null);

const EMPTY_SUMMARY: OutboxSummary = { pending: 0, rejected: 0, photosWaiting: 0, photosFailed: 0 };

export function FieldProvider({
  projectId,
  userId,
  deps,
  children,
}: {
  projectId: string;
  /** The signed-in user; the outbox, photos and cached data are kept per user. */
  userId: string;
  deps: FieldDeps;
  children: ReactNode;
}) {
  const store = useMemo(
    () => new WatermelonSyncStore(deps.db, projectId, userId, deps.readFileBytes, deps.vault),
    [deps.db, deps.readFileBytes, deps.vault, projectId, userId],
  );
  const [bundle, setBundle] = useState<OfflineBundle | null>(null);
  const [bundleStatus, setBundleStatus] = useState<BundleStatus>('loading');
  const [syncState, setSyncState] = useState<SyncState>('idle');
  const [summary, setSummary] = useState<OutboxSummary>(EMPTY_SUMMARY);
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);
  const [entries, setEntries] = useState<OutboxEntry[]>([]);
  const [asBuiltEdits, setAsBuiltEdits] = useState<AsBuiltEdit[]>([]);
  const [index, setIndex] = useState<DrawingIndex>(EMPTY_INDEX);
  const indexRef = useRef<DrawingIndex>(EMPTY_INDEX);
  const schedulerRef = useRef<SyncScheduler | null>(null);

  const updateIndex = useCallback(
    async (next: DrawingIndex) => {
      indexRef.current = next;
      setIndex(next);
      await saveDrawingIndex(deps.files, userId, projectId, next);
    },
    [deps.files, projectId, userId],
  );

  const refreshLocal = useCallback(async () => {
    setSummary(await store.summary());
    setEntries(await store.entries());
    setAsBuiltEdits(await store.remoteAsBuiltEdits());
    setLastSyncAt(await store.getLastSyncAt());
  }, [store]);

  useEffect(() => {
    let active = true;
    const engineReady = deps.deviceId().then(
      (deviceId) =>
        new SyncEngine({
          store,
          photos: store,
          deviceId,
          transport: createHttpTransport({
            baseUrl: deps.baseUrl,
            projectId,
            getAccessToken: () => deps.accessToken(),
            ...(deps.fetchFn
              ? { fetch: (url, init) => (deps.fetchFn as typeof fetch)(url, init) }
              : {}),
          }),
        }),
    );
    const scheduler = new SyncScheduler({
      run: async () => {
        if (active) setSyncState('syncing');
        return (await engineReady).syncOnce();
      },
      refreshSession: () => deps.refreshSession(),
      onReport: (report) => {
        if (!active) return;
        setSyncState(report.outcome === 'ok' ? 'idle' : report.outcome);
        void (async () => {
          if (report.outcome === 'ok') await store.setLastSyncAt(new Date().toISOString());
          await refreshLocal();
        })();
      },
      setTimer: (callback, ms) => setTimeout(callback, ms),
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    });
    schedulerRef.current = scheduler;

    void (async () => {
      const known = await loadDrawingIndex(deps.files, userId, projectId);
      const choice = pickInitialDrawing(known.drawings, known.last);
      const cached =
        (choice
          ? await loadCachedBundle(deps.files, deps.vault, userId, projectId, choice.drawingId)
          : null) ?? (await loadCachedBundle(deps.files, deps.vault, userId, projectId));
      if (!active) return;
      indexRef.current = known;
      setIndex(known);
      setBundle(cached);
      setBundleStatus(cached ? 'ready' : 'missing');
      await refreshLocal();
      scheduler.trigger();
    })();
    const offOnline = deps.onOnline(() => scheduler.trigger());
    const offForeground = deps.onForeground(() => scheduler.trigger());
    return () => {
      active = false;
      scheduler.stop();
      offOnline();
      offForeground();
    };
  }, [deps, projectId, refreshLocal, store, userId]);

  const download = useCallback(
    async (drawingId?: string | null) => {
      const target = drawingId ?? bundle?.revision?.drawingId ?? null;
      setBundleStatus('downloading');
      try {
        const request = async () =>
          fetchOfflineBundle({
            baseUrl: deps.baseUrl,
            projectId,
            drawingId: target,
            accessToken: await deps.accessToken(),
            ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}),
          });
        let fresh: OfflineBundle;
        try {
          fresh = await request();
        } catch (error) {
          if (!(error instanceof TransportError && error.status === 401)) throw error;
          if (!(await deps.refreshSession())) throw error;
          fresh = await request();
        }
        await saveBundle(deps.files, deps.vault, userId, fresh, target);
        const held = fresh.revision?.drawingId ?? null;
        const listed = fresh.drawings.find((d) => d.drawingId === held);
        await updateIndex({
          ...withDownloadedBundle(indexRef.current, fresh),
          last: held ? { siteId: listed?.siteId ?? null, drawingId: held } : indexRef.current.last,
        });
        setBundle(fresh);
        setBundleStatus('ready');
      } catch {
        // A failed download keeps the drawing already on the device.
        setBundleStatus(bundle ? 'ready' : 'error');
      }
    },
    [bundle, deps, projectId, updateIndex, userId],
  );

  const selectDrawing = useCallback(
    async (drawing: OfflineDrawing) => {
      if (bundle?.revision?.drawingId === drawing.drawingId) return;
      const cached = indexRef.current.downloaded[drawing.drawingId]
        ? await loadCachedBundle(deps.files, deps.vault, userId, projectId, drawing.drawingId)
        : null;
      if (cached) {
        await updateIndex({
          ...indexRef.current,
          last: { siteId: drawing.siteId, drawingId: drawing.drawingId },
        });
        setBundle(cached);
        setBundleStatus('ready');
        return;
      }
      await download(drawing.drawingId);
    },
    [bundle, deps.files, deps.vault, download, projectId, updateIndex, userId],
  );

  const syncNow = useCallback(() => schedulerRef.current?.trigger(), []);

  const record = useCallback(
    async (op: SyncOp, files: readonly LocalPhotoFile[]) => {
      await store.enqueue(op, files);
      await refreshLocal();
      schedulerRef.current?.trigger();
    },
    [refreshLocal, store],
  );

  const recordAsBuilt = useCallback(
    async (ops: readonly RecordAsBuiltEditOp[]) => {
      await store.enqueueAsBuiltEdits(ops);
      await refreshLocal();
      schedulerRef.current?.trigger();
    },
    [refreshLocal, store],
  );

  const value = useMemo(
    () => ({
      projectId,
      bundle,
      bundleStatus,
      syncState,
      summary,
      lastSyncAt,
      entries,
      asBuiltEdits,
      userId,
      store,
      drawings: index.drawings.length > 0 ? index.drawings : (bundle?.drawings ?? []),
      downloadedDrawings: index.downloaded,
      download,
      selectDrawing,
      syncNow,
      record,
      recordAsBuilt,
    }),
    [
      asBuiltEdits,
      bundle,
      bundleStatus,
      download,
      entries,
      index,
      lastSyncAt,
      projectId,
      record,
      recordAsBuilt,
      selectDrawing,
      store,
      summary,
      syncNow,
      syncState,
      userId,
    ],
  );
  return <FieldContext.Provider value={value}>{children}</FieldContext.Provider>;
}

export function useField(): FieldContextValue {
  const value = useContext(FieldContext);
  if (!value) throw new Error('useField must be used inside FieldProvider');
  return value;
}
