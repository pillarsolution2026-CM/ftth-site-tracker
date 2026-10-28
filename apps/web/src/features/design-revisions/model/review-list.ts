import {
  TEXT_LINK_TARGETS,
  type DiffCounts,
  type FeatureType,
  type TextLink,
  type TextLinkCounts,
  type TextLinkKind,
  type TextLinkStatus,
} from '@ftth/shared';

export const REVIEW_PAGE_SIZE = 50;
export const FEATURE_SEARCH_PAGE_SIZE = 20;

export interface ReviewFilter {
  status: TextLinkStatus | 'all';
  kind: TextLinkKind | 'all';
}

/** The review list opens on what needs the PM: links in `review`. */
export const DEFAULT_REVIEW_FILTER: ReviewFilter = { status: 'review', kind: 'all' };

export function reviewQuery(filter: ReviewFilter, page: number) {
  return {
    page,
    pageSize: REVIEW_PAGE_SIZE,
    ...(filter.status !== 'all' ? { status: filter.status } : {}),
    ...(filter.kind !== 'all' ? { kind: filter.kind } : {}),
  };
}

/** Least sure first (the order the API returns), then by handle; stable for equal values. */
export function sortByConfidence(links: readonly TextLink[]): TextLink[] {
  return [...links].sort((a, b) => {
    const diff = Number(a.confidence) - Number(b.confidence);
    if (diff !== 0) return diff;
    return a.textHandle < b.textHandle ? -1 : a.textHandle > b.textHandle ? 1 : 0;
  });
}

export interface LinkTextView {
  /** Unreadable texts are never guessed: only the raw text is shown, marked as such. */
  unreadable: boolean;
  text: string;
}

export function linkTextOf(link: Pick<TextLink, 'text' | 'rawText' | 'readable'>): LinkTextView {
  if (!link.readable || link.text === null) return { unreadable: true, text: link.rawText };
  return { unreadable: false, text: link.text };
}

export interface LinkActions {
  confirm: boolean;
  reject: boolean;
  reassign: boolean;
}

/**
 * Buttons offered for a link. Confirm needs a feature to confirm (the API refuses otherwise), so a
 * link without a proposal can only be rejected or reassigned. Nothing is offered outside a draft.
 */
export function linkActions(link: TextLink, canReview: boolean): LinkActions {
  if (!canReview) return { confirm: false, reject: false, reassign: false };
  return {
    confirm: link.featureId !== null && link.status !== 'confirmed',
    reject: link.status !== 'rejected',
    reassign: true,
  };
}

/** Feature types a text of this kind may be linked to (ADR-019). */
export function allowedFeatureTypes(kind: TextLinkKind): readonly FeatureType[] {
  return TEXT_LINK_TARGETS[kind];
}

export interface OpenItems {
  textLinksToReview: number;
  diffConflicts: number;
}

/** What publishing would need an acknowledgement for. */
export function openItemsOf(
  linkCounts: TextLinkCounts | null,
  diffCounts: DiffCounts | null,
): OpenItems {
  return {
    textLinksToReview: linkCounts?.review ?? 0,
    diffConflicts: diffCounts?.conflict ?? 0,
  };
}

export function hasOpenItems(items: OpenItems): boolean {
  return items.textLinksToReview + items.diffConflicts > 0;
}
