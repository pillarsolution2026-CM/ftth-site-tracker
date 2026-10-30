import type { SyncOutcome, SyncReport } from '@ftth/sync';
import { SyncScheduler } from './sync-scheduler';

const report = (outcome: SyncOutcome): SyncReport => ({
  outcome,
  applied: 0,
  duplicates: 0,
  rejected: 0,
  photosStored: 0,
  photosFailed: 0,
  pulled: 0,
});

function setup(outcomes: SyncOutcome[], refreshOk = true) {
  const timers: { cb: () => void; ms: number }[] = [];
  const reports: SyncOutcome[] = [];
  const run = jest.fn(async () => report(outcomes.shift() ?? 'ok'));
  const refreshSession = jest.fn(async () => refreshOk);
  const scheduler = new SyncScheduler({
    run,
    refreshSession,
    onReport: (r) => reports.push(r.outcome),
    setTimer: (cb, ms) => {
      timers.push({ cb, ms });
      return timers.length;
    },
    clearTimer: () => undefined,
    random: () => 0.999,
  });
  return { scheduler, timers, reports, run, refreshSession };
}

const flush = () => new Promise<void>((resolve) => setImmediate(() => resolve()));

describe('SyncScheduler', () => {
  it('retries with growing backoff while offline and resets after success', async () => {
    const { scheduler, timers, reports } = setup(['offline', 'offline', 'ok']);
    scheduler.trigger();
    await flush();
    expect(timers.map((t) => t.ms)).toEqual([1998]);
    timers[0]?.cb();
    await flush();
    expect(timers[1]?.ms).toBeGreaterThan(3000);
    timers[1]?.cb();
    await flush();
    expect(reports).toEqual(['offline', 'offline', 'ok']);
    expect(scheduler.failureCount).toBe(0);
    expect(timers).toHaveLength(2);
  });

  it('refreshes the session once on 401 and runs again', async () => {
    const { scheduler, reports, refreshSession } = setup(['unauthorized', 'ok']);
    scheduler.trigger();
    await flush();
    await flush();
    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(reports).toEqual(['unauthorized', 'ok']);
  });

  it('does not loop when the refresh fails or the session stays refused', async () => {
    const failed = setup(['unauthorized'], false);
    failed.scheduler.trigger();
    await flush();
    expect(failed.run).toHaveBeenCalledTimes(1);
    const refused = setup(['unauthorized', 'unauthorized']);
    refused.scheduler.trigger();
    await flush();
    await flush();
    expect(refused.run).toHaveBeenCalledTimes(2);
    expect(refused.timers).toHaveLength(0);
  });

  it('stops retrying on 403 until triggered again', async () => {
    const { scheduler, timers } = setup(['forbidden']);
    scheduler.trigger();
    await flush();
    expect(timers).toHaveLength(0);
  });

  it('queues one more round when triggered during a round, and nothing after stop', async () => {
    const { scheduler, run } = setup(['ok', 'ok', 'ok']);
    scheduler.trigger();
    scheduler.trigger();
    scheduler.trigger();
    await flush();
    await flush();
    expect(run).toHaveBeenCalledTimes(2);
    scheduler.stop();
    scheduler.trigger();
    await flush();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('treats an unexpected exception as a server error and retries', async () => {
    const { scheduler, timers, reports, run } = setup([]);
    run.mockRejectedValueOnce(new Error('boom'));
    scheduler.trigger();
    await flush();
    expect(reports).toEqual(['server_error']);
    expect(timers).toHaveLength(1);
  });
});
