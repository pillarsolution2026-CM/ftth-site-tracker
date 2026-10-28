'use client';

import { useMemo, useRef, useState } from 'react';
import type { CadMappingInput, CadMappingView, DrawingUnit, MappingTarget } from '@ftth/shared';
import { parseEpsg } from '../model/epsg';
import {
  buildMappingInput,
  formSignature,
  initialFormState,
  textRuleRows,
  type BlockChoice,
  type MappingFormState,
  type TextChoice,
} from '../model/mapping-form';
import { unitWarnings } from '../model/unit-warnings';

/**
 * Editable state of the mapping screen. Save is possible only with a valid EPSG and a chosen
 * drawing unit (no default, ADR-018); building needs a saved mapping with no unsaved edits.
 */
export function useMappingForm(view: CadMappingView) {
  const [state, setState] = useState<MappingFormState>(() => initialFormState(view));
  const [version, setVersion] = useState<number | null>(view.mapping?.version ?? null);
  // What the server holds, as a signature of the form; null until a mapping is saved.
  const [baseline, setBaseline] = useState<string | null>(() =>
    view.mapping ? formSignature(initialFormState(view)) : null,
  );
  const [justSavedVersion, setJustSavedVersion] = useState<number | null>(null);
  const [epsgTouched, setEpsgTouched] = useState(false);

  const change = (update: (current: MappingFormState) => MappingFormState) => {
    setState(update);
    setJustSavedVersion(null);
  };

  const stateRef = useRef(state);
  stateRef.current = state;

  const epsg = parseEpsg(state.epsg);
  const signature = formSignature(state);
  const textRows = useMemo(() => textRuleRows(view), [view]);

  return {
    state,
    textRows,
    epsgError: !epsg.ok && (epsgTouched || state.epsg.trim() !== '') ? epsg.error : null,
    warnings: unitWarnings(view.crsDetection, state.unit === '' ? null : state.unit),
    unitChosen: state.unit !== '',
    canSave: state.unit !== '' && epsg.ok,
    savedVersion: version,
    justSavedVersion,
    dirty: baseline === null || baseline !== signature,
    canBuild: version !== null && baseline === signature,
    setEpsg: (value: string) => {
      setEpsgTouched(true);
      change((current) => ({ ...current, epsg: value }));
    },
    setUnit: (unit: DrawingUnit | '') => change((current) => ({ ...current, unit })),
    setLayerTarget: (layer: string, target: MappingTarget) =>
      change((current) => ({ ...current, layers: { ...current.layers, [layer]: target } })),
    setBlockChoice: (block: string, choice: BlockChoice) =>
      change((current) => ({ ...current, blocks: { ...current.blocks, [block]: choice } })),
    setTextChoice: (key: string, choice: TextChoice) =>
      change((current) => ({ ...current, texts: { ...current.texts, [key]: choice } })),
    /** The payload to send, or null while the form is not valid. */
    prepareSave: (): { input: CadMappingInput; signature: string } | null => {
      const input = buildMappingInput(view, state, version);
      return input ? { input, signature } : null;
    },
    /** `signature` is the one captured when the request was sent (edits may have happened since). */
    markSaved: (savedVersion: number, savedSignature: string) => {
      setVersion(savedVersion);
      setBaseline(savedSignature);
      setJustSavedVersion(savedSignature === formSignature(stateRef.current) ? savedVersion : null);
    },
  };
}
