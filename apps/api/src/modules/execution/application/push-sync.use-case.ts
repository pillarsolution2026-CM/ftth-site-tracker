import {
  EVENT_ENTITIES,
  EVENT_TYPES,
  GPS_PROPOSAL_MAX_ACCURACY_M,
  isGpsProposalFeatureType,
  type OpRejectionCode,
  type OpResult,
  type AsBuiltEdit,
  type ProposePlacementPointOp,
  type RecordAsBuiltEditOp,
  type RecordUpdateOp,
  type SyncOp,
} from '@ftth/shared';
import type { Clock, IdGenerator } from '../../../common/clock.js';
import { Decimal } from '../../work-orders/domain/decimal.js';
import {
  foreignKeyViolation,
  triggerViolationMessage,
  uniqueViolation,
} from '../../../db/pg-errors.js';
import { operationHash } from '../domain/op-hash.js';
import { computeAsBuiltFlags } from '../domain/asbuilt-flags.js';
import { computeUpdateFlags } from '../domain/update-flags.js';
import type {
  ExecutionCapabilities,
  ExecutionScope,
  ExecutionTx,
  ExecutionUnitOfWork,
  StoredOperation,
} from './ports.js';

export interface PushInput {
  projectId: string;
  userId: string;
  deviceId: string;
  /** Reach of `execution:write`; null when no assignment grants it. */
  scope: ExecutionScope | null;
  /** Reach of `asbuilt:write` (Phase 4); null when no assignment grants it. */
  asBuiltScope?: ExecutionScope | null;
  ops: readonly SyncOp[];
}

class Rejection extends Error {
  constructor(readonly code: OpRejectionCode) {
    super(code);
  }
}

/**
 * Applies a device's outbox batch (ADR-024). Each operation runs in its own transaction, so one
 * refused operation never blocks the rest, and every result is final for that `clientOpId`.
 */
const PROPOSAL_HANDLE_MAX = 64;
const PROPOSAL_CODE_MAX = 200;

export class PushSyncUseCase {
  constructor(
    private readonly uow: ExecutionUnitOfWork,
    private readonly capabilities: ExecutionCapabilities,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(input: PushInput): Promise<OpResult[]> {
    const results: OpResult[] = [];
    for (const op of input.ops) results.push(await this.applyOnce(input, op));
    return results;
  }

  private async applyOnce(input: PushInput, op: SyncOp): Promise<OpResult> {
    const hash = operationHash(op);
    try {
      return await this.uow.run((tx) => this.apply(tx, input, op, hash));
    } catch (error) {
      // The DB backstop of the contractor cap (migration 0027) disagreed with the API check:
      // reject this op instead of failing the whole batch (security review, low 4).
      const trigger = triggerViolationMessage(error);
      if (trigger?.startsWith('contractor quantity exceeded')) {
        return {
          clientOpId: op.clientOpId,
          outcome: 'rejected',
          code: 'CONTRACTOR_QUANTITY_EXCEEDED',
        };
      }
      if (
        trigger?.startsWith('the contractor line belongs to another work-order line') ||
        foreignKeyViolation(error) === 'execution_update_lines_contractor_line_fkey'
      ) {
        return {
          clientOpId: op.clientOpId,
          outcome: 'rejected',
          code: 'CONTRACTOR_LINE_NOT_FOUND',
        };
      }
      const violated = uniqueViolation(error);
      // The same photo id raced in from a push to another project (per-project locks).
      if (violated === 'execution_photos_pkey') {
        return { clientOpId: op.clientOpId, outcome: 'rejected', code: 'PHOTO_ID_REUSED' };
      }
      // The same new feature id raced in from a push to another project (per-project locks).
      if (violated === 'asbuilt_edits_one_add_idx') {
        return { clientOpId: op.clientOpId, outcome: 'rejected', code: 'FEATURE_ID_REUSED' };
      }
      // A concurrent resend of the same op committed first: answer as a resend.
      if (
        violated === 'sync_operations_pkey' ||
        violated === 'execution_updates_client_op_id_key' ||
        violated === 'asbuilt_edits_client_op_id_key' ||
        violated === 'gps_point_proposals_client_op_id_key'
      ) {
        return this.uow.run(async (tx) => {
          const stored = await tx.findOperation(op.clientOpId);
          if (!stored) throw error;
          return this.resendResult(input, op, hash, stored);
        });
      }
      throw error;
    }
  }

  /** The op id was seen before: the same op again is a duplicate, anything else a reused id. */
  private resendResult(
    input: PushInput,
    op: SyncOp,
    hash: string,
    stored: StoredOperation,
  ): OpResult {
    const same =
      stored.projectId === input.projectId &&
      stored.userId === input.userId &&
      stored.deviceId === input.deviceId &&
      stored.payloadSha256 === hash;
    if (!same || stored.result.outcome === 'rejected') {
      return { clientOpId: op.clientOpId, outcome: 'rejected', code: 'OP_ID_REUSED' };
    }
    return { clientOpId: op.clientOpId, outcome: 'duplicate', updateId: stored.result.updateId };
  }

  private async apply(
    tx: ExecutionTx,
    input: PushInput,
    op: SyncOp,
    hash: string,
  ): Promise<OpResult> {
    await tx.lockProject(input.projectId);
    const stored = await tx.findOperation(op.clientOpId);
    if (stored) return this.resendResult(input, op, hash, stored);

    try {
      if (op.kind === 'asbuilt_edit.record') {
        return await this.recordAsBuilt(tx, input, op, hash);
      }
      if (op.kind === 'placement_point.propose') {
        return await this.proposePoint(tx, input, op, hash);
      }
      // No assignment grants `execution:write`: nothing is in reach (fail closed).
      if (!input.scope) throw new Rejection('FEATURE_OUT_OF_SCOPE');
      return await this.record(tx, input, input.scope, op, hash);
    } catch (error) {
      if (error instanceof Rejection) {
        // Not stored: the device may fix the cause (e.g. a site is given to him) and send a new op.
        return { clientOpId: op.clientOpId, outcome: 'rejected', code: error.code };
      }
      throw error;
    }
  }

  private async record(
    tx: ExecutionTx,
    input: PushInput,
    scope: ExecutionScope,
    op: RecordUpdateOp,
    hash: string,
  ): Promise<OpResult> {
    const { projectId } = input;
    const { payload } = op;

    const feature = await tx.featureInPublishedRevision(
      projectId,
      payload.designRevisionId,
      payload.featureId,
    );
    if (!feature) {
      const exists = await tx.featureExists(projectId, payload.featureId);
      throw new Rejection(exists ? 'REVISION_NOT_PUBLISHED' : 'FEATURE_NOT_FOUND');
    }
    const inScope = await tx.featureInScope(
      projectId,
      payload.designRevisionId,
      payload.featureId,
      scope,
    );
    if (!inScope) throw new Rejection('FEATURE_OUT_OF_SCOPE');

    const itemIds = [...new Set(payload.lines.map((line) => line.workOrderItemId))];
    const items = await tx.findItems(projectId, itemIds);
    if (items.length !== itemIds.length) throw new Rejection('ITEM_NOT_FOUND');
    if (items.some((item) => item.workType !== payload.workType)) {
      throw new Rejection('ITEM_WORK_TYPE_MISMATCH');
    }
    await this.checkContractorLines(tx, projectId, payload.lines);
    if (await tx.anyPhotoExists(payload.photos.map((photo) => photo.photoId))) {
      throw new Rejection('PHOTO_ID_REUSED');
    }

    const latest = await tx.latestPublishedRevision(projectId, payload.designRevisionId);
    const revisionIsLatest = latest?.id === payload.designRevisionId;
    const featureInLatestRevision = revisionIsLatest
      ? true
      : latest !== null && (await tx.featureInRevision(projectId, latest.id, payload.featureId));
    // An older revision must not widen the supervisor's reach: when the feature is still in the
    // latest revision, it must be in scope there too (security review, Phase 3).
    if (
      latest &&
      !revisionIsLatest &&
      featureInLatestRevision &&
      !(await tx.featureInScope(projectId, latest.id, payload.featureId, scope))
    ) {
      throw new Rejection('FEATURE_OUT_OF_SCOPE');
    }
    const gpsDistanceM = payload.gps
      ? await tx.gpsDistanceM(projectId, payload.designRevisionId, payload.featureId, payload.gps)
      : null;
    const receivedAt = this.clock.now();
    const capturedAt = new Date(op.capturedAt);
    const flags = computeUpdateFlags({
      capturedAt,
      receivedAt,
      revisionPublishedAt: feature.revisionPublishedAt,
      gpsDistanceM,
      gpsWarningDistanceM: this.capabilities.gpsWarningDistanceM(),
      itemOverrun: await tx.wouldOverrun(projectId, payload.lines),
      revisionIsLatest,
      featureInLatestRevision,
    });

    const updateId = this.ids.next();
    const result: OpResult = { clientOpId: op.clientOpId, outcome: 'applied', updateId };
    await tx.insertOperation({
      clientOpId: op.clientOpId,
      projectId,
      userId: input.userId,
      deviceId: input.deviceId,
      kind: op.kind,
      payloadSha256: hash,
      result,
      receivedAt,
    });
    await tx.insertUpdate({
      id: updateId,
      projectId,
      clientOpId: op.clientOpId,
      featureId: payload.featureId,
      featureType: feature.featureType,
      designRevisionId: payload.designRevisionId,
      workType: payload.workType,
      userId: input.userId,
      deviceId: input.deviceId,
      capturedAt,
      receivedAt,
      label: payload.label,
      note: payload.note,
      gps: payload.gps ? { ...payload.gps, at: new Date(payload.gps.at) } : null,
      flags,
      acknowledgedWarnings: payload.acknowledgedWarnings,
      lines: payload.lines,
      photos: payload.photos.map((photo) => ({
        photoId: photo.photoId,
        requirementKey: photo.requirementKey,
        sha256: photo.sha256,
        sizeBytes: photo.sizeBytes,
        takenAt: new Date(photo.takenAt),
        gps: photo.gps,
      })),
    });
    await tx.appendEvent({
      projectId,
      entity: EVENT_ENTITIES.executionUpdate,
      entityId: updateId,
      type: EVENT_TYPES.executionUpdateRecorded,
      actorId: input.userId,
      payload: {
        clientOpId: op.clientOpId,
        deviceId: input.deviceId,
        featureId: payload.featureId,
        designRevisionId: payload.designRevisionId,
        workType: payload.workType,
        capturedAt: op.capturedAt,
        lines: payload.lines,
        photoIds: payload.photos.map((photo) => photo.photoId),
        flags,
      },
    });
    return result;
  }

  /**
   * ADR-052: a contractor line of a work line must be a line of that same work-order line in this
   * project, and the work on it (pending + approved, plus this op) stays within its quantity.
   * `self` has no cap. The rows are locked until the end of the transaction.
   */
  private async checkContractorLines(
    tx: ExecutionTx,
    projectId: string,
    lines: RecordUpdateOp['payload']['lines'],
  ): Promise<void> {
    const wanted = lines.flatMap((line) =>
      line.role === 'work' && line.performer?.kind === 'contractor'
        ? [{ contractorLineId: line.performer.contractorLineId, line }]
        : [],
    );
    if (wanted.length === 0) return;
    const ids = [...new Set(wanted.map((entry) => entry.contractorLineId))];
    const facts = new Map(
      (await tx.lockContractorLines(projectId, ids)).map((row) => [row.id, row]),
    );
    const adding = new Map<string, Decimal>();
    for (const { contractorLineId, line } of wanted) {
      const row = facts.get(contractorLineId);
      if (!row || row.workOrderItemId !== line.workOrderItemId) {
        throw new Rejection('CONTRACTOR_LINE_NOT_FOUND');
      }
      adding.set(
        contractorLineId,
        (adding.get(contractorLineId) ?? Decimal.zero).add(Decimal.parse(line.quantity)),
      );
    }
    for (const [contractorLineId, quantity] of adding) {
      const row = facts.get(contractorLineId);
      if (!row) throw new Rejection('CONTRACTOR_LINE_NOT_FOUND');
      if (
        Decimal.parse(row.recordedQuantity).add(quantity).compare(Decimal.parse(row.quantity)) > 0
      ) {
        throw new Rejection('CONTRACTOR_QUANTITY_EXCEEDED');
      }
    }
  }

  /**
   * A supervisor's GPS fix for a point item of the published drawing (ADR-037). ADR-054: only for a
   * feature of one of his sites (the owner replaced "an item in any zone"); the caller needs
   * `execution:write` (a null scope refuses). The PM decides later; nothing else changes.
   */
  private async proposePoint(
    tx: ExecutionTx,
    input: PushInput,
    op: ProposePlacementPointOp,
    hash: string,
  ): Promise<OpResult> {
    const { projectId } = input;
    const { payload } = op;
    if (!input.scope) throw new Rejection('FEATURE_OUT_OF_SCOPE');

    const target = await tx.proposalTarget(projectId, payload.designRevisionId, payload.featureId);
    if (!target) {
      const exists = await tx.featureExists(projectId, payload.featureId);
      throw new Rejection(exists ? 'REVISION_NOT_PUBLISHED' : 'FEATURE_NOT_FOUND');
    }
    if (
      !(await tx.featureInScope(
        projectId,
        payload.designRevisionId,
        payload.featureId,
        input.scope,
      ))
    ) {
      throw new Rejection('FEATURE_OUT_OF_SCOPE');
    }
    if (!isGpsProposalFeatureType(target.featureType)) {
      throw new Rejection('FEATURE_TYPE_NOT_ALLOWED');
    }
    // Handles longer than the column cannot come from a real DXF; refuse instead of a database
    // error that would make the device resend forever (security review L2).
    if (target.handle.length > PROPOSAL_HANDLE_MAX) throw new Rejection('FEATURE_NOT_FOUND');
    if (payload.fix.accuracyM > GPS_PROPOSAL_MAX_ACCURACY_M) {
      throw new Rejection('GPS_ACCURACY_TOO_LOW');
    }
    if (payload.photo && (await tx.anyPhotoExists([payload.photo.photoId]))) {
      throw new Rejection('PHOTO_ID_REUSED');
    }

    const receivedAt = this.clock.now();
    const proposalId = this.ids.next();
    const result: OpResult = {
      clientOpId: op.clientOpId,
      outcome: 'applied',
      updateId: proposalId,
    };
    await tx.insertOperation({
      clientOpId: op.clientOpId,
      projectId,
      userId: input.userId,
      deviceId: input.deviceId,
      kind: op.kind,
      payloadSha256: hash,
      result,
      receivedAt,
    });
    await tx.insertGpsProposal({
      id: proposalId,
      projectId,
      clientOpId: op.clientOpId,
      designRevisionId: payload.designRevisionId,
      featureId: payload.featureId,
      cadFileId: target.cadFileId,
      handle: target.handle,
      featureType: target.featureType,
      code: target.code === null ? null : target.code.slice(0, PROPOSAL_CODE_MAX),
      fix: { ...payload.fix, at: new Date(payload.fix.at) },
      receivedAt,
      proposedBy: input.userId,
      deviceId: input.deviceId,
      note: payload.note,
      photo: payload.photo
        ? {
            photoId: payload.photo.photoId,
            requirementKey: payload.photo.requirementKey,
            sha256: payload.photo.sha256,
            sizeBytes: payload.photo.sizeBytes,
            takenAt: new Date(payload.photo.takenAt),
            gps: payload.photo.gps,
          }
        : null,
    });
    await tx.appendEvent({
      projectId,
      entity: EVENT_ENTITIES.gpsProposal,
      entityId: proposalId,
      type: EVENT_TYPES.gpsProposalReceived,
      actorId: input.userId,
      payload: {
        clientOpId: op.clientOpId,
        deviceId: input.deviceId,
        designRevisionId: payload.designRevisionId,
        featureId: payload.featureId,
        cadFileId: target.cadFileId,
        handle: target.handle,
        lat: payload.fix.lat,
        lon: payload.fix.lon,
        accuracyM: payload.fix.accuracyM,
        photoId: payload.photo?.photoId ?? null,
      },
    });
    return result;
  }

  /**
   * One As-Built edit (ADR-030). Check order, first failure wins (phase-4 contracts): write
   * permission, published revision, target (new id for adds; known feature for the rest), tool
   * versus feature kind, geometry validity, site scope. Flags are never a rejection.
   */
  private async recordAsBuilt(
    tx: ExecutionTx,
    input: PushInput,
    op: RecordAsBuiltEditOp,
    hash: string,
  ): Promise<OpResult> {
    const { projectId } = input;
    const { payload } = op;
    const scope = input.asBuiltScope ?? null;
    if (!scope) throw new Rejection('FEATURE_OUT_OF_SCOPE');

    const revision = await tx.publishedRevision(projectId, payload.designRevisionId);
    if (!revision) throw new Rejection('REVISION_NOT_PUBLISHED');

    const isAdd = payload.kind === 'add_route' || payload.kind === 'add_symbol';
    let featureType: AsBuiltEdit['featureType'];
    let origin: 'design' | 'added' | 'new';
    if (payload.kind === 'add_route' || payload.kind === 'add_symbol') {
      if (await tx.featureIdTaken(payload.featureId)) throw new Rejection('FEATURE_ID_REUSED');
      featureType = payload.kind === 'add_route' ? 'route' : payload.featureType;
      origin = 'new';
    } else {
      const target = await tx.asBuiltTarget(projectId, payload.featureId);
      if (!target) throw new Rejection('FEATURE_NOT_FOUND');
      if (
        target.origin === 'design' &&
        !(await tx.featureInRevision(projectId, payload.designRevisionId, payload.featureId))
      ) {
        throw new Rejection('REVISION_NOT_PUBLISHED');
      }
      if (
        (payload.kind === 'move' && target.featureType === 'route') ||
        (payload.kind === 'reshape' && target.featureType !== 'route')
      ) {
        throw new Rejection('GEOMETRY_KIND_MISMATCH');
      }
      featureType = target.featureType;
      origin = target.origin;
    }

    const geometry = payload.kind === 'label' ? null : payload.geometry;
    if (geometry) {
      const facts = await tx.geometryFacts(revision.crsEpsg, geometry);
      if (!facts.valid || (featureType === 'route' && !(facts.lengthM > 0))) {
        throw new Rejection('GEOMETRY_INVALID');
      }
    }

    const latest = await tx.latestPublishedRevision(projectId, payload.designRevisionId);
    const revisionIsLatest = latest?.id === payload.designRevisionId;
    // Added features are not drawn in any design revision: they cannot be "removed" from one.
    const featureInLatestRevision =
      origin !== 'design' || revisionIsLatest
        ? true
        : latest !== null && (await tx.featureInRevision(projectId, latest.id, payload.featureId));

    if (scope.kind === 'sites') {
      if (origin === 'design') {
        const inScope = await tx.featureInScope(
          projectId,
          payload.designRevisionId,
          payload.featureId,
          scope,
        );
        if (!inScope) throw new Rejection('FEATURE_OUT_OF_SCOPE');
        // An older revision must not widen the reach (Phase 3 L8): still in the latest, then in scope there too.
        if (
          latest &&
          !revisionIsLatest &&
          featureInLatestRevision &&
          !(await tx.featureInScope(projectId, latest.id, payload.featureId, scope))
        ) {
          throw new Rejection('FEATURE_OUT_OF_SCOPE');
        }
      } else if (origin === 'added') {
        if (!(await tx.addedFeatureInScope(projectId, payload.featureId, scope))) {
          throw new Rejection('FEATURE_OUT_OF_SCOPE');
        }
      } else if (!(await tx.revisionInScope(projectId, payload.designRevisionId, scope))) {
        // A new feature is added on a drawing of one of his sites (it is linked to a site through it).
        throw new Rejection('FEATURE_OUT_OF_SCOPE');
      }
    }

    const receivedAt = this.clock.now();
    const capturedAt = new Date(op.capturedAt);
    const baseVersion = 'baseVersion' in payload ? payload.baseVersion : null;
    const flags = computeAsBuiltFlags({
      kind: payload.kind,
      baseVersion,
      current: isAdd
        ? { geometryVersion: 0, labelVersion: 0 }
        : await tx.approvedVersions(projectId, payload.featureId),
      capturedAt,
      receivedAt,
      revisionIsLatest,
      featureInLatestRevision,
    });

    const editId = this.ids.next();
    const result: OpResult = { clientOpId: op.clientOpId, outcome: 'applied', updateId: editId };
    const label = 'label' in payload ? payload.label : null;
    await tx.insertOperation({
      clientOpId: op.clientOpId,
      projectId,
      userId: input.userId,
      deviceId: input.deviceId,
      kind: op.kind,
      payloadSha256: hash,
      result,
      receivedAt,
    });
    const { lengthM } = await tx.insertAsBuiltEdit({
      id: editId,
      projectId,
      clientOpId: op.clientOpId,
      featureId: payload.featureId,
      kind: payload.kind,
      featureType,
      designRevisionId: payload.designRevisionId,
      baseVersion,
      geometry,
      srid: revision.crsEpsg,
      label,
      note: payload.note,
      userId: input.userId,
      deviceId: input.deviceId,
      capturedAt,
      receivedAt,
      gps: payload.gps ? { ...payload.gps, at: new Date(payload.gps.at) } : null,
      flags,
    });
    await tx.appendEvent({
      projectId,
      entity: EVENT_ENTITIES.asBuiltEdit,
      entityId: editId,
      type: EVENT_TYPES.asBuiltEditRecorded,
      actorId: input.userId,
      payload: {
        clientOpId: op.clientOpId,
        deviceId: input.deviceId,
        featureId: payload.featureId,
        kind: payload.kind,
        baseVersion,
        geometry,
        label,
        lengthM,
        flags,
      },
    });
    return result;
  }
}
