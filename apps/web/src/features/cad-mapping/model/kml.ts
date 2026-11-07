import { unzipSync, strFromU8 } from 'fflate';

/** A Point placemark of an uploaded KML / KMZ (ADR-035: input only, never exported). */
export interface Placemark {
  /** Unique within the file (index-based), for React keys and matching. */
  id: string;
  name: string;
  lat: number;
  lon: number;
}

export type KmlError = 'unreadable' | 'noPoints';

export type KmlResult = { ok: true; placemarks: Placemark[] } | { ok: false; error: KmlError };

/** Placemarks read from one file are capped so a huge export cannot freeze the screen. */
export const MAX_PLACEMARKS = 2000;

/** Reads the Point placemarks of a KML document; lines and polygons are skipped. */
export function parseKml(text: string): KmlResult {
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(text, 'application/xml');
  } catch {
    return { ok: false, error: 'unreadable' };
  }
  if (doc.getElementsByTagName('parsererror').length > 0) return { ok: false, error: 'unreadable' };

  const placemarks: Placemark[] = [];
  const nodes = doc.getElementsByTagNameNS('*', 'Placemark');
  for (let i = 0; i < nodes.length && placemarks.length < MAX_PLACEMARKS; i += 1) {
    const node = nodes.item(i);
    if (!node) continue;
    const point = node.getElementsByTagNameNS('*', 'Point').item(0);
    const coords = point?.getElementsByTagNameNS('*', 'coordinates').item(0)?.textContent;
    if (!coords) continue;
    // "lon,lat[,alt]": the first tuple of the element.
    const [lonText, latText] = coords.trim().split(/\s+/)[0]?.split(',') ?? [];
    const lon = Number(lonText);
    const lat = Number(latText);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    const name = directChild(node, 'name')?.textContent?.trim() ?? '';
    placemarks.push({ id: `p${i}`, name, lat, lon });
  }
  return placemarks.length > 0 ? { ok: true, placemarks } : { ok: false, error: 'noPoints' };
}

/**
 * Reads a .kml or .kmz file. A KMZ is a zip holding `doc.kml` (or another `.kml` at any depth);
 * the zip signature decides, not the file name.
 */
export function readKmlBytes(bytes: Uint8Array): KmlResult {
  const isZip = bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (!isZip) return parseKml(new TextDecoder().decode(bytes));
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, { filter: (file) => file.name.toLowerCase().endsWith('.kml') });
  } catch {
    return { ok: false, error: 'unreadable' };
  }
  const names = Object.keys(files).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  const first = names[0];
  const data = first ? files[first] : undefined;
  return data ? parseKml(strFromU8(data)) : { ok: false, error: 'unreadable' };
}

const rank = (name: string) => (name.toLowerCase() === 'doc.kml' ? 0 : 1);

function directChild(node: Element, localName: string): Element | null {
  for (const child of Array.from(node.children)) {
    if (child.localName === localName) return child;
  }
  return null;
}
