import {
  EVENT_ENTITIES,
  EVENT_TYPES,
  MAPPING_TEXT_ROWS_LIMIT,
  PLACEMENT_DRAWING_MAX_LINES,
  mappingKindProblems,
  METRES_PER_UNIT,
  suggestBlockTarget,
  suggestLayerTarget,
  suggestTextTarget,
  type CadMappingInput,
  type MappingBlockRow,
  type MappingLayerRow,
  type MappingTextRow,
  type PlacementDrawing,
} from '@ftth/shared';
import { AppError } from '../../../common/app-error.js';
import type { Clock } from '../../../common/clock.js';
import type { CadFile } from '../domain/cad-file.js';
import type {
  CadExtractionQueries,
  CadFileRepository,
  CadUnitOfWork,
} from '../domain/cad-file.repository.js';
import type { CadMappingRecord } from '../domain/cad-mapping.js';
import type {
  CadMappingRepository,
  CadMappingViewQueries,
  PlacementDrawingLimits,
} from '../domain/design-revision.repository.js';
import type { ProjectEpsgLookup } from './ports.js';

/** Everything the mapping screen shows; the interface layer turns it into `CadMappingView`. */
export interface CadMappingViewModel {
  file: CadFile;
  projectEpsg: number;
  layers: MappingLayerRow[];
  blocks: MappingBlockRow[];
  texts: MappingTextRow[];
  mapping: CadMappingRecord | null;
}

/**
 * Technical tuning of the placement screen, not business rules: route lines are simplified to
 * about 0.5 m; a short text (up to 20 characters) names its nearest item within 80 m, as a hint
 * only (Rabaa writes cabinet names 30-70 m from the symbol, on another layer).
 */
export const PLACEMENT_DRAWING_LIMITS: PlacementDrawingLimits = {
  maxLines: PLACEMENT_DRAWING_MAX_LINES,
  toleranceM: 0.5,
  nameRadiusM: 80,
  nameMaxChars: 20,
};

/**
 * What the placement screen draws and picks control points from (ADR-035, ADR-037): the point
 * items and route lines of the uploaded file classified by its saved mapping, in drawing units.
 */
export class GetPlacementDrawingUseCase {
  constructor(
    private readonly files: CadFileRepository,
    private readonly view: CadMappingViewQueries,
  ) {}

  async execute(projectId: string, cadFileId: string): Promise<PlacementDrawing> {
    const file = await this.files.find(projectId, cadFileId);
    if (!file) throw new AppError('NOT_FOUND', 'CAD file not found');
    return this.view.placementDrawing(projectId, cadFileId, PLACEMENT_DRAWING_LIMITS);
  }
}

export class GetCadMappingUseCase {
  constructor(
    private readonly files: CadFileRepository,
    private readonly mappings: CadMappingRepository,
    private readonly extraction: CadExtractionQueries,
    private readonly view: CadMappingViewQueries,
    private readonly projects: ProjectEpsgLookup,
  ) {}

  async execute(projectId: string, cadFileId: string): Promise<CadMappingViewModel> {
    const file = await this.files.find(projectId, cadFileId);
    if (!file) throw new AppError('NOT_FOUND', 'CAD file not found');
    const [projectEpsg, mapping] = await Promise.all([
      this.projects.epsgOf(projectId),
      this.mappings.find(projectId, cadFileId),
    ]);
    // While a (re)run is in flight the rows of an earlier run are about to be replaced: show none.
    if (file.status !== 'processed') {
      return { file, projectEpsg, layers: [], blocks: [], texts: [], mapping };
    }

    const [layers, blocks, texts] = await Promise.all([
      this.extraction.layers(projectId, cadFileId),
      this.view.blocks(projectId, cadFileId),
      this.view.texts(projectId, cadFileId, MAPPING_TEXT_ROWS_LIMIT),
    ]);
    return {
      file,
      projectEpsg,
      mapping,
      layers: layers.map((layer) => {
        const suggestion = suggestLayerTarget(layer.name);
        return {
          name: layer.name,
          aciColor: layer.aciColor,
          trueColor: layer.trueColor,
          isOn: layer.isOn,
          entityCounts: layer.entityCounts,
          entityTotal: layer.entityTotal,
          suggestedTarget: suggestion.target,
          suggestionSource: suggestion.source,
        };
      }),
      blocks: blocks.map((block) => ({
        name: block.name,
        count: block.count,
        layers: block.layers,
        suggestedTarget: suggestBlockTarget(block.name),
      })),
      texts: texts.map((text) => ({
        layer: text.layer,
        text: text.text,
        count: text.count,
        suggestedTarget: suggestTextTarget(text.text),
      })),
    };
  }
}

export class SaveCadMappingUseCase {
  constructor(
    private readonly uow: CadUnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(input: {
    projectId: string;
    cadFileId: string;
    actorId: string;
    mapping: CadMappingInput;
  }): Promise<CadMappingRecord> {
    const { projectId, cadFileId, actorId, mapping } = input;
    return this.uow.run(async (tx) => {
      // The file row lock serialises concurrent first saves (there is no mapping row to lock yet).
      const file = await tx.files.find(projectId, cadFileId, { lock: true });
      if (!file) throw new AppError('NOT_FOUND', 'CAD file not found');
      if (file.status !== 'processed') {
        throw new AppError('CONFLICT', 'The CAD file is not processed yet', {
          reason: 'NOT_PROCESSED',
          status: file.status,
        });
      }

      // ADR-041: text roles and zone layers must suit the drawing kind of the file.
      const kindProblems = mappingKindProblems(mapping.rules, file.drawingKind);
      if (kindProblems.length > 0) {
        throw new AppError(
          'VALIDATION_FAILED',
          'The mapping has rules that do not suit the drawing kind',
          {
            reason: kindProblems[0]?.reason,
            drawingKind: file.drawingKind,
            problems: kindProblems,
          },
          422,
        );
      }

      const current = await tx.mappings.find(projectId, cadFileId, { lock: true });
      if ((current?.version ?? null) !== mapping.version) {
        throw new AppError('CONFLICT', 'The mapping was changed by someone else', {
          reason: 'VERSION_MISMATCH',
          currentVersion: current?.version ?? null,
        });
      }

      const next = {
        cadFileId,
        projectId,
        rules: mapping.rules,
        crsEpsg: mapping.crsEpsg,
        drawingUnit: mapping.drawingUnit,
        metresPerUnit: METRES_PER_UNIT[mapping.drawingUnit],
        placement: mapping.placement,
        updatedById: actorId,
        updatedAt: this.clock.now(),
      };
      const saved = current
        ? await tx.mappings.update(next, current.version)
        : await tx.mappings.insert(next);
      if (!saved) {
        throw new AppError('CONFLICT', 'The mapping was changed by someone else', {
          reason: 'VERSION_MISMATCH',
        });
      }

      await tx.events.append({
        projectId,
        entity: EVENT_ENTITIES.cadMapping,
        entityId: cadFileId,
        type: EVENT_TYPES.cadMappingSaved,
        actorId,
        payload: {
          version: saved.version,
          crsEpsg: saved.crsEpsg,
          drawingUnit: saved.drawingUnit,
          ruleCount: saved.rules.length,
        },
      });
      return saved;
    });
  }
}
