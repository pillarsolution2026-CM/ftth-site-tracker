import type { BoxTypeChoice, BoxTypeState } from '@ftth/shared';
import { activeChoicesOf, type BoxTypeStateModel } from '../application/box-types.use-cases.js';
import type { BoxTypeChoiceRow } from '../domain/box-types.js';

export function toBoxTypeChoiceDto(row: BoxTypeChoiceRow): BoxTypeChoice {
  return {
    id: row.id,
    cadFileId: row.cadFileId,
    shape: row.shape,
    workOrderLineId: row.workOrderLineId,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toBoxTypeStateDto(model: BoxTypeStateModel): BoxTypeState {
  return {
    cadFileId: model.file.id,
    drawingKind: model.file.drawingKind,
    applies: model.applies,
    active: activeChoicesOf(model.history).map(toBoxTypeChoiceDto),
    history: model.history.map(toBoxTypeChoiceDto),
    previousVersion: model.previousVersion,
  };
}
