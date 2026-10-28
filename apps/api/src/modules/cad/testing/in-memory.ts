import {
  TEXT_LINK_STATUSES,
  type CadBuildRevisionJob,
  type CadImportJob,
  type FeatureType,
  type TextLinkCounts,
} from '@ftth/shared';
import { AppError } from '../../../common/app-error.js';
import type { Clock } from '../../../common/clock.js';
import type { DomainEventInput, EventLog } from '../../../common/event-log.port.js';
import type { JobQueue } from '../application/ports.js';
import type { CadFile } from '../domain/cad-file.js';
import type { CadFileRepository, CadTx, CadUnitOfWork } from '../domain/cad-file.repository.js';
import type { CadMappingRecord } from '../domain/cad-mapping.js';
import type { DesignRevision } from '../domain/design-revision.js';
import type {
  CadMappingRepository,
  DesignRevisionRepository,
  NewDesignRevision,
  OpenItems,
  TextLinkRecord,
  TextLinkRepository,
} from '../domain/design-revision.repository.js';

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

export class InMemoryCadMappings implements CadMappingRepository {
  readonly rows = new Map<string, CadMappingRecord>();

  async find(projectId: string, cadFileId: string): Promise<CadMappingRecord | null> {
    const row = this.rows.get(cadFileId);
    return row?.projectId === projectId ? { ...row } : null;
  }
  async insert(mapping: Omit<CadMappingRecord, 'version'>): Promise<CadMappingRecord> {
    const row = { ...mapping, version: 1 };
    this.rows.set(mapping.cadFileId, row);
    return { ...row };
  }
  async update(
    mapping: Omit<CadMappingRecord, 'version'>,
    expectedVersion: number,
  ): Promise<CadMappingRecord | null> {
    const current = this.rows.get(mapping.cadFileId);
    if (current?.projectId !== mapping.projectId || current.version !== expectedVersion) {
      return null;
    }
    const row = { ...mapping, version: expectedVersion + 1 };
    this.rows.set(mapping.cadFileId, row);
    return { ...row };
  }
}

export class InMemoryDesignRevisions implements DesignRevisionRepository {
  readonly rows = new Map<string, DesignRevision>();
  /** Source of `cadFileName` for the join the database does. */
  readonly fileNames = new Map<string, string>();
  private sequence = 0;

  async list(projectId: string): Promise<DesignRevision[]> {
    return [...this.rows.values()]
      .filter((row) => row.projectId === projectId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }
  async find(projectId: string, revisionId: string): Promise<DesignRevision | null> {
    const row = this.rows.get(revisionId);
    return row?.projectId === projectId ? { ...row } : null;
  }
  async findLatestPublishedId(projectId: string): Promise<string | null> {
    const published = [...this.rows.values()]
      .filter((row) => row.projectId === projectId && row.status === 'published')
      .sort((a, b) => (b.revNo ?? 0) - (a.revNo ?? 0));
    return published[0]?.id ?? null;
  }
  async hasOpen(projectId: string): Promise<boolean> {
    return [...this.rows.values()].some(
      (row) => row.projectId === projectId && ['queued', 'building', 'draft'].includes(row.status),
    );
  }
  async hasInProgressForFile(projectId: string, cadFileId: string): Promise<boolean> {
    return [...this.rows.values()].some(
      (row) =>
        row.projectId === projectId &&
        row.cadFileId === cadFileId &&
        ['queued', 'building'].includes(row.status),
    );
  }
  async insert(revision: NewDesignRevision): Promise<void> {
    if (await this.hasOpen(revision.projectId)) {
      throw new AppError('CONFLICT', 'open revision', { reason: 'REVISION_IN_PROGRESS' });
    }
    this.sequence += 1;
    this.rows.set(revision.id, {
      id: revision.id,
      projectId: revision.projectId,
      cadFileId: revision.cadFileId,
      cadFileName: this.fileNames.get(revision.cadFileId) ?? 'plan.dxf',
      revNo: null,
      status: 'queued',
      currentJobId: revision.currentJobId,
      baseRevisionId: revision.baseRevisionId,
      rules: revision.rules,
      mappingVersion: revision.mappingVersion,
      crsEpsg: revision.crsEpsg,
      drawingUnit: revision.drawingUnit,
      metresPerUnit: revision.metresPerUnit,
      insUnits: revision.insUnits,
      unitsConflict: revision.unitsConflict,
      counts: null,
      textLinkCounts: null,
      diffCounts: null,
      tilesStorageKey: null,
      errorCode: null,
      errorMessage: null,
      log: null,
      createdById: revision.createdById,
      // Keeps list order deterministic when the fake clock does not advance.
      createdAt: new Date(revision.queuedAt.getTime() + this.sequence),
      queuedAt: revision.queuedAt,
      buildStartedAt: null,
      builtAt: null,
      publishedAt: null,
      publishedById: null,
    });
  }
  async markEnqueueFailed(
    projectId: string,
    revisionId: string,
    jobId: string,
    message: string,
  ): Promise<boolean> {
    const row = this.rows.get(revisionId);
    if (row?.projectId !== projectId || row.currentJobId !== jobId || row.status !== 'queued') {
      return false;
    }
    this.rows.set(revisionId, {
      ...row,
      status: 'failed',
      errorCode: 'ENQUEUE_FAILED',
      errorMessage: message,
    });
    return true;
  }
  async publish(projectId: string, revisionId: string, actorId: string, at: Date): Promise<number> {
    const row = this.rows.get(revisionId);
    if (row?.projectId !== projectId) throw new Error('unknown revision');
    const revNo =
      Math.max(
        0,
        ...[...this.rows.values()]
          .filter((other) => other.projectId === projectId)
          .map((other) => other.revNo ?? 0),
      ) + 1;
    this.rows.set(revisionId, {
      ...row,
      status: 'published',
      revNo,
      publishedAt: at,
      publishedById: actorId,
    });
    return revNo;
  }
  async discard(projectId: string, revisionId: string, supersedingJobId: string): Promise<void> {
    const row = this.rows.get(revisionId);
    if (row?.projectId !== projectId) return;
    this.rows.set(revisionId, {
      ...row,
      status: 'discarded',
      currentJobId: supersedingJobId,
      errorCode: null,
    });
  }
}

export interface FakeFeature {
  id: string;
  projectId: string;
  revisionId: string;
  featureType: FeatureType;
  code: string | null;
}

export interface FakeLink extends TextLinkRecord {
  projectId: string;
  text: string | null;
  confidence: number;
  distanceM: number | null;
  reviewedById: string | null;
}

/** Link review rules without SQL: distances come from `distances` (default 1), codes follow the same ordering. */
export class InMemoryTextLinks implements TextLinkRepository {
  readonly links = new Map<string, FakeLink>();
  readonly features = new Map<string, FakeFeature>();
  readonly distances = new Map<string, number>();
  diffConflicts = 0;
  counts: TextLinkCounts | null = null;

  async find(
    projectId: string,
    revisionId: string,
    linkId: string,
  ): Promise<TextLinkRecord | null> {
    const link = this.links.get(linkId);
    return link?.projectId === projectId && link.revisionId === revisionId ? { ...link } : null;
  }
  async findFeature(projectId: string, revisionId: string, featureId: string) {
    const feature = this.features.get(featureId);
    return feature?.projectId === projectId && feature.revisionId === revisionId
      ? { id: feature.id, featureType: feature.featureType }
      : null;
  }
  async confirm(
    _projectId: string,
    _revisionId: string,
    linkId: string,
    featureId: string,
    actorId: string,
  ): Promise<void> {
    const link = this.links.get(linkId);
    if (!link) return;
    this.links.set(linkId, {
      ...link,
      status: 'confirmed',
      featureId,
      distanceM: this.distances.get(`${linkId}:${featureId}`) ?? 1,
      reviewedById: actorId,
    });
  }
  async reject(_projectId: string, _revisionId: string, linkId: string, actorId: string) {
    const link = this.links.get(linkId);
    if (link) this.links.set(linkId, { ...link, status: 'rejected', reviewedById: actorId });
  }
  async recomputeBoxCodes(_projectId: string, revisionId: string, featureIds: string[]) {
    for (const featureId of featureIds) {
      const feature = this.features.get(featureId);
      if (feature?.featureType !== 'box') continue;
      const best = [...this.links.values()]
        .filter(
          (link) =>
            link.revisionId === revisionId &&
            link.featureId === featureId &&
            link.kind === 'box_id' &&
            ['auto', 'confirmed'].includes(link.status) &&
            link.text !== null,
        )
        .sort((a, b) => b.confidence - a.confidence || (a.distanceM ?? 0) - (b.distanceM ?? 0))[0];
      this.features.set(featureId, { ...feature, code: best?.text?.trim() ?? null });
    }
  }
  async recomputeCounts(_projectId: string, revisionId: string): Promise<TextLinkCounts> {
    const counts = Object.fromEntries(
      TEXT_LINK_STATUSES.map((status) => [
        status,
        [...this.links.values()].filter(
          (link) => link.revisionId === revisionId && link.status === status,
        ).length,
      ]),
    ) as TextLinkCounts;
    this.counts = counts;
    return counts;
  }
  async countOpenItems(_projectId: string, revisionId: string): Promise<OpenItems> {
    return {
      textLinksToReview: [...this.links.values()].filter(
        (link) => link.revisionId === revisionId && link.status === 'review',
      ).length,
      diffConflicts: this.diffConflicts,
    };
  }
}

/** Not transactional (nothing here fails halfway); good enough to test use-case orchestration. */
export class InMemoryCadUnitOfWork implements CadUnitOfWork {
  readonly files = new InMemoryCadFiles();
  readonly mappings = new InMemoryCadMappings();
  readonly revisions = new InMemoryDesignRevisions();
  readonly links = new InMemoryTextLinks();
  readonly events = new InMemoryEventLog();

  run<T>(work: (tx: CadTx) => Promise<T>): Promise<T> {
    return work({
      files: this.files,
      mappings: this.mappings,
      revisions: this.revisions,
      links: this.links,
      events: this.events,
    });
  }
}

export class RecordingJobQueue implements JobQueue {
  readonly jobs: CadImportJob[] = [];
  readonly buildJobs: CadBuildRevisionJob[] = [];
  failWith: Error | null = null;

  async enqueueCadImport(job: CadImportJob): Promise<void> {
    if (this.failWith) throw this.failWith;
    this.jobs.push(job);
  }
  async enqueueBuildRevision(job: CadBuildRevisionJob): Promise<void> {
    if (this.failWith) throw this.failWith;
    this.buildJobs.push(job);
  }
}
