import type { CadImportJob } from '@ftth/shared';
import type { DomainEventInput, EventLog } from '../../../common/event-log.port.js';
import type { Clock } from '../../../common/clock.js';
import type { JobQueue } from '../application/ports.js';
import type { CadFile } from '../domain/cad-file.js';
import type { CadFileRepository, CadTx, CadUnitOfWork } from '../domain/cad-file.repository.js';

export class FakeClock implements Clock {
  constructor(public current: Date) {}
  now(): Date {
    return this.current;
  }
  advanceMinutes(minutes: number): void {
    this.current = new Date(this.current.getTime() + minutes * 60_000);
  }
}

export class InMemoryEventLog implements EventLog {
  readonly events: DomainEventInput[] = [];
  async append(event: DomainEventInput): Promise<void> {
    this.events.push(event);
  }
  types(): string[] {
    return this.events.map((event) => event.type);
  }
}

export class InMemoryCadFiles implements CadFileRepository {
  readonly rows = new Map<string, CadFile>();

  async list(projectId: string): Promise<CadFile[]> {
    return [...this.rows.values()].filter((file) => file.projectId === projectId);
  }
  async find(projectId: string, cadFileId: string): Promise<CadFile | null> {
    const file = this.rows.get(cadFileId);
    return file?.projectId === projectId ? { ...file } : null;
  }
  async insertUploaded(file: CadFile): Promise<void> {
    this.rows.set(file.id, { ...file, status: 'uploaded' });
  }
  async markQueued(projectId: string, cadFileId: string, jobId: string, at: Date): Promise<void> {
    const file = this.rows.get(cadFileId);
    if (file?.projectId !== projectId) return;
    this.rows.set(cadFileId, {
      ...file,
      status: 'queued',
      currentJobId: jobId,
      queuedAt: at,
      errorCode: null,
      errorMessage: null,
    });
  }
  async markEnqueueFailed(
    projectId: string,
    cadFileId: string,
    jobId: string,
    message: string,
  ): Promise<boolean> {
    const file = this.rows.get(cadFileId);
    if (file?.projectId !== projectId || file.currentJobId !== jobId || file.status !== 'queued') {
      return false;
    }
    this.rows.set(cadFileId, {
      ...file,
      status: 'failed',
      errorCode: 'ENQUEUE_FAILED',
      errorMessage: message,
    });
    return true;
  }
  async findLog(): Promise<string | null> {
    return null;
  }
}

/** Not transactional (nothing here fails halfway); good enough to test use-case orchestration. */
export class InMemoryCadUnitOfWork implements CadUnitOfWork {
  readonly files = new InMemoryCadFiles();
  readonly events = new InMemoryEventLog();

  run<T>(work: (tx: CadTx) => Promise<T>): Promise<T> {
    return work({ files: this.files, events: this.events });
  }
}

export class RecordingJobQueue implements JobQueue {
  readonly jobs: CadImportJob[] = [];
  failWith: Error | null = null;

  async enqueueCadImport(job: CadImportJob): Promise<void> {
    if (this.failWith) throw this.failWith;
    this.jobs.push(job);
  }
}
