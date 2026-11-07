'use client';

import { useMemo, useRef, useState } from 'react';
import {
  METRES_PER_UNIT,
  type CadMappingInput,
  type CadMappingView,
  type ControlPoint,
  type MappingTarget,
  type PlacementAdjust,
  type PlacementSourceCrs,
} from '@ftth/shared';
import { parseEpsg } from '../model/epsg';
import {
  EMPTY_ATTRS,
  buildMappingInput,
  cabinetsWithoutRole,
  formSignature,
  initialFormState,
  textRuleRows,
  type BlockChoice,
  type MappingFormState,
  type RuleAttrsForm,
  type TextChoice,
} from '../model/mapping-form';
import {
  NEUTRAL_ADJUST,
  nextPointId,
  solveState,
  type PlacementFormState,
} from '../model/placement-form';

/**
 * Editable state of the mapping screen. Save is possible with a valid EPSG, every cabinet role
 * chosen and a placement that can be solved; building needs a saved mapping with no unsaved edits.
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
  const missingRoles = cabinetsWithoutRole(view, state);
  const projectEpsg = epsg.ok ? epsg.value : view.projectEpsg;
  const metresPerUnit = Number(METRES_PER_UNIT[state.unit]);
  const solved = useMemo(
    () => solveState(state.placement, projectEpsg, metresPerUnit),
    [state.placement, projectEpsg, metresPerUnit],
  );
  const changePlacement = (update: (current: PlacementFormState) => PlacementFormState) =>
    change((current) => ({ ...current, placement: update(current.placement) }));

  return {
    state,
    textRows,
    epsgError: !epsg.ok && (epsgTouched || state.epsg.trim() !== '') ? epsg.error : null,
    /** Rows mapped to `cabinet` whose role (main / sub) is not chosen yet. */
    missingRoles,
    /** The placement solved in the browser, as the build will (ADR-035). */
    solved,
    projectEpsg,
    metresPerUnit,
    canSave: epsg.ok && missingRoles.length === 0 && solved.ok,
    savedVersion: version,
    justSavedVersion,
    dirty: baseline === null || baseline !== signature,
    canBuild: version !== null && baseline === signature,
    setEpsg: (value: string) => {
      setEpsgTouched(true);
      change((current) => ({ ...current, epsg: value }));
    },
    setSourceCrs: (sourceCrs: PlacementSourceCrs) =>
      changePlacement((current) => ({ ...current, sourceCrs })),
    addPoints: (points: Omit<ControlPoint, 'id'>[]) =>
      changePlacement((current) => {
        const all = [...current.points];
        for (const point of points) all.push({ ...point, id: nextPointId(all) });
        return { ...current, points: all };
      }),
    updatePoint: (id: string, patch: Partial<Omit<ControlPoint, 'id'>>) =>
      changePlacement((current) => ({
        ...current,
        points: current.points.map((point) => (point.id === id ? { ...point, ...patch } : point)),
      })),
    removePoint: (id: string) =>
      changePlacement((current) => ({
        ...current,
        points: current.points.filter((point) => point.id !== id),
      })),
    setFitScaleWithTwoPoints: (value: boolean) =>
      changePlacement((current) => ({ ...current, fitScaleWithTwoPoints: value })),
    setAdjust: (adjust: PlacementAdjust) => changePlacement((current) => ({ ...current, adjust })),
    resetAdjust: () =>
      changePlacement((current) => ({ ...current, adjust: { ...NEUTRAL_ADJUST } })),
    setLayerTarget: (layer: string, target: MappingTarget) =>
      change((current) => ({ ...current, layers: { ...current.layers, [layer]: target } })),
    setBlockChoice: (block: string, choice: BlockChoice) =>
      change((current) => ({ ...current, blocks: { ...current.blocks, [block]: choice } })),
    setTextChoice: (key: string, choice: TextChoice) =>
      change((current) => ({ ...current, texts: { ...current.texts, [key]: choice } })),
    setRuleAttrs: (key: string, patch: Partial<RuleAttrsForm>) =>
      change((current) => ({
        ...current,
        attrs: { ...current.attrs, [key]: { ...(current.attrs[key] ?? EMPTY_ATTRS), ...patch } },
      })),
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
