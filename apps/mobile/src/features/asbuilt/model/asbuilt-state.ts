import type {
  AsBuiltEdit,
  AsBuiltFeatureState,
  AsBuiltGeometry,
  FeatureType,
  OfflineBundle,
} from '@ftth/shared';
import type { OutboxEntry } from '@ftth/sync';

/**
 * As-Built state on the device (ADR-030): the bundle's approved state plus approved edits pulled
 * later (versions only go up), and the user's own edits that are not approved yet. Approved state
 * is the only source of `baseVersion`; the design (version 0) is never changed.
 */
export interface StateFeature {
  id: string;
  type: FeatureType;
  /** Design code (the text on the drawing), null for added features. */
  code: string | null;
  /** Approved As-Built geometry, or the design geometry while nothing is approved. */
  geometry: AsBuiltGeometry;
  /** Design geometry, drawn dashed under the As-Built; null for an added feature. */
  designGeometry: AsBuiltGeometry | null;
  /** Approved As-Built label (null: the design code applies). */
  label: string | null;
  geometryVersion: number;
  labelVersion: number;
  added: boolean;
}

export type OwnEditStatus = 'pending' | 'approved' | 'rejected';

/** One of the user's own edits as shown in lists and on the drawing. */
export interface OwnEdit {
  clientOpId: string;
  featureId: string;
  kind: AsBuiltEdit['kind'];
  featureType: FeatureType | null;
  status: OwnEditStatus;
  /** False while the edit is still only in the outbox. */
  sent: boolean;
  /** Review reason (rejected on the web). */
  reason: string | null;
  /** Code of a refusal on push (the server never stored the edit). */
  syncRejection: string | null;
  capturedAt: string;
  geometry: AsBuiltGeometry | null;
  label: string | null;
}

export interface PendingProposal {
  geometry: AsBuiltGeometry | null;
  label: string | null;
}

export interface AsBuiltState {
  features: readonly StateFeature[];
  byId: ReadonlyMap<string, StateFeature>;
  ownEdits: readonly OwnEdit[];
  /** Latest own pending proposal per feature (drawn marked, never used as a base). */
  pendingByFeature: ReadonlyMap<string, PendingProposal>;
}

export interface StateInput {
  bundle: Pick<OfflineBundle, 'features' | 'asBuilt'>;
  /** Server copies of As-Built edits pulled by sync. */
  remoteEdits: readonly AsBuiltEdit[];
  /** The user's outbox (any op kind; only As-Built edits are used). */
  entries: readonly OutboxEntry[];
  userId: string;
}

function fromDesign(f: OfflineBundle['features'][number]): StateFeature {
  return {
    id: f.id,
    type: f.type,
    code: f.code,
    geometry: f.geometry,
    designGeometry: f.geometry,
    label: null,
    geometryVersion: 0,
    labelVersion: 0,
    added: false,
  };
}

function applyBundleState(map: Map<string, StateFeature>, s: AsBuiltFeatureState): void {
  const base = map.get(s.featureId);
  if (!base) {
    if (!s.added) return; // a design feature that is not in the cached drawing
    map.set(s.featureId, {
      id: s.featureId,
      type: s.featureType,
      code: null,
      geometry: s.geometry,
      designGeometry: null,
      label: s.label,
      geometryVersion: s.geometryVersion,
      labelVersion: s.labelVersion,
      added: true,
    });
    return;
  }
  map.set(s.featureId, {
    ...base,
    geometry: s.geometryVersion > base.geometryVersion ? s.geometry : base.geometry,
    geometryVersion: Math.max(base.geometryVersion, s.geometryVersion),
    label: s.labelVersion > base.labelVersion ? s.label : base.label,
    labelVersion: Math.max(base.labelVersion, s.labelVersion),
  });
}

/** Applies a pulled approved edit; an older or equal version (already in the bundle) is ignored. */
function applyApprovedEdit(map: Map<string, StateFeature>, e: AsBuiltEdit): void {
  if (e.status !== 'approved' || e.approvedVersion === null) return;
  const base = map.get(e.featureId);
  if (e.kind === 'add_route' || e.kind === 'add_symbol') {
    if (base || !e.geometry) return;
    map.set(e.featureId, {
      id: e.featureId,
      type: e.featureType,
      code: null,
      geometry: e.geometry,
      designGeometry: null,
      label: e.label,
      geometryVersion: 1,
      labelVersion: e.label === null ? 0 : 1,
      added: true,
    });
    return;
  }
  if (!base) return;
  if (e.kind === 'label') {
    if (e.approvedVersion > base.labelVersion) {
      map.set(e.featureId, { ...base, label: e.label, labelVersion: e.approvedVersion });
    }
  } else if (e.geometry && e.approvedVersion > base.geometryVersion) {
    map.set(e.featureId, { ...base, geometry: e.geometry, geometryVersion: e.approvedVersion });
  }
}

function ownFromEntry(entry: OutboxEntry, remote: AsBuiltEdit | undefined): OwnEdit | null {
  if (entry.op.kind !== 'asbuilt_edit.record') return null;
  const p = entry.op.payload;
  return {
    clientOpId: entry.clientOpId,
    featureId: p.featureId,
    kind: p.kind,
    featureType: remote?.featureType ?? (p.kind === 'add_symbol' ? p.featureType : null),
    status: remote ? remote.status : entry.state === 'rejected' ? 'rejected' : 'pending',
    sent: remote !== undefined || entry.state !== 'pending',
    reason: remote?.reviewReason ?? null,
    syncRejection: remote ? null : entry.rejection,
    capturedAt: entry.op.capturedAt,
    geometry: p.kind === 'label' ? null : p.geometry,
    label: p.kind === 'move' || p.kind === 'reshape' ? null : p.label,
  };
}

export function buildAsBuiltState(input: StateInput): AsBuiltState {
  const map = new Map<string, StateFeature>();
  for (const f of input.bundle.features) map.set(f.id, fromDesign(f));
  for (const s of input.bundle.asBuilt) applyBundleState(map, s);
  const approved = input.remoteEdits
    .filter((e) => e.status === 'approved')
    .sort((a, b) => (a.approvedVersion ?? 0) - (b.approvedVersion ?? 0));
  for (const e of approved) applyApprovedEdit(map, e);

  const remoteByOp = new Map(input.remoteEdits.map((e) => [e.clientOpId, e]));
  const own = new Map<string, OwnEdit>();
  for (const entry of input.entries) {
    const edit = ownFromEntry(entry, remoteByOp.get(entry.clientOpId));
    if (edit) own.set(edit.clientOpId, edit);
  }
  for (const e of input.remoteEdits) {
    if (e.userId !== input.userId || own.has(e.clientOpId)) continue;
    own.set(e.clientOpId, {
      clientOpId: e.clientOpId,
      featureId: e.featureId,
      kind: e.kind,
      featureType: e.featureType,
      status: e.status,
      sent: true,
      reason: e.reviewReason,
      syncRejection: null,
      capturedAt: e.capturedAt,
      geometry: e.geometry,
      label: e.label,
    });
  }
  const ownEdits = [...own.values()].sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));

  const pendingByFeature = new Map<string, PendingProposal>();
  // Oldest first so the newest proposal wins.
  for (const e of [...ownEdits].reverse()) {
    if (e.status !== 'pending' || e.syncRejection) continue;
    const current = pendingByFeature.get(e.featureId) ?? { geometry: null, label: null };
    pendingByFeature.set(e.featureId, {
      geometry: e.geometry ?? current.geometry,
      label: e.label ?? current.label,
    });
  }
  return { features: [...map.values()], byId: map, ownEdits, pendingByFeature };
}

/** Text shown for a feature: As-Built label, else the design code. */
export function labelOf(f: StateFeature): string | null {
  return f.label ?? f.code;
}
