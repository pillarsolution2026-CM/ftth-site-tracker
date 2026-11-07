import type { PlacementItem } from '@ftth/shared';
import type { Placemark } from './kml';

/** Type words a placemark name often starts with ("Cab 1-7", "HH 04B"); they never decide a match. */
const TYPE_PREFIX = /^(CABINET|CAB|HHI|HH|MH|JOINT|JC|BOX)(?=[\s\-_:#.]|\d)[\s\-_:#.]*/;

/** "Cab 1-7" → "1-7", " hh-04b " → "04B", "1 - 7" → "1-7". */
export function normalizeCode(text: string): string {
  const upper = text.trim().toUpperCase();
  return upper.replace(TYPE_PREFIX, '').replace(/\s+/g, '');
}

/**
 * Suggests the drawing item for each placemark whose name equals the code, or a text written
 * around, of exactly one item (ADR-035: "Cab 1-7" ↔ cabinet 1-7). An item claimed by two
 * placemarks is suggested to neither: the user decides. Returns placemark id → item handle.
 */
export function suggestMatches(
  placemarks: readonly Placemark[],
  items: readonly PlacementItem[],
): Record<string, string> {
  const byCode = new Map<string, PlacementItem[]>();
  for (const item of items) {
    const keys = new Set(
      [item.code, ...item.names].flatMap((name) => (name ? [normalizeCode(name)] : [])),
    );
    for (const key of keys) {
      if (key !== '') byCode.set(key, [...(byCode.get(key) ?? []), item]);
    }
  }
  const proposed = new Map<string, string>();
  const claims = new Map<string, number>();
  for (const placemark of placemarks) {
    const candidates = byCode.get(normalizeCode(placemark.name)) ?? [];
    const only = candidates.length === 1 ? candidates[0] : undefined;
    if (!only) continue;
    proposed.set(placemark.id, only.handle);
    claims.set(only.handle, (claims.get(only.handle) ?? 0) + 1);
  }
  const out: Record<string, string> = {};
  for (const [placemarkId, handle] of proposed) {
    if (claims.get(handle) === 1) out[placemarkId] = handle;
  }
  return out;
}

/** What people see for an item: its code, else its drawing handle. */
export const itemLabel = (item: PlacementItem): string => item.code ?? `#${item.handle}`;

/** The item with the texts written around it, to find it in a list: "#16993 (22U · 1-7)". */
export const itemOption = (item: PlacementItem): string =>
  item.names.length > 0 ? `${itemLabel(item)} (${item.names.join(' · ')})` : itemLabel(item);
