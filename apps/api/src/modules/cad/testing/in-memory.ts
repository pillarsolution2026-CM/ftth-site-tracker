import {
  TEXT_LINK_STATUSES,
  type CadBuildRevisionJob,
  type CadImportJob,
  type CadRenderViewJob,
  type DrawingKind,
  type FeatureType,
  type FrozenDrawingCorrection,
  type FrozenInstallation,
  type InstallationRoute,
  type GpsProposalListQuery,
  type TextLinkCounts,
} from '@ftth/shared';
import { AppError } from '../../../common/app-error.js';
import type { Clock } from '../../../common/clock.js';
import type { DomainEventInput, EventLog } from '../../../common/event-log.port.js';
import type { JobQueue } from '../application/ports.js';
import type { CadFile, DrawingViewRecord } from '../domain/cad-file.js';
import type { CadFileRepository, CadTx, CadUnitOfWork } from '../domain/cad-file.repository.js';
import type { CadMappingRecord } from '../domain/cad-mapping.js';
import type { DesignRevision } from '../domain/design-revision.js';
import type {
  DrawingCorrectionRecord,
  DrawingCorrectionRepository,
  HandleKind,
  NewDrawingCorrection,
} from '../domain/drawing-correction.js';
import type {
  InstallationAnswerRow,
  InstallationRepository,
  NewInstallationAnswer,
  NewTrenchMark,
  TrenchMarkRecord,
} from '../domain/installation.js';
import type {
  GpsProposalDecision,
  GpsProposalRecord,
  GpsProposalRepository,
} from '../domain/gps-proposal.js';
import type {
  CadMappingRepository,
  DesignRevisionRepository,
  DrawingProblemRepository,
  NewDesignRevision,
  OpenItems,
  SubCabinetPosition,
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
  /** Drawing view state per file (ADR-039); absent = none. */
  readonly views = new Map<string, DrawingViewRecord>();

  async list(projectId: string): Promise<CadFile[]> {
    return [...this.rows.values()].filter(
      (file) => file.projectId === projectId && file.supersededAt === null,
    );
  }
  async find(projectId: string, cadFileId: string): Promise<CadFile | null> {
    const file = this.rows.get(cadFileId);
    return file?.projectId === projectId ? { ...file } : null;
  }
  async insertUploaded(file: CadFile): Promise<void> {
    this.rows.set(file.id, { ...file, status: 'uploaded' });
  }
  async listCurrentOfKind(projectId: string, kind: DrawingKind): Promise<CadFile[]> {
    return this.lockCurrentOfKind(projectId, kind);
  }
  async lockCurrentOfKind(projectId: string, kind: DrawingKind): Promise<CadFile[]> {
    return [...this.rows.values()]
      .filter(
        (file) =>
          file.projectId === projectId && file.drawingKind === kind && file.supersededAt === null,
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((file) => ({ ...file }));
  }
  async supersede(projectId: string, fileIds: string[], byId: string, at: Date): Promise<void> {
    for (const id of fileIds) {
      const file = this.rows.get(id);
      if (file?.projectId !== projectId || file.supersededAt !== null) continue;
      this.rows.set(id, { ...file, supersededAt: at, supersededById: byId });
    }
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
    this.views.delete(cadFileId);
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
  async findView(projectId: string, cadFileId: string): Promise<DrawingViewRecord | null> {
    if (this.rows.get(cadFileId)?.projectId !== projectId) return null;
    const view = this.views.get(cadFileId);
    return view
      ? { ...view }
      : {
          cadFileId,
          status: 'none',
          jobId: null,
          storageKey: null,
          sizeBytes: null,
          errorCode: null,
          renderedAt: null,
          queuedAt: null,
        };
  }
  async markViewQueued(
    projectId: string,
    cadFileId: string,
    jobId: string,
    queuedAt: Date,
    staleBefore: Date,
  ): Promise<boolean> {
    const view = await this.findView(projectId, cadFileId);
    if (!view) return false;
    const stale = view.status === 'queued' && view.queuedAt !== null && view.queuedAt < staleBefore;
    if (view.status !== 'none' && view.status !== 'failed' && !stale) return false;
    this.views.set(cadFileId, {
      cadFileId,
      status: 'queued',
      jobId,
      storageKey: null,
      sizeBytes: null,
      errorCode: null,
      renderedAt: null,
      queuedAt,
    });
    return true;
  }
  async markViewEnqueueFailed(
    projectId: string,
    cadFileId: string,
    jobId: string,
  ): Promise<boolean> {
    const view = await this.findView(projectId, cadFileId);
    if (!view || view.status !== 'queued' || view.jobId !== jobId) return false;
    this.views.set(cadFileId, { ...view, status: 'failed', errorCode: 'QUEUE_UNAVAILABLE' });
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
  /** What each revision froze (the domain record does not carry it: the worker reads it). */
  readonly frozenCorrections = new Map<string, FrozenDrawingCorrection[]>();
  /** revisionId -> `code` of each sub cabinet feature (null: unnamed); empty when not set. */
  readonly subCabinets = new Map<string, (string | null)[]>();
  /** revisionId -> route features for the installation check. */
  readonly routes = new Map<string, InstallationRoute[]>();
  /** revisionId -> sub cabinet positions (ADR-042 part G). */
  readonly cabinetPositions = new Map<string, SubCabinetPosition[]>();

  async installationRoutes(projectId: string, revisionId: string): Promise<InstallationRoute[]> {
    const row = this.rows.get(revisionId);
    return row?.projectId === projectId ? [...(this.routes.get(revisionId) ?? [])] : [];
  }
  async frozenMergeHandles(projectId: string, revisionId: string): Promise<string[][]> {
    const row = this.rows.get(revisionId);
    if (row?.projectId !== projectId) return [];
    return (this.frozenCorrections.get(revisionId) ?? []).flatMap((frozen) =>
      frozen.correction.kind === 'merge_routes' ? [frozen.correction.handles] : [],
    );
  }
  async findLatestBuiltOfFile(
    projectId: string,
    cadFileId: string,
  ): Promise<DesignRevision | null> {
    const built = [...this.rows.values()]
      .filter(
        (row) =>
          row.projectId === projectId &&
          row.cadFileId === cadFileId &&
          (row.status === 'draft' || row.status === 'published'),
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return built[0] ? { ...built[0] } : null;
  }
  async subCabinetPositions(
    projectId: string,
    revisionId: string,
    limit: number,
  ): Promise<SubCabinetPosition[]> {
    const row = this.rows.get(revisionId);
    return row?.projectId === projectId
      ? (this.cabinetPositions.get(revisionId) ?? []).slice(0, limit)
      : [];
  }

  async subCabinetCodes(projectId: string, revisionId: string): Promise<(string | null)[]> {
    const row = this.rows.get(revisionId);
    return row?.projectId === projectId ? [...(this.subCabinets.get(revisionId) ?? [])] : [];
  }

  async list(projectId: string): Promise<DesignRevision[]> {
    return [...this.rows.values()]
      .filter((row) => row.projectId === projectId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }
  async find(projectId: string, revisionId: string): Promise<DesignRevision | null> {
    const row = this.rows.get(revisionId);
    return row?.projectId === projectId ? { ...row } : null;
  }
  async findLatestPublishedId(projectId: string, kind: DrawingKind): Promise<string | null> {
    const published = [...this.rows.values()]
      .filter(
        (row) =>
          row.projectId === projectId && row.drawingKind === kind && row.status === 'published',
      )
      .sort((a, b) => (b.revNo ?? 0) - (a.revNo ?? 0));
    return published[0]?.id ?? null;
  }
  async findOpen(projectId: string, kind: DrawingKind): Promise<DesignRevision | null> {
    const open = [...this.rows.values()].find(
      (row) =>
        row.projectId === projectId &&
        row.drawingKind === kind &&
        ['queued', 'building', 'draft'].includes(row.status),
    );
    return open ? { ...open } : null;
  }
  async hasOpen(projectId: string, kind: DrawingKind): Promise<boolean> {
    return (await this.findOpen(projectId, kind)) !== null;
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
    if (await this.hasOpen(revision.projectId, revision.drawingKind)) {
      throw new AppError('CONFLICT', 'open revision', { reason: 'REVISION_IN_PROGRESS' });
    }
    this.sequence += 1;
    this.frozenCorrections.set(revision.id, revision.corrections);
    this.rows.set(revision.id, {
      id: revision.id,
      projectId: revision.projectId,
      cadFileId: revision.cadFileId,
      drawingKind: revision.drawingKind,
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
      placement: revision.placement,
      installation: revision.installation,
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
  async publish(
    projectId: string,
    revisionIds: string[],
    actorId: string,
    at: Date,
  ): Promise<number> {
    const revNo =
      Math.max(
        0,
        ...[...this.rows.values()]
          .filter((other) => other.projectId === projectId)
          .map((other) => other.revNo ?? 0),
      ) + 1;
    for (const revisionId of revisionIds) {
      const row = this.rows.get(revisionId);
      if (row?.projectId !== projectId) throw new Error('unknown revision');
      this.rows.set(revisionId, {
        ...row,
        status: 'published',
        revNo,
        publishedAt: at,
        publishedById: actorId,
      });
    }
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
  /** Diff conflicts of every revision without an entry in `diffConflictsByRevision`. */
  diffConflicts = 0;
  readonly diffConflictsByRevision = new Map<string, number>();
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
      diffConflicts: this.diffConflictsByRevision.get(revisionId) ?? this.diffConflicts,
    };
  }
}

export class InMemoryDrawingProblems implements DrawingProblemRepository {
  /** revisionId -> stored warnings (as the worker writes them). */
  readonly stored = new Map<string, unknown>();

  async warnings(_projectId: string, revisionId: string): Promise<unknown> {
    return this.stored.get(revisionId) ?? [];
  }
}

/** GPS point proposals in memory; `centres` stands in for the drawing rows (key: feature id). */
export class InMemoryGpsProposals implements GpsProposalRepository {
  readonly rows = new Map<string, GpsProposalRecord>();
  readonly centres = new Map<string, { x: number; y: number }>();

  async list(projectId: string, query: GpsProposalListQuery): Promise<GpsProposalRecord[]> {
    return [...this.rows.values()]
      .filter(
        (row) =>
          row.projectId === projectId &&
          (!query.status || row.status === query.status) &&
          (!query.cadFileId || row.cadFileId === query.cadFileId),
      )
      .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime());
  }
  async find(projectId: string, proposalId: string): Promise<GpsProposalRecord | null> {
    const row = this.rows.get(proposalId);
    return row?.projectId === projectId ? { ...row } : null;
  }
  async photo(): Promise<{ storageKey: string | null } | null> {
    return null;
  }
  async drawnCentre(
    _projectId: string,
    proposal: { featureId: string },
  ): Promise<{ x: number; y: number } | null> {
    return this.centres.get(proposal.featureId) ?? null;
  }
  async decide(
    projectId: string,
    proposalId: string,
    decision: GpsProposalDecision,
  ): Promise<boolean> {
    const row = this.rows.get(proposalId);
    if (row?.projectId !== projectId || row.status !== 'pending') return false;
    this.rows.set(proposalId, {
      ...row,
      status: decision.status,
      decidedBy: { id: decision.decidedBy, name: 'PM' },
      decidedAt: decision.decidedAt,
      rejectReason: decision.status === 'rejected' ? decision.reason : null,
      acceptedMappingVersion: decision.status === 'accepted' ? decision.mappingVersion : null,
    });
    return true;
  }
}

/** Drawing corrections in memory; `handles` stands in for the extracted rows of every file. */
export class InMemoryDrawingCorrections implements DrawingCorrectionRepository {
  readonly rows = new Map<string, DrawingCorrectionRecord>();
  /** handle -> kinds of rows that carry it (any file; tests use one file). */
  readonly handles = new Map<string, Set<HandleKind>>();

  private inFile(projectId: string, cadFileId: string): DrawingCorrectionRecord[] {
    return [...this.rows.values()].filter(
      (row) => row.projectId === projectId && row.cadFileId === cadFileId,
    );
  }
  private ordered(rows: DrawingCorrectionRecord[]): DrawingCorrectionRecord[] {
    return rows.sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
    );
  }

  async list(projectId: string, cadFileId: string): Promise<DrawingCorrectionRecord[]> {
    return this.ordered(this.inFile(projectId, cadFileId)).reverse();
  }
  async find(
    projectId: string,
    cadFileId: string,
    correctionId: string,
  ): Promise<DrawingCorrectionRecord | null> {
    const row = this.rows.get(correctionId);
    return row?.projectId === projectId && row.cadFileId === cadFileId ? { ...row } : null;
  }
  async countActive(projectId: string, cadFileId: string): Promise<number> {
    return this.inFile(projectId, cadFileId).filter((row) => row.withdrawnAt === null).length;
  }
  async countAll(projectId: string, cadFileId: string): Promise<number> {
    return this.inFile(projectId, cadFileId).length;
  }
  async listActiveFrozen(projectId: string, cadFileId: string): Promise<FrozenDrawingCorrection[]> {
    return this.ordered(this.inFile(projectId, cadFileId))
      .filter((row) => row.withdrawnAt === null)
      .map((row) => ({ id: row.id, correction: row.correction }));
  }
  async handleKinds(
    _projectId: string,
    _cadFileId: string,
    handles: string[],
  ): Promise<Map<string, Set<HandleKind>>> {
    const found = new Map<string, Set<HandleKind>>();
    for (const handle of handles) {
      const kinds = this.handles.get(handle);
      if (kinds) found.set(handle, kinds);
    }
    return found;
  }
  async insert(correction: NewDrawingCorrection): Promise<void> {
    this.rows.set(correction.id, {
      id: correction.id,
      projectId: correction.projectId,
      cadFileId: correction.cadFileId,
      correction: correction.correction,
      problem: correction.problem,
      createdBy: { id: correction.createdById, name: 'PM' },
      createdAt: correction.createdAt,
      withdrawnBy: null,
      withdrawnAt: null,
    });
  }
  async withdraw(
    projectId: string,
    cadFileId: string,
    correctionId: string,
    actorId: string,
    at: Date,
  ): Promise<boolean> {
    const row = this.rows.get(correctionId);
    if (row?.projectId !== projectId || row.cadFileId !== cadFileId || row.withdrawnAt) {
      return false;
    }
    this.rows.set(correctionId, {
      ...row,
      withdrawnBy: { id: actorId, name: 'PM' },
      withdrawnAt: at,
    });
    return true;
  }
}

/** Installation answers and trench marks in memory; `curves` stands in for the extracted curves. */
export class InMemoryInstallation implements InstallationRepository {
  readonly answers = new Map<string, InstallationAnswerRow>();
  readonly marks = new Map<string, TrenchMarkRecord>();
  /** handles that are curves of any file (tests use one file). */
  readonly curves = new Set<string>();

  private answersOf(projectId: string, cadFileId: string): InstallationAnswerRow[] {
    // Insertion order stands for the database `seq`: never clocks or ids.
    return [...this.answers.values()].filter(
      (row) => row.projectId === projectId && row.cadFileId === cadFileId,
    );
  }
  private marksOf(projectId: string, cadFileId: string): TrenchMarkRecord[] {
    return [...this.marks.values()].filter(
      (row) => row.projectId === projectId && row.cadFileId === cadFileId,
    );
  }

  async listAnswers(projectId: string, cadFileId: string): Promise<InstallationAnswerRow[]> {
    return this.answersOf(projectId, cadFileId).reverse();
  }
  async countAnswers(projectId: string, cadFileId: string): Promise<number> {
    return this.answersOf(projectId, cadFileId).length;
  }
  async insertAnswer(answer: NewInstallationAnswer): Promise<void> {
    this.answers.set(answer.id, {
      id: answer.id,
      projectId: answer.projectId,
      cadFileId: answer.cadFileId,
      answer: answer.answer,
      createdBy: { id: answer.createdById, name: 'PM' },
      createdAt: answer.createdAt,
    });
  }
  async listMarks(projectId: string, cadFileId: string): Promise<TrenchMarkRecord[]> {
    return this.marksOf(projectId, cadFileId).reverse();
  }
  async findMark(
    projectId: string,
    cadFileId: string,
    markId: string,
  ): Promise<TrenchMarkRecord | null> {
    const row = this.marks.get(markId);
    return row?.projectId === projectId && row.cadFileId === cadFileId ? { ...row } : null;
  }
  async countActiveMarks(projectId: string, cadFileId: string): Promise<number> {
    return this.marksOf(projectId, cadFileId).filter((row) => row.withdrawnAt === null).length;
  }
  async countAllMarks(projectId: string, cadFileId: string): Promise<number> {
    return this.marksOf(projectId, cadFileId).length;
  }
  async insertMark(mark: NewTrenchMark): Promise<void> {
    this.marks.set(mark.id, {
      id: mark.id,
      projectId: mark.projectId,
      cadFileId: mark.cadFileId,
      routeHandle: mark.routeHandle,
      lengthM: mark.lengthM,
      createdBy: { id: mark.createdById, name: 'PM' },
      createdAt: mark.createdAt,
      withdrawnBy: null,
      withdrawnAt: null,
    });
  }
  async withdrawMark(
    projectId: string,
    cadFileId: string,
    markId: string,
    actorId: string,
    at: Date,
  ): Promise<boolean> {
    const row = this.marks.get(markId);
    if (row?.projectId !== projectId || row.cadFileId !== cadFileId || row.withdrawnAt) {
      return false;
    }
    this.marks.set(markId, { ...row, withdrawnBy: { id: actorId, name: 'PM' }, withdrawnAt: at });
    return true;
  }
  async curveExists(_projectId: string, _cadFileId: string, handle: string): Promise<boolean> {
    return this.curves.has(handle);
  }
  async frozen(projectId: string, cadFileId: string): Promise<FrozenInstallation> {
    const latest = this.answersOf(projectId, cadFileId).at(-1);
    return {
      answer: latest?.answer ?? null,
      answerId: latest?.id ?? null,
      marks: this.marksOf(projectId, cadFileId)
        .filter((row) => row.withdrawnAt === null)
        .map((row) => ({ id: row.id, routeHandle: row.routeHandle, lengthM: row.lengthM })),
    };
  }
}

/** Not transactional (nothing here fails halfway); good enough to test use-case orchestration. */
export class InMemoryCadUnitOfWork implements CadUnitOfWork {
  readonly files = new InMemoryCadFiles();
  readonly mappings = new InMemoryCadMappings();
  readonly revisions = new InMemoryDesignRevisions();
  readonly links = new InMemoryTextLinks();
  readonly problems = new InMemoryDrawingProblems();
  readonly proposals = new InMemoryGpsProposals();
  readonly corrections = new InMemoryDrawingCorrections();
  readonly installation = new InMemoryInstallation();
  readonly events = new InMemoryEventLog();

  run<T>(work: (tx: CadTx) => Promise<T>): Promise<T> {
    return work({
      files: this.files,
      mappings: this.mappings,
      revisions: this.revisions,
      links: this.links,
      problems: this.problems,
      proposals: this.proposals,
      corrections: this.corrections,
      installation: this.installation,
      events: this.events,
    });
  }
}

export class RecordingJobQueue implements JobQueue {
  readonly jobs: CadImportJob[] = [];
  readonly buildJobs: CadBuildRevisionJob[] = [];
  readonly viewJobs: CadRenderViewJob[] = [];
  failWith: Error | null = null;

  async enqueueCadImport(job: CadImportJob): Promise<void> {
    if (this.failWith) throw this.failWith;
    this.jobs.push(job);
  }
  async enqueueBuildRevision(job: CadBuildRevisionJob): Promise<void> {
    if (this.failWith) throw this.failWith;
    this.buildJobs.push(job);
  }
  async enqueueRenderView(job: CadRenderViewJob): Promise<void> {
    if (this.failWith) throw this.failWith;
    this.viewJobs.push(job);
  }
}
