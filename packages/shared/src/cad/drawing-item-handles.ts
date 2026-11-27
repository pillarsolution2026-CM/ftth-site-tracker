import type {
  CreateDrawingCorrectionRequest,
  DrawingCorrectionInput,
  FrozenDrawingCorrection,
} from './drawing-corrections.schemas.js';

/**
 * Items drawn on the program page are objects like any other (ADR-061, owner item 36): a later
 * correction may name the handle of an item that an earlier correction added.
 *
 * - A saved added item has the handle `FIX-<correction id>` (ADR-050).
 * - Inside one «حفظ», an item added by an earlier request of the same batch is named
 *   `NEW-<ref>`, where `ref` is the `ref` the client gave that request; the API rewrites it to
 *   `FIX-<id>` before saving (`resolveNewHandles`).
 * - Screen-only items (`add_note`, `add_shape`, `add_table`) have the kind `screen`: they can be
 *   moved, rotated, copied, mirrored, scaled, erased, styled, ordered and grouped; the worker
 *   checks those corrections and ignores them, as it ignores the item itself.
 */
export const FIX_HANDLE_PREFIX = 'FIX-';
export const NEW_HANDLE_PREFIX = 'NEW-';

/** Kinds of rows a handle may name: extracted rows, plus `screen` for screen-only added items. */
export type DrawingItemKind = 'insert' | 'text' | 'curve' | 'screen';

const ANY: DrawingItemKind[] = ['insert', 'text', 'curve', 'screen'];

/** The handle of the item a correction with this id adds (when its kind adds one). */
export const fixHandle = (correctionId: string): string => `${FIX_HANDLE_PREFIX}${correctionId}`;

export const isFixHandle = (handle: string): boolean => handle.startsWith(FIX_HANDLE_PREFIX);

/**
 * The handles a correction names and the kinds each may be. `add_*`, layer and dismissal
 * corrections name none.
 */
export function correctionTargets(input: DrawingCorrectionInput): {
  handles: string[];
  kinds: DrawingItemKind[];
} {
  switch (input.kind) {
    case 'move_item':
    case 'rotate_item':
    case 'erase_item':
    case 'copy_item':
    case 'mirror_item':
    case 'scale_item':
    case 'set_style':
    case 'set_order':
      return { handles: [input.handle], kinds: ANY };
    case 'move_layer':
      return { handles: [input.handle], kinds: ['insert', 'text', 'curve'] };
    case 'set_curve':
      return { handles: [input.handle], kinds: ['curve'] };
    case 'set_text':
    case 'set_text_format':
      return { handles: [input.handle], kinds: ['text'] };
    case 'set_attribute':
      return { handles: [input.handle], kinds: ['insert'] };
    case 'set_group':
      return { handles: input.handles, kinds: ANY };
    case 'merge_routes':
      return { handles: input.handles, kinds: ['curve'] };
    default:
      return { handles: [], kinds: [] };
  }
}

/** A copy of the correction with every named handle passed through `map`. */
export function mapCorrectionHandles(
  input: DrawingCorrectionInput,
  map: (handle: string) => string,
): DrawingCorrectionInput {
  if ('handles' in input && Array.isArray(input.handles)) {
    return { ...input, handles: input.handles.map(map) } as DrawingCorrectionInput;
  }
  if ('handle' in input && typeof input.handle === 'string' && input.kind !== 'dismiss_problem') {
    return { ...input, handle: map(input.handle) } as DrawingCorrectionInput;
  }
  return input;
}

/**
 * The kind of the item this correction adds, or null when it adds none. A copy has the kind of
 * its source (`kindOf`, null when the source is unknown).
 */
export function addedItemKind(
  input: DrawingCorrectionInput,
  kindOf: (handle: string) => DrawingItemKind | null,
): DrawingItemKind | null {
  switch (input.kind) {
    case 'add_text':
      return 'text';
    case 'add_item':
      return 'insert';
    case 'add_curve':
      return 'curve';
    case 'add_note':
    case 'add_shape':
    case 'add_table':
      return 'screen';
    case 'copy_item':
      return kindOf(input.handle);
    default:
      return null;
  }
}

/**
 * The added items alive after the given corrections (in force, in the order they apply): handle
 * `FIX-<id>` → kind. An erased added item is gone. `extractedKind` gives the kind of an extracted
 * row (only needed for copies of extracted rows; null = not a row).
 */
export function addedItemKinds(
  corrections: readonly FrozenDrawingCorrection[],
  extractedKind: (handle: string) => DrawingItemKind | null,
): Map<string, DrawingItemKind> {
  const out = new Map<string, DrawingItemKind>();
  const kindOf = (handle: string) => out.get(handle) ?? extractedKind(handle);
  for (const { id, correction } of corrections) {
    if (correction.kind === 'erase_item') {
      out.delete(correction.handle);
      continue;
    }
    const kind = addedItemKind(correction, kindOf);
    if (kind !== null) out.set(fixHandle(id), kind);
  }
  return out;
}

/**
 * The corrections in force that depend on the one withdrawn, directly or through another
 * dependant (an edit of its added item, a copy of it, an edit of that copy…), in the order they
 * were made. Withdrawing a correction withdraws these too (ADR-061).
 */
export function dependantsOf(
  correctionId: string,
  inForce: readonly FrozenDrawingCorrection[],
): string[] {
  const gone = new Set<string>([fixHandle(correctionId)]);
  const out: string[] = [];
  for (const { id, correction } of inForce) {
    if (id === correctionId) continue;
    const { handles } = correctionTargets(correction);
    if (handles.some((handle) => gone.has(handle))) {
      out.push(id);
      gone.add(fixHandle(id));
    }
  }
  return out;
}

/**
 * Rewrites `NEW-<ref>` handles of a batch to `FIX-<id>` of the earlier request carrying that
 * `ref` (`ids[i]` is the id given to request `i`). Returns the rewritten corrections, or the
 * handles that name no earlier request of the batch (a duplicate `ref` counts as unknown).
 */
export function resolveNewHandles(
  requests: readonly CreateDrawingCorrectionRequest[],
  ids: readonly string[],
): { corrections: DrawingCorrectionInput[] } | { unknown: string[] } {
  const known = new Map<string, string>();
  const dup = new Set<string>();
  const unknown = new Set<string>();
  const corrections = requests.map((request, i) => {
    const mapped = mapCorrectionHandles(request.correction, (handle) => {
      if (!handle.startsWith(NEW_HANDLE_PREFIX)) return handle;
      const id = known.get(handle.slice(NEW_HANDLE_PREFIX.length));
      if (id === undefined) {
        unknown.add(handle);
        return handle;
      }
      return fixHandle(id);
    });
    const ref = request.ref;
    if (ref !== undefined) {
      if (known.has(ref)) dup.add(ref);
      known.set(ref, ids[i] as string);
    }
    return mapped;
  });
  for (const ref of dup) unknown.add(`${NEW_HANDLE_PREFIX}${ref}`);
  return unknown.size > 0 ? { unknown: [...unknown] } : { corrections };
}
