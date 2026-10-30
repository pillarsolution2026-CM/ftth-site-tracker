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
import type { OfflineBundle, SyncOp } from '@ftth/shared';
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
import { loadCachedBundle, saveBundle, type TextFiles } from '../model/bundle-cache';
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
  store: WatermelonSyncStore;
  download(): Promise<void>;
  syncNow(): void;
  /** Saves an update and its photos on the device, then asks for a sync. */
  record(op: SyncOp, files: readonly LocalPhotoFile[]): Promise<void>;
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
  const schedulerRef = useRef<SyncScheduler | null>(null);

  const refreshLocal = useCallback(async () => {
    setSummary(await store.summary());
    setEntries(await store.entries());
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
      const cached = await loadCachedBundle(deps.files, deps.vault, userId, projectId);
      if (!active) return;
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

  const download = useCallback(async () => {
    setBundleStatus('downloading');
    try {
      let fresh: OfflineBundle;
      try {
        fresh = await fetchOfflineBundle({
          baseUrl: deps.baseUrl,
          projectId,
          accessToken: await deps.accessToken(),
          ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}),
        });
      } catch (error) {
        if (!(error instanceof TransportError && error.status === 401)) throw error;
        if (!(await deps.refreshSession())) throw error;
        fresh = await fetchOfflineBundle({
          baseUrl: deps.baseUrl,
          projectId,
          accessToken: await deps.accessToken(),
          ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}),
        });
      }
      await saveBundle(deps.files, deps.vault, userId, fresh);
      setBundle(fresh);
      setBundleStatus('ready');
    } catch {
      // A failed refresh keeps the drawing already on the device.
      setBundleStatus(bundle ? 'ready' : 'error');
    }
  }, [bundle, deps, projectId, userId]);

  const syncNow = useCallback(() => schedulerRef.current?.trigger(), []);

  const record = useCallback(
    async (op: SyncOp, files: readonly LocalPhotoFile[]) => {
      await store.enqueue(op, files);
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
      store,
      download,
      syncNow,
      record,
    }),
    [
      bundle,
      bundleStatus,
      download,
      entries,
      lastSyncAt,
      projectId,
      record,
      store,
      summary,
      syncNow,
      syncState,
    ],
  );
  return <FieldContext.Provider value={value}>{children}</FieldContext.Provider>;
}

export function useField(): FieldContextValue {
  const value = useContext(FieldContext);
  if (!value) throw new Error('useField must be used inside FieldProvider');
  return value;
}
