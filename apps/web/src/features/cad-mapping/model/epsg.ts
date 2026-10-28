import { isSupportedProjectEpsg, type CadMappingView } from '@ftth/shared';

export type EpsgParse =
  { ok: true; value: number } | { ok: false; error: 'required' | 'unsupported' };

/** The EPSG input is text; only WGS 84 / UTM codes are accepted (`isSupportedProjectEpsg`). */
export function parseEpsg(text: string): EpsgParse {
  const trimmed = text.trim();
  if (trimmed === '') return { ok: false, error: 'required' };
  if (!/^\d{1,6}$/.test(trimmed)) return { ok: false, error: 'unsupported' };
  const value = Number(trimmed);
  return isSupportedProjectEpsg(value) ? { ok: true, value } : { ok: false, error: 'unsupported' };
}

/** Saved mapping, else the detection's suggestion, else the project CRS when supported. */
export function initialEpsgText(view: CadMappingView): string {
  const candidates = [
    view.mapping?.crsEpsg ?? null,
    view.crsDetection?.suggestedEpsg ?? null,
    view.projectEpsg,
  ];
  const first = candidates.find((value) => value !== null && isSupportedProjectEpsg(value));
  return first === undefined || first === null ? '' : String(first);
}
