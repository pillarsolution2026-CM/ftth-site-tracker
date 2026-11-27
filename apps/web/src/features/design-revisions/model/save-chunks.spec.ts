import { describe, expect, it, vi } from 'vitest';
import type { CreateDrawingCorrectionRequest, CreateDrawingCorrectionsRequest } from '@ftth/shared';
import { saveInChunks } from './save-chunks';

const curve = (ref: string): CreateDrawingCorrectionRequest => ({
  correction: {
    kind: 'add_curve',
    layer: 'Route',
    points: [
      [0, 0],
      [1, 1],
    ],
    closed: false,
  } as CreateDrawingCorrectionRequest['correction'],
  problem: null,
  ref,
});
const move = (handle: string): CreateDrawingCorrectionRequest => ({
  correction: { kind: 'move_item', handle, dx: 1, dy: 0 },
  problem: null,
});

/** An API that answers each request with id `id-<n>`, counting from 1 across the chunks. */
function api() {
  let next = 0;
  const bodies: CreateDrawingCorrectionsRequest[] = [];
  const send = vi.fn(async (body: CreateDrawingCorrectionsRequest) => {
    bodies.push(body);
    return { items: body.items.map(() => ({ id: `id-${++next}` })) };
  });
  return { send, bodies };
}

const handleOf = (request: CreateDrawingCorrectionRequest | undefined) =>
  (request?.correction as { handle?: string } | undefined)?.handle;

describe('saveInChunks (ADR-061)', () => {
  it('sends up to 200 edits in one request', async () => {
    const { send } = api();
    const result = await saveInChunks(
      Array.from({ length: 200 }, (_, i) => move(`H${i}`)),
      send,
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ saved: 200 });
    expect(result.error).toBeUndefined();
  });

  it('sends 450 edits in chunks of 200, 200, 50, in order, telling the progress', async () => {
    const { send, bodies } = api();
    const progress = vi.fn();
    const requests = Array.from({ length: 450 }, (_, i) => move(`H${i}`));
    const result = await saveInChunks(requests, send, progress);
    expect(bodies.map((b) => b.items.length)).toEqual([200, 200, 50]);
    expect(bodies.flatMap((b) => b.items.map(handleOf))).toEqual(requests.map(handleOf));
    expect(progress.mock.calls).toEqual([
      [200, 450],
      [400, 450],
      [450, 450],
    ]);
    expect(result.saved).toBe(450);
  });

  it('rewrites NEW-<ref> of an earlier chunk to FIX-<id> the earlier chunk returned', async () => {
    const { send, bodies } = api();
    // Chunk 1: a curve ref c1 and 199 moves; chunk 2: a move of NEW-c1, a curve c2, a move of NEW-c2.
    const requests = [
      curve('c1'),
      ...Array.from({ length: 199 }, (_, i) => move(`H${i}`)),
      move('NEW-c1'),
      curve('c2'),
      move('NEW-c2'),
    ];
    await saveInChunks(requests, send);
    const second = bodies[1]?.items ?? [];
    expect(handleOf(second[0])).toBe('FIX-id-1');
    // Inside its own chunk a NEW- handle is left to the API, with its ref.
    expect(second[1]?.ref).toBe('c2');
    expect(handleOf(second[2])).toBe('NEW-c2');
  });

  it('rewrites the handles of set_group lists too', async () => {
    const { send, bodies } = api();
    const group: CreateDrawingCorrectionRequest = {
      correction: { kind: 'set_group', name: 'G', handles: ['NEW-c1', 'H1'] },
      problem: null,
    } as CreateDrawingCorrectionRequest;
    await saveInChunks([curve('c1'), group], send, undefined, 1);
    expect((bodies[1]?.items[0]?.correction as { handles: string[] }).handles).toEqual([
      'FIX-id-1',
      'H1',
    ]);
  });

  it('on a refused chunk keeps the chunks before it saved and stops', async () => {
    const refusal = new Error('refused');
    let calls = 0;
    const send = vi.fn(async (body: CreateDrawingCorrectionsRequest) => {
      calls++;
      if (calls === 2) throw refusal;
      return { items: body.items.map((_, i) => ({ id: `id-${calls}-${i}` })) };
    });
    const requests = [curve('c1'), ...Array.from({ length: 450 }, (_, i) => move(`H${i}`))];
    requests.push(move('NEW-c1'));
    const result = await saveInChunks(requests, send);
    expect(send).toHaveBeenCalledTimes(2);
    expect(result.saved).toBe(200);
    expect(result.error).toBe(refusal);
    // The edits still waiting name the saved item by its FIX- handle.
    const last = requests[requests.length - 1] as CreateDrawingCorrectionRequest;
    expect((result.rewrite(last.correction) as { handle: string }).handle).toBe('FIX-id-1-0');
  });
});
