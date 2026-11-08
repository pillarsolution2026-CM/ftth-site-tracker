import type { Readable } from 'node:stream';
import {
  EVENT_ENTITIES,
  EVENT_TYPES,
  MAX_CONTROL_POINTS,
  PlacementSchema,
  type ControlPoint,
  type GpsProposalListQuery,
} from '@ftth/shared';
import { AppError } from '../../../common/app-error.js';
import type { Clock } from '../../../common/clock.js';
import type { ObjectStorage } from '../../../common/object-storage.port.js';
import type { CadUnitOfWork } from '../domain/cad-file.repository.js';
import type { GpsProposalRecord, GpsProposalRepository } from '../domain/gps-proposal.js';

async function requireProposal(
  proposals: GpsProposalRepository,
  projectId: string,
  proposalId: string,
  lock = false,
): Promise<GpsProposalRecord> {
  const proposal = await proposals.find(projectId, proposalId, { lock });
  if (!proposal) throw new AppError('NOT_FOUND', 'GPS point proposal not found');
  return proposal;
}

const alreadyDecided = (proposal: GpsProposalRecord): AppError =>
  new AppError('CONFLICT', 'The proposal was already decided', {
    reason: 'ALREADY_DECIDED',
    status: proposal.status,
  });

export class ListGpsProposalsUseCase {
  constructor(private readonly proposals: GpsProposalRepository) {}

  execute(projectId: string, query: GpsProposalListQuery): Promise<GpsProposalRecord[]> {
    return this.proposals.list(projectId, query);
  }
}

/** The photo a supervisor attached; NOT_FOUND when there is none or it is still uploading. */
export class GetGpsProposalPhotoUseCase {
  constructor(
    private readonly proposals: GpsProposalRepository,
    private readonly storage: ObjectStorage,
  ) {}

  async execute(
    projectId: string,
    proposalId: string,
  ): Promise<{ stream: Readable; sizeBytes: number }> {
    const photo = await this.proposals.photo(projectId, proposalId);
    if (!photo?.storageKey) throw new AppError('NOT_FOUND', 'Photo not found');
    const stat = await this.storage.stat(photo.storageKey);
    if (!stat) throw new AppError('NOT_FOUND', 'Photo not found');
    return { stream: await this.storage.get(photo.storageKey), sizeBytes: stat.sizeBytes };
  }
}

/**
 * Accepting adds the fix as a `gps` control point to the mapping of the file the revision was
 * built from, as a new mapping version (ADR-037). It never starts a build: the PM presses «ابني»
 * when ready. The last accepted GPS point of an item replaces its earlier GPS points; typed and
 * KML points stay.
 */
export class AcceptGpsProposalUseCase {
  constructor(
    private readonly uow: CadUnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(input: {
    projectId: string;
    proposalId: string;
    actorId: string;
    mappingVersion: number;
  }): Promise<GpsProposalRecord> {
    const { projectId, proposalId, actorId } = input;
    return this.uow.run(async (tx) => {
      const proposal = await requireProposal(tx.proposals, projectId, proposalId, true);
      if (proposal.status !== 'pending') throw alreadyDecided(proposal);

      // Same lock order and file check as saving the mapping: file, then mapping (security
      // review L1); a file being re-extracted has rows about to be replaced.
      const file = await tx.files.find(projectId, proposal.cadFileId, { lock: true });
      if (file?.status !== 'processed') {
        throw new AppError('CONFLICT', 'The CAD file is not processed yet', {
          reason: 'NOT_PROCESSED',
          status: file?.status ?? null,
        });
      }
      const mapping = await tx.mappings.find(projectId, proposal.cadFileId, { lock: true });
      if (!mapping) {
        throw new AppError('CONFLICT', 'The file has no saved mapping', {
          reason: 'NO_MAPPING',
          currentVersion: null,
        });
      }
      if (mapping.version !== input.mappingVersion) {
        throw new AppError('CONFLICT', 'The mapping was changed by someone else', {
          reason: 'VERSION_MISMATCH',
          currentVersion: mapping.version,
        });
      }

      const drawing = await tx.proposals.drawnCentre(projectId, proposal);
      if (!drawing) {
        throw new AppError('CONFLICT', 'The item is no longer in the drawing', {
          reason: 'ITEM_NOT_LOCATED',
        });
      }
      const point: ControlPoint = {
        id: proposal.id,
        drawing,
        handle: proposal.handle,
        label: proposal.code ?? proposal.handle,
        lat: proposal.lat,
        lon: proposal.lon,
        source: 'gps',
        excluded: false,
      };
      const current = mapping.placement;
      const points = [
        ...(current?.points ?? []).filter(
          (existing) => !(existing.source === 'gps' && existing.handle === proposal.handle),
        ),
        point,
      ];
      if (points.length > MAX_CONTROL_POINTS) {
        throw new AppError('CONFLICT', 'Too many control points', {
          reason: 'TOO_MANY_POINTS',
          max: MAX_CONTROL_POINTS,
        });
      }
      const placement = PlacementSchema.parse({ ...(current ?? {}), points });

      const saved = await tx.mappings.update(
        {
          cadFileId: mapping.cadFileId,
          projectId,
          rules: mapping.rules,
          crsEpsg: mapping.crsEpsg,
          drawingUnit: mapping.drawingUnit,
          metresPerUnit: mapping.metresPerUnit,
          placement,
          updatedById: actorId,
          updatedAt: this.clock.now(),
        },
        mapping.version,
      );
      if (!saved) {
        throw new AppError('CONFLICT', 'The mapping was changed by someone else', {
          reason: 'VERSION_MISMATCH',
        });
      }
      const decidedAt = this.clock.now();
      const decided = await tx.proposals.decide(projectId, proposalId, {
        status: 'accepted',
        decidedBy: actorId,
        decidedAt,
        mappingVersion: saved.version,
      });
      if (!decided) throw alreadyDecided(proposal);

      await tx.events.append({
        projectId,
        entity: EVENT_ENTITIES.cadMapping,
        entityId: mapping.cadFileId,
        type: EVENT_TYPES.cadMappingSaved,
        actorId,
        payload: {
          version: saved.version,
          crsEpsg: saved.crsEpsg,
          drawingUnit: saved.drawingUnit,
          ruleCount: saved.rules.length,
          gpsProposalId: proposal.id,
        },
      });
      await tx.events.append({
        projectId,
        entity: EVENT_ENTITIES.gpsProposal,
        entityId: proposal.id,
        type: EVENT_TYPES.gpsProposalAccepted,
        actorId,
        payload: {
          cadFileId: proposal.cadFileId,
          handle: proposal.handle,
          featureId: proposal.featureId,
          pointId: point.id,
          mappingVersion: saved.version,
          pointCount: points.length,
        },
      });
      return requireProposal(tx.proposals, projectId, proposalId);
    });
  }
}

export class RejectGpsProposalUseCase {
  constructor(
    private readonly uow: CadUnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(input: {
    projectId: string;
    proposalId: string;
    actorId: string;
    reason: string;
  }): Promise<GpsProposalRecord> {
    const { projectId, proposalId, actorId, reason } = input;
    return this.uow.run(async (tx) => {
      const proposal = await requireProposal(tx.proposals, projectId, proposalId, true);
      if (proposal.status !== 'pending') throw alreadyDecided(proposal);
      const decided = await tx.proposals.decide(projectId, proposalId, {
        status: 'rejected',
        decidedBy: actorId,
        decidedAt: this.clock.now(),
        reason,
      });
      if (!decided) throw alreadyDecided(proposal);
      await tx.events.append({
        projectId,
        entity: EVENT_ENTITIES.gpsProposal,
        entityId: proposalId,
        type: EVENT_TYPES.gpsProposalRejected,
        actorId,
        payload: {
          cadFileId: proposal.cadFileId,
          handle: proposal.handle,
          featureId: proposal.featureId,
          reason,
        },
      });
      return requireProposal(tx.proposals, projectId, proposalId);
    });
  }
}
