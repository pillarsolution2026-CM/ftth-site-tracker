'use client';

import { useMemo, useRef, useState } from 'react';
import {
  METRES_PER_UNIT,
  withGeneralCabinetPoints,
  type CadMappingInput,
  type CadMappingView,
  type ControlPoint,
  type DrawingKind,
  type MappingTarget,
  type PlacementAdjust,
  type PlacementSourceCrs,
  type TextRole,
} from '@ftth/shared';
import { parseEpsg } from '../model/epsg';
import {
  EMPTY_MEANING,
  layersWithBadWays,
  rolesFittingTarget,
  withSuggestedMeaning,
} from '../model/layer-meaning';
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
  toPlacement,
  type PlacementFormState,
} from '../model/placement-form';

/**
 * Editable state of the mapping screen. Save is possible with a valid EPSG, every cabinet role
 * chosen and a placement that can be solved; building needs a saved mapping with no unsaved edits.
 */
export function useMappingForm(view: CadMappingView, drawingKind: DrawingKind | null = null) {
  const [state, setState] = useState<MappingFormState>(() => initialFormState(view, drawingKind));
  const [version, setVersion] = useState<number | null>(view.mapping?.version ?? null);
  // What the server holds, as a signature of the form; null until a mapping is saved.
  const [baseline, setBaseline] = useState<string | null>(() =>
    view.mapping ? formSignature(initialFormState(view, drawingKind)) : null,
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
  const badWays = layersWithBadWays(view, state);
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
    /** Route layers whose ways are not a whole number from 1 to 288. */
    badWays,
    canSave: epsg.ok && missingRoles.length === 0 && badWays.length === 0 && solved.ok,
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
    /**
     * ADR-042 part G: puts the Secondary's suggested points (ids kept, so a new suggestion replaces
     * the old one) into the placement; the PM saves as usual. Resolves with the points left out
     * because the limit was reached.
     */
    applyGeneralCabinets: (suggested: readonly ControlPoint[]): number => {
      const current = stateRef.current.placement;
      const result = withGeneralCabinetPoints(toPlacement(current), suggested, current.sourceCrs);
      changePlacement((now) => ({ ...now, points: result.placement.points }));
      return result.dropped;
    },
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
      change((current) => {
        // A role that does not fit the new target would be refused: drop it with the change.
        const old = current.meaning[layer] ?? EMPTY_MEANING;
        return {
          ...current,
          layers: { ...current.layers, [layer]: target },
          meaning: {
            ...current.meaning,
            [layer]: { ...old, roles: rolesFittingTarget(old.roles, target) },
          },
        };
      }),
    setLayerRoles: (layer: string, roles: TextRole[]) =>
      change((current) => ({
        ...current,
        meaning: {
          ...current.meaning,
          [layer]: { ...(current.meaning[layer] ?? EMPTY_MEANING), roles },
        },
      })),
    setLayerWays: (layer: string, ways: string) =>
      change((current) => ({
        ...current,
        meaning: {
          ...current.meaning,
          [layer]: { ...(current.meaning[layer] ?? EMPTY_MEANING), ways },
        },
      })),
    removeLayerAlias: (layer: string, found: string) =>
      change((current) => {
        const old = current.meaning[layer] ?? EMPTY_MEANING;
        const aliases = Object.fromEntries(
          Object.entries(old.aliases).filter(([k]) => k !== found),
        );
        return { ...current, meaning: { ...current.meaning, [layer]: { ...old, aliases } } };
      }),
    /** Fills roles and ways of layers that have none from their texts and names (asked for). */
    suggestMeaning: () => change((current) => withSuggestedMeaning(view, current, drawingKind)),
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
