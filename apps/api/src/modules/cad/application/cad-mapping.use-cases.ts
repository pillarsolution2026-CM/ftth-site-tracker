import {
  EVENT_ENTITIES,
  EVENT_TYPES,
  MAPPING_TEXT_ROWS_LIMIT,
  METRES_PER_UNIT,
  suggestBlockTarget,
  suggestLayerTarget,
  suggestTextTarget,
  type CadMappingInput,
  type MappingBlockRow,
  type MappingLayerRow,
  type MappingTextRow,
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
