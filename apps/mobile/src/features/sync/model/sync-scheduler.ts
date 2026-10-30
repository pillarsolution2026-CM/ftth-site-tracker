import { backoffDelayMs, type SyncReport } from '@ftth/sync';

export interface SchedulerDeps {
  run(): Promise<SyncReport>;
  /** Rotates the session after a 401; false when the user must sign in again. */
  refreshSession(): Promise<boolean>;
  onReport(report: SyncReport): void;
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  random?(): number;
}

/**
 * When to sync (ADR-024): right away when asked (save, network back, app in front), then again
 * with exponential backoff while the network or server fails. A 401 refreshes the session once;
 * a 403 stops until the next explicit trigger.
 */
export class SyncScheduler {
  private failures = 0;
  private timer: unknown = null;
  private running = false;
  private again = false;
  private stopped = false;

  constructor(private readonly deps: SchedulerDeps) {}

  /** Runs now, or right after the round in progress. */
  trigger(): void {
    if (this.stopped) return;
    this.clear();
    if (this.running) {
      this.again = true;
      return;
    }
    void this.round(true);
  }

  stop(): void {
    this.stopped = true;
    this.clear();
  }

  get failureCount(): number {
    return this.failures;
  }

  private clear(): void {
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.timer = null;
  }

  private async round(mayRefresh: boolean): Promise<void> {
    this.running = true;
    let report: SyncReport;
    try {
      report = await this.deps.run();
    } catch {
      report = {
        outcome: 'server_error',
        applied: 0,
        duplicates: 0,
        rejected: 0,
        photosStored: 0,
        photosFailed: 0,
        pulled: 0,
      };
    }
    this.running = false;
    if (this.stopped) return;
    this.deps.onReport(report);

    if (report.outcome === 'unauthorized' && mayRefresh && (await this.deps.refreshSession())) {
      void this.round(false);
      return;
    }
    if (report.outcome === 'offline' || report.outcome === 'server_error') {
      this.failures += 1;
      this.timer = this.deps.setTimer(
        () => this.trigger(),
        backoffDelayMs(this.failures, this.deps.random?.()),
      );
    } else if (report.outcome === 'ok') {
      this.failures = 0;
    }
    if (this.again) {
      this.again = false;
      this.trigger();
    }
  }
}
