import {
  contractItemGroupInputs,
  effectiveItemGroup,
  parentCodeOf,
  type GroupableLine,
  type ItemGroupState,
  type ManualItemGroup,
} from '@ftth/shared';

/** A BOQ line as the group rule reads it (the parent heading is derived from the codes). */
export type GroupSourceLine = Omit<GroupableLine, 'parentCode'>;

/**
 * Group state (ADR-048) of every priced line of a BOQ, keyed by line id: the admin's latest choice,
 * else the system rule, else `none`. Headings are not in the map.
 */
export function itemGroupStates(
  lines: readonly GroupSourceLine[],
  manual: ReadonlyMap<string, ManualItemGroup>,
): Map<string, ItemGroupState> {
  const codes = new Set(lines.map((line) => line.code));
  const groupable: GroupableLine[] = lines.map((line) => ({
    id: line.id,
    kind: line.kind,
    code: line.code,
    description: line.description,
    unit: line.unit,
    parentCode: parentCodeOf(line.code, codes),
  }));
  const states = new Map<string, ItemGroupState>();
  for (const [id, input] of contractItemGroupInputs(groupable)) {
    states.set(id, effectiveItemGroup(input, manual.get(id)));
  }
  return states;
}
