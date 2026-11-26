import {
  fixHandle,
  mapCorrectionHandles,
  MAX_CORRECTIONS_PER_SAVE,
  NEW_HANDLE_PREFIX,
  type CreateDrawingCorrectionRequest,
  type CreateDrawingCorrectionsRequest,
  type DrawingCorrectionInput,
} from '@ftth/shared';

/** What one chunk's answer must give back: the saved corrections' ids, in the order sent. */
export interface SavedChunk {
  items: readonly { id: string }[];
}

export interface ChunkedSaveResult {
  /** Requests saved (always a whole number of chunks, from the first). */
  saved: number;
  /** `NEW-<ref>` → `FIX-<id>` of every item the saved chunks added. */
  rewrite: (input: DrawingCorrectionInput) => DrawingCorrectionInput;
  /** The refusal of the chunk that failed; undefined when all were saved. */
  error?: unknown;
}

/**
 * A «حفظ» of more edits than one request takes (ADR-061): chunks of `size`, sent one after the
 * other, in order. A `NEW-<ref>` handle naming an item of an earlier chunk is rewritten to
 * `FIX-<id>` of the correction that chunk returned (the answer lists them in the order sent);
 * one naming an item of its own chunk is left to the API. A failed chunk stops the save: the
 * chunks before it stay saved.
 */
export async function saveInChunks(
  requests: readonly CreateDrawingCorrectionRequest[],
  send: (body: CreateDrawingCorrectionsRequest) => Promise<SavedChunk>,
  onChunk?: (saved: number, total: number) => void,
  size: number = MAX_CORRECTIONS_PER_SAVE,
): Promise<ChunkedSaveResult> {
  const known = new Map<string, string>();
  const rewrite = (input: DrawingCorrectionInput) =>
    known.size === 0
      ? input
      : mapCorrectionHandles(input, (handle) => {
          if (!handle.startsWith(NEW_HANDLE_PREFIX)) return handle;
          const id = known.get(handle.slice(NEW_HANDLE_PREFIX.length));
          return id === undefined ? handle : fixHandle(id);
        });
  let saved = 0;
  while (saved < requests.length) {
    const chunk = requests
      .slice(saved, saved + size)
      .map((request) => ({ ...request, correction: rewrite(request.correction) }));
    try {
      const answer = await send({ items: chunk });
      chunk.forEach((request, i) => {
        const id = answer.items[i]?.id;
        if (request.ref !== undefined && id !== undefined) known.set(request.ref, id);
      });
    } catch (error) {
      return { saved, rewrite, error };
    }
    saved += chunk.length;
    onChunk?.(saved, requests.length);
  }
  return { saved, rewrite };
}
