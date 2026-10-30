import {
  EVENT_ENTITIES,
  EVENT_TYPES,
  type OpRejectionCode,
  type OpResult,
  type RecordUpdateOp,
  type SyncOp,
} from '@ftth/shared';
import type { Clock, IdGenerator } from '../../../common/clock.js';
import { uniqueViolation } from '../../../db/pg-errors.js';
import { operationHash } from '../domain/op-hash.js';
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
  scope: ExecutionScope;
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
      // A concurrent resend of the same op committed first: answer as a resend.
      if (uniqueViolation(error) === 'sync_operations_pkey') {
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
    op: RecordUpdateOp,
    hash: string,
  ): Promise<OpResult> {
    await tx.lockProject(input.projectId);
    const stored = await tx.findOperation(op.clientOpId);
    if (stored) return this.resendResult(input, op, hash, stored);

    try {
      return await this.record(tx, input, op, hash);
    } catch (error) {
      if (error instanceof Rejection) {
        // Not stored: the device may fix the cause (e.g. a zone is assigned) and send a new op.
        return { clientOpId: op.clientOpId, outcome: 'rejected', code: error.code };
      }
      throw error;
    }
  }

  private async record(
    tx: ExecutionTx,
    input: PushInput,
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
      input.scope,
    );
    if (!inScope) throw new Rejection('FEATURE_OUT_OF_SCOPE');

    const itemIds = [...new Set(payload.lines.map((line) => line.workOrderItemId))];
    const items = await tx.findItems(projectId, itemIds);
    if (items.length !== itemIds.length) throw new Rejection('ITEM_NOT_FOUND');
    if (items.some((item) => item.workType !== payload.workType)) {
      throw new Rejection('ITEM_WORK_TYPE_MISMATCH');
    }
    if (await tx.anyPhotoExists(payload.photos.map((photo) => photo.photoId))) {
      throw new Rejection('PHOTO_ID_REUSED');
    }

    const latest = await tx.latestPublishedRevision(projectId);
    const revisionIsLatest = latest?.id === payload.designRevisionId;
    const featureInLatestRevision = revisionIsLatest
      ? true
      : latest !== null && (await tx.featureInRevision(projectId, latest.id, payload.featureId));
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
}
