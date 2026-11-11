'use client';

import { useMemo, useState } from 'react';
import type {
  CreateDrawingCorrectionRequest,
  HandholeType,
  DrawingProblemCode,
  DrawingProblemItem,
} from '@ftth/shared';
import { errorCodeOf, errorReasonOf } from '@/shared/api/bff-client';
import { useMapping, useSaveMapping } from '@/features/cad-mapping/api/queries';
import { mappingWithAlias } from '@/features/cad-mapping/model/layer-meaning';
import { useCorrections, useCreateCorrection } from '../api/queries';
import {
  addItemRequest,
  addTextRequest,
  correctionError,
  layerNamesOf,
  mergeRoutesRequest,
  metresPerUnitOf,
  moveLayerRequest,
  pendingPlaces,
  placeKey,
  pointLayersOf,
  routePieces,
  setTextRequest,
  toolOf,
  type FixToolKind,
  type PointLayer,
} from '../model/corrections';
import type { ErrorMessage } from '../model/revision-errors';

export interface FixTools {
  /** The corrections tools are offered (draft revision and design:write). */
  enabled: boolean;
  /** Places already answered by a correction in force: fixed, gone after the rebuild. */
  isPending: (code: DrawingProblemCode, handle: string) => boolean;
  /** Every layer of the file (to move an item or label to). */
  layers: string[];
  /** Layers mapped to a point type (where an item of the label's type can go). */
  pointLayers: PointLayer[];
  metresPerUnit: number | null;
  loading: boolean;
  submit: (request: CreateDrawingCorrectionRequest) => Promise<void>;
  /** The mapping has a layer rule that reads `handhole_type` (where a confirmed type is kept). */
  canConfirmType: boolean;
  /** Keep «found means type» in the file's mapping (Q2); applies to every handhole so written. */
  confirmType: (found: string, type: HandholeType) => Promise<void>;
}

/** What the fix tools of one problem list share: pending places, the file's layers, saving. */
export function useFixTools(projectId: string, cadFileId: string, enabled: boolean): FixTools {
  const corrections = useCorrections(projectId, cadFileId, enabled);
  const mapping = useMapping(projectId, cadFileId, enabled);
  const create = useCreateCorrection(projectId, cadFileId);
  const saveMapping = useSaveMapping(projectId, cadFileId);
  const pending = useMemo(() => pendingPlaces(corrections.data?.items ?? []), [corrections.data]);
  const layers = useMemo(() => layerNamesOf(mapping.data), [mapping.data]);
  const pointLayers = useMemo(() => pointLayersOf(mapping.data), [mapping.data]);
  return {
    enabled,
    isPending: (code, handle) => pending.has(placeKey(code, handle)),
    layers,
    pointLayers,
    metresPerUnit: metresPerUnitOf(mapping.data),
    loading: corrections.isLoading || mapping.isLoading,
    submit: async (request) => {
      await create.mutateAsync(request);
    },
    canConfirmType: mappingWithAlias(mapping.data, 'x', 'DH') !== null,
    confirmType: async (found, type) => {
      const input = mappingWithAlias(mapping.data, found, type);
      if (input === null) return;
      await saveMapping.mutateAsync(input);
    },
  };
}

export interface FixForm {
  tool: FixToolKind;
  open: boolean;
  toggle: () => void;
  text: string;
  setText: (value: string) => void;
  layer: string;
  setLayer: (value: string) => void;
  /** LABEL_TYPE_MISMATCH: edit the label or place an item. */
  mismatchMode: 'edit' | 'item';
  setMismatchMode: (mode: 'edit' | 'item') => void;
  pieces: number;
  saving: boolean;
  error: ErrorMessage | null;
  /** Layers to pick from, without the one the place is already on. */
  moveLayers: string[];
  canSubmitText: boolean;
  moveSuggested: () => void;
  moveToLayer: () => void;
  saveText: () => void;
  placeItem: () => void;
  merge: () => void;
  /** HANDHOLE_TYPE_UNKNOWN: the type being confirmed, saving state, and the saved/ error notice. */
  confirmChoice: HandholeType | '';
  setConfirmChoice: (value: HandholeType | '') => void;
  confirmed: boolean;
  confirm: () => void;
}

/** The form state of one problem place: which tool, what was typed or picked, saving and errors. */
export function useFixForm(
  code: DrawingProblemCode,
  place: DrawingProblemItem,
  tools: FixTools,
  initiallyOpen = false,
): FixForm {
  const tool = toolOf(code, place);
  const [open, setOpen] = useState(initiallyOpen);
  // A cabinet with no «nB» is offered the boxes drawn under it (ADR-041 owner answers).
  const suggestedText =
    code === 'LABEL_MISSING' && place.params?.field === 'box_count' && place.params.suggested
      ? `${place.params.suggested}B`
      : '';
  const [text, setText] = useState(tool === 'add_text' ? suggestedText : (place.text ?? ''));
  const [layer, setLayer] = useState('');
  const [mismatchMode, setMismatchMode] = useState<'edit' | 'item'>('edit');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<ErrorMessage | null>(null);
  const [confirmChoice, setConfirmChoice] = useState<HandholeType | ''>('');
  const [confirmed, setConfirmed] = useState(false);

  async function run(request: CreateDrawingCorrectionRequest) {
    setSaving(true);
    setError(null);
    try {
      await tools.submit(request);
      setOpen(false);
    } catch (caught) {
      setError(correctionError(errorCodeOf(caught), errorReasonOf(caught)));
    } finally {
      setSaving(false);
    }
  }

  const trimmed = text.trim();
  return {
    tool,
    open,
    toggle: () => setOpen((value) => !value),
    text,
    setText,
    layer,
    setLayer,
    mismatchMode,
    setMismatchMode,
    pieces: routePieces(place.handle).length,
    saving,
    error,
    moveLayers: tools.layers.filter((name) => name !== place.layer),
    canSubmitText: trimmed.length > 0 && !saving,
    moveSuggested: () => {
      if (place.suggestedLayer) void run(moveLayerRequest(code, place, place.suggestedLayer));
    },
    moveToLayer: () => {
      if (layer) void run(moveLayerRequest(code, place, layer));
    },
    saveText: () => {
      if (trimmed.length === 0) return;
      void run(
        tool === 'add_text'
          ? addTextRequest(code, place, trimmed, tools.metresPerUnit)
          : setTextRequest(code, place, trimmed),
      );
    },
    placeItem: () => {
      if (layer) void run(addItemRequest(code, place, layer));
    },
    confirmChoice,
    setConfirmChoice,
    confirmed,
    confirm: () => {
      const found = place.params?.found;
      if (found === undefined || confirmChoice === '') return;
      setSaving(true);
      setError(null);
      tools
        .confirmType(found, confirmChoice)
        .then(() => setConfirmed(true))
        .catch((caught: unknown) =>
          setError(correctionError(errorCodeOf(caught), errorReasonOf(caught))),
        )
        .finally(() => setSaving(false));
    },
    merge: () => {
      if (routePieces(place.handle).length >= 2) void run(mergeRoutesRequest(code, place));
    },
  };
}
