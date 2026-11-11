import { createProjectCrs } from '@ftth/geo';
import {
  drawingAtOf,
  matchSharedCabinets,
  type GeneralCabinetPosition,
  type SecondaryCabinetDrawn,
  type SecondaryPlacementRefusal,
  type SecondaryPlacementSuggestion,
} from '@ftth/shared';
import { AppError } from '../../../common/app-error.js';
import type { CadUnitOfWork } from '../domain/cad-file.repository.js';

const MESSAGES: Record<SecondaryPlacementRefusal, string> = {
  NOT_SECONDARY: 'Only a Secondary drawing is placed from the General cabinets',
  NOT_CURRENT: 'A newer version of this Secondary drawing was uploaded',
  SECONDARY_BUILDING: 'The Secondary drawing is still being built',
  SECONDARY_NOT_BUILT: 'The Secondary drawing has no built revision yet; build it first',
  SECONDARY_REBUILD_NEEDED:
    'The Secondary drawing was built before cabinet positions were kept; rebuild it',
  GENERAL_BUILDING: 'The General drawing is still being built',
  GENERAL_NOT_BUILT: 'The General drawing has no built revision yet; upload and build it first',
  GENERAL_NOT_PLACED: 'The General drawing has no placement with a control point in use',
};

const refuse = (reason: SecondaryPlacementRefusal, revisionId: string | null = null): AppError =>
  new AppError('CONFLICT', MESSAGES[reason], { reason, revisionId });

/**
 * «من كبائن الرئيسي» (ADR-040 Q9, ADR-042 part G): the control points of a Secondary taken from the
 * sub cabinets it shares, by name, with the placed General. Read-only: nothing is saved and no event
 * is written; the PM checks the errors per point, saves the mapping and rebuilds as usual.
 */
export class GetSecondaryPlacementSuggestionUseCase {
  constructor(private readonly uow: CadUnitOfWork) {}

  execute(projectId: string, cadFileId: string): Promise<SecondaryPlacementSuggestion> {
    return this.uow.run(async (tx) => {
      const file = await tx.files.find(projectId, cadFileId);
      if (!file) throw new AppError('NOT_FOUND', 'CAD file not found');
      if (file.drawingKind !== 'secondary') throw refuse('NOT_SECONDARY');
      if (file.supersededAt !== null) throw refuse('NOT_CURRENT');

      // The Secondary: a revision still queued or building makes any older one stale.
      const openSecondary = await tx.revisions.findOpen(projectId, 'secondary');
      if (openSecondary?.cadFileId === file.id && openSecondary.status !== 'draft') {
        throw refuse('SECONDARY_BUILDING', openSecondary.id);
      }
      const secondary = await tx.revisions.findLatestBuiltOfFile(projectId, file.id);
      if (!secondary) throw refuse('SECONDARY_NOT_BUILT');
      const secondaryCabinets = await tx.revisions.subCabinetPositions(projectId, secondary.id);
      if (
        secondaryCabinets.length > 0 &&
        secondaryCabinets.every((c) => drawingAtOf(c.attrs) === null)
      ) {
        throw refuse('SECONDARY_REBUILD_NEEDED', secondary.id);
      }

      // The General: the current file of that kind and its latest built revision.
      const [generalFile] = await tx.files.listCurrentOfKind(projectId, 'general');
      if (!generalFile) throw refuse('GENERAL_NOT_BUILT');
      const openGeneral = await tx.revisions.findOpen(projectId, 'general');
      if (openGeneral?.cadFileId === generalFile.id && openGeneral.status !== 'draft') {
        throw refuse('GENERAL_BUILDING', openGeneral.id);
      }
      const general = await tx.revisions.findLatestBuiltOfFile(projectId, generalFile.id);
      if (!general) throw refuse('GENERAL_NOT_BUILT');
      if (!general.placement || general.placement.points.every((p) => p.excluded)) {
        throw refuse('GENERAL_NOT_PLACED', general.id);
      }
      if (general.status !== 'draft' && general.status !== 'published') {
        throw refuse('GENERAL_NOT_BUILT');
      }

      // Project CRS (metres) -> Lat/Lon, through the one transform place (@ftth/geo).
      const crs = createProjectCrs(general.crsEpsg);
      const generalCabinets: GeneralCabinetPosition[] = (
        await tx.revisions.subCabinetPositions(projectId, general.id)
      ).map((c) => {
        const { lat, lon } = crs.toWgs84({ x: c.x, y: c.y });
        return { name: c.code, lat, lon };
      });
      const drawn: SecondaryCabinetDrawn[] = secondaryCabinets.map((c) => ({
        name: c.code,
        handle: c.sourceHandle,
        drawingAt: drawingAtOf(c.attrs),
      }));
      const matched = matchSharedCabinets(generalCabinets, drawn);

      return {
        cadFileId: file.id,
        secondaryRevisionId: secondary.id,
        general: {
          cadFileId: generalFile.id,
          revisionId: general.id,
          status: general.status,
          revNo: general.revNo,
        },
        points: matched.points,
        matchedCount: matched.matchedCount,
        truncated: matched.truncated,
        unmatched: matched.unmatched,
      };
    });
  }
}
