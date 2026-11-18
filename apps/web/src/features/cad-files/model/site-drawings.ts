import type { MessageKey } from '@ftth/i18n';
import {
  UploadRefusedDetailsSchema,
  type DrawingKind,
  type SiteDrawing,
  type SiteDrawingsResponse,
  type UploadCadFileQuery,
} from '@ftth/shared';

/** What the upload dialog lets the user pick (ADR-049 part B). */
export type UploadChoice = 'new_drawing' | `version:${string}`;

export interface UploadSelection {
  siteId: string | null;
  kind: DrawingKind | null;
  choice: UploadChoice | null;
}

export const EMPTY_SELECTION: UploadSelection = { siteId: null, kind: null, choice: null };

export const versionChoice = (drawingId: string): UploadChoice => `version:${drawingId}`;

/** The drawing id inside a `version:` choice, or null. */
export function choiceDrawingId(choice: UploadChoice | null): string | null {
  return choice?.startsWith('version:') ? choice.slice('version:'.length) : null;
}

/** The drawings of one site, from the list answer (withdrawn ones are never listed). */
export function drawingsOfSite(data: SiteDrawingsResponse, siteId: string | null): SiteDrawing[] {
  return data.sites.find((site) => site.siteId === siteId)?.drawings ?? [];
}

/** The site's General (one per site), or null. */
export function generalOf(drawings: readonly SiteDrawing[]): SiteDrawing | null {
  return drawings.find((d) => d.kind === 'general') ?? null;
}

export function secondariesOf(drawings: readonly SiteDrawing[]): SiteDrawing[] {
  return drawings.filter((d) => d.kind === 'secondary').sort((a, b) => a.ordinal - b.ordinal);
}

/** «الرئيسي» / «الثانوي 2»: message key and the ordinal to print (null for the General). */
export function drawingLabel(drawing: Pick<SiteDrawing, 'kind' | 'ordinal'>): {
  key: 'siteDrawings.label.general' | 'siteDrawings.label.secondary';
  ordinal: number | null;
} {
  return drawing.kind === 'general'
    ? { key: 'siteDrawings.label.general', ordinal: null }
    : { key: 'siteDrawings.label.secondary', ordinal: drawing.ordinal };
}

export interface UploadOptions {
  /** «drawing new» is offered (a Secondary always; a General only when the site has none). */
  canCreate: boolean;
  /** Existing drawings of that kind that can take a new version. */
  versions: SiteDrawing[];
}

/**
 * What a site offers for a kind: a General that exists accepts only a new version; a Secondary
 * accepts a new drawing or a new version of any of its Secondaries.
 */
export function uploadOptions(drawings: readonly SiteDrawing[], kind: DrawingKind): UploadOptions {
  const ofKind = drawings.filter((d) => d.kind === kind).sort((a, b) => a.ordinal - b.ordinal);
  return { canCreate: kind === 'secondary' || ofKind.length === 0, versions: ofKind };
}

/** The choice that is clear without asking (a General that exists, or no drawing yet), else null. */
export function defaultChoice(options: UploadOptions, kind: DrawingKind): UploadChoice | null {
  if (kind === 'general') {
    const only = options.versions[0];
    return only ? versionChoice(only.id) : 'new_drawing';
  }
  return options.versions.length === 0 ? 'new_drawing' : null;
}

/** The API query for a complete selection, or null while something is still missing. */
export function toUploadQuery(selection: UploadSelection): UploadCadFileQuery | null {
  const { siteId, kind, choice } = selection;
  if (!siteId || !kind || !choice) return null;
  const drawingId = choiceDrawingId(choice);
  if (choice === 'new_drawing') return { siteId, kind, target: 'new_drawing' };
  return drawingId ? { siteId, kind, target: 'new_version', drawingId } : null;
}

export interface UploadRefusal {
  key: MessageKey;
  params: Record<string, string | number>;
}

/** Plain-language message of an upload refusal (409 / 404 details), or null if unknown. */
export function uploadRefusalOf(details: unknown): UploadRefusal | null {
  const parsed = UploadRefusedDetailsSchema.safeParse(details);
  if (!parsed.success) return null;
  switch (parsed.data.reason) {
    case 'GENERAL_EXISTS':
      return {
        key: 'siteDrawings.upload.refused.GENERAL_EXISTS',
        params: { file: parsed.data.currentFileName ?? '—' },
      };
    case 'SITE_NOT_FOUND':
      return { key: 'siteDrawings.upload.refused.SITE_NOT_FOUND', params: {} };
    case 'DRAWING_NOT_IN_SITE':
      return { key: 'siteDrawings.upload.refused.DRAWING_NOT_IN_SITE', params: {} };
    case 'DRAWING_UNASSIGNED':
      return { key: 'siteDrawings.upload.refused.DRAWING_UNASSIGNED', params: {} };
  }
}

export type DrawingState = 'not_built' | 'queued' | 'building' | 'draft' | 'published';

/**
 * Where a drawing stands: an open revision wins (it is what the PM works on), else the published
 * one, else nothing was built yet.
 */
export function drawingState(drawing: SiteDrawing): DrawingState {
  if (drawing.openRevision) return drawing.openRevision.status;
  return drawing.latestPublished ? 'published' : 'not_built';
}

/** A drawing that was never published can leave its site. */
export function canWithdraw(drawing: SiteDrawing): boolean {
  return drawing.latestPublished === null && drawing.withdrawnAt === null;
}

/** The sites that still need a General or a Secondary before they can publish. */
export function missingKinds(drawings: readonly SiteDrawing[]): DrawingKind[] {
  const out: DrawingKind[] = [];
  if (!generalOf(drawings)) out.push('general');
  if (secondariesOf(drawings).length === 0) out.push('secondary');
  return out;
}

/** The draft revision a site publishes with, if any drawing has one (any works: the API does the site). */
export function siteDraftRevisionId(drawings: readonly SiteDrawing[]): string | null {
  return drawings.find((d) => d.openRevision?.status === 'draft')?.openRevision?.id ?? null;
}
