import type { OfflineDrawing } from '@ftth/shared';

/** One site of the work order with its drawings: General first, then Secondary 1..n. */
export interface SiteGroup {
  /** null: drawings not linked to a site yet («بدون موقع»). */
  siteId: string | null;
  name: string | null;
  drawings: OfflineDrawing[];
}

/** What the supervisor chose last in a project (remembered per user and project). */
export interface DrawingChoice {
  siteId: string | null;
  drawingId: string;
}

const kindRank = (d: OfflineDrawing) => (d.kind === 'general' ? 0 : 1);

export function compareDrawings(a: OfflineDrawing, b: OfflineDrawing): number {
  return kindRank(a) - kindRank(b) || a.ordinal - b.ordinal;
}

/** Sites in name order, the unassigned group last. */
export function groupBySite(drawings: readonly OfflineDrawing[]): SiteGroup[] {
  const bySite = new Map<string | null, SiteGroup>();
  for (const drawing of drawings) {
    const group = bySite.get(drawing.siteId) ?? {
      siteId: drawing.siteId,
      name: drawing.siteName,
      drawings: [],
    };
    group.drawings.push(drawing);
    bySite.set(drawing.siteId, group);
  }
  const groups = [...bySite.values()];
  for (const group of groups) group.drawings.sort(compareDrawings);
  return groups.sort((a, b) => {
    if (a.siteId === null) return b.siteId === null ? 0 : 1;
    if (b.siteId === null) return -1;
    return (a.name ?? '').localeCompare(b.name ?? '');
  });
}

/**
 * The drawing to open: the remembered one while it is still published, else the first site's
 * first drawing (its General); null when nothing is published.
 */
export function pickInitialDrawing(
  drawings: readonly OfflineDrawing[],
  last: DrawingChoice | null,
): OfflineDrawing | null {
  const remembered = last ? drawings.find((d) => d.drawingId === last.drawingId) : undefined;
  if (remembered) return remembered;
  return groupBySite(drawings)[0]?.drawings[0] ?? null;
}

/** The drawing a site opens with when the supervisor picks the site: its General, else the first. */
export function defaultDrawingOfSite(group: SiteGroup): OfflineDrawing | null {
  return group.drawings[0] ?? null;
}

/**
 * Drawings to fetch in the background: not on the phone, or older there than the latest published
 * revision. Sorted like the picker (sites by name, General first) so the useful ones come first.
 */
export function drawingsToDownload(
  drawings: readonly OfflineDrawing[],
  downloaded: Readonly<Record<string, number>>,
): OfflineDrawing[] {
  return groupBySite(drawings)
    .flatMap((group) => group.drawings)
    .filter((d) => {
      const held = downloaded[d.drawingId];
      return held === undefined || held < d.revision.revNo;
    });
}
