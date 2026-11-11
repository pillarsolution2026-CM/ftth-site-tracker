import type { CadMapping, CadMappingView, MappingRule } from '@ftth/shared';
import { describe, expect, it } from 'vitest';
import {
  layerMeaningFields,
  layerTargetsFor,
  layersWithBadWays,
  mappingWithAlias,
  parseWays,
  roleNotForKind,
  roleOptionsFor,
  rolesFittingTarget,
  suggestMeaning,
  withSuggestedMeaning,
} from './layer-meaning';
import { buildMappingInput, formSignature, initialFormState } from './mapping-form';
import { CAD_FILE_ID, mappingView } from './mapping-fixtures';

/** A Secondary like Al-Fath: number / cabinet texts, a 12-way bundle layer, a cabinet layer. */
function secondaryView(overrides: Partial<CadMappingView> = {}): CadMappingView {
  const layer = (
    name: string,
    suggestedTarget: CadMappingView['layers'][number]['suggestedTarget'],
  ) => ({
    name,
    aciColor: 7,
    trueColor: null,
    isOn: true,
    entityCounts: { TEXT: 10 },
    entityTotal: 10,
    suggestedTarget,
    suggestionSource: 'name_pattern' as const,
  });
  return mappingView({
    layers: [
      layer('TXTNMPER', 'label'),
      layer('TXTCAP', 'label'),
      layer('1X12w Line', 'route'),
      layer('CABINA', 'cabinet'),
    ],
    blocks: [],
    texts: [
      { layer: 'TXTNMPER', text: '9', count: 40, suggestedTarget: null },
      { layer: 'TXTNMPER', text: '12', count: 30, suggestedTarget: null },
      { layer: 'TXTCAP', text: '1-3', count: 25, suggestedTarget: null },
      { layer: 'CABINA', text: '22U', count: 8, suggestedTarget: null },
      { layer: 'CABINA', text: '22B', count: 8, suggestedTarget: null },
    ],
    ...overrides,
  });
}

function savedWith(rules: CadMapping['rules']): CadMapping {
  return {
    cadFileId: CAD_FILE_ID,
    rules,
    crsEpsg: 32636,
    drawingUnit: 'm',
    metresPerUnit: '1',
    placement: null,
    version: 4,
    updatedById: null,
    updatedAt: '2026-11-11T10:00:00.000Z',
  };
}

describe('role options by drawing kind', () => {
  it('offers only the roles the kind reads and the target takes', () => {
    expect(roleOptionsFor('secondary', 'label', [])).toEqual([
      'bundle_spare',
      'bundle_label',
      'box_cable_type',
      'box_cable_length',
      'box_cabinet',
      'box_number',
      'cabinet_info',
    ]);
    expect(roleOptionsFor('general', 'label', [])).toEqual([
      'cable_spare',
      'cable_label',
      'bundle_label',
      'handhole_type',
      'handhole_number',
      'cabinet_info',
    ]);
  });

  it('offers a role only on the target of its feature type (cabinet_info on the cabinet layer)', () => {
    expect(roleOptionsFor('secondary', 'cabinet', [])).toEqual(['cabinet_info']);
    expect(roleOptionsFor('general', 'hhi', [])).toEqual(['handhole_type', 'handhole_number']);
    expect(roleOptionsFor('secondary', 'background', [])).toEqual([]);
  });

  it('keeps an already chosen role visible even if the kind does not read it', () => {
    expect(roleOptionsFor('secondary', 'label', ['handhole_type'])).toContain('handhole_type');
    expect(roleNotForKind('secondary', 'handhole_type')).toBe(true);
    expect(roleNotForKind('general', 'handhole_type')).toBe(false);
    expect(roleNotForKind(null, 'handhole_type')).toBe(false);
  });

  it('offers nothing new while the kind is unknown', () => {
    expect(roleOptionsFor(null, 'label', [])).toEqual([]);
  });

  it('offers the zone target only to a Secondary (or when it is already chosen)', () => {
    expect(layerTargetsFor('secondary', 'label')).toContain('zone');
    expect(layerTargetsFor('general', 'label')).not.toContain('zone');
    expect(layerTargetsFor(null, 'label')).not.toContain('zone');
    expect(layerTargetsFor('general', 'zone')).toContain('zone');
  });

  it('drops roles that no longer fit when the target changes', () => {
    expect(rolesFittingTarget(['box_number', 'cabinet_info'], 'cabinet')).toEqual(['cabinet_info']);
    expect(rolesFittingTarget(['box_number'], 'background')).toEqual([]);
  });
});

describe('suggestions', () => {
  it('suggests box_number for the number layer and box_cabinet for the cabinet-name layer', () => {
    const view = secondaryView();
    expect(suggestMeaning(view, 'secondary', 'TXTNMPER', 'label').roles).toEqual(['box_number']);
    expect(suggestMeaning(view, 'secondary', 'TXTCAP', 'label').roles).toEqual(['box_cabinet']);
  });

  it('suggests ways from a route layer name only', () => {
    const view = secondaryView();
    expect(suggestMeaning(view, 'secondary', '1X12w Line', 'route').ways).toBe('12');
    expect(suggestMeaning(view, 'secondary', '1X12w Line', 'label').ways).toBe('');
  });

  it('fills only layers without roles and never replaces what was chosen', () => {
    const view = secondaryView();
    const state = initialFormState(view, null);
    const chosen = {
      ...state,
      meaning: { TXTNMPER: { roles: ['box_cable_type' as const], ways: '', aliases: {} } },
    };
    const next = withSuggestedMeaning(view, chosen, 'secondary');
    expect(next.meaning['TXTNMPER']?.roles).toEqual(['box_cable_type']);
    expect(next.meaning['TXTCAP']?.roles).toEqual(['box_cabinet']);
    expect(next.meaning['1X12w Line']).toEqual({ roles: [], ways: '12', aliases: {} });
  });
});

describe('ways', () => {
  it.each([
    ['12', 12],
    [' 1 ', 1],
    ['288', 288],
  ])('reads %j as %d', (text, ways) => expect(parseWays(text)).toBe(ways));

  it.each(['', '0', '289', '1.5', '-2', 'abc', '012'])('rejects %j', (text) =>
    expect(parseWays(text)).toBeNull(),
  );

  it('lists route layers with a typed but invalid ways (Save stays off)', () => {
    const view = secondaryView();
    const state = initialFormState(view, null);
    const bad = { ...state, meaning: { '1X12w Line': { roles: [], ways: '300', aliases: {} } } };
    expect(layersWithBadWays(view, bad)).toEqual(['1X12w Line']);
    expect(layersWithBadWays(view, state)).toEqual([]);
  });

  it('sends ways only with a route target and roles only where they fit', () => {
    expect(layerMeaningFields('route', { roles: [], ways: '12', aliases: {} })).toEqual({
      ways: 12,
    });
    expect(layerMeaningFields('label', { roles: [], ways: '12', aliases: {} })).toEqual({});
    expect(
      layerMeaningFields('cabinet', {
        roles: ['cabinet_info', 'box_number'],
        ways: '',
        aliases: {},
      }),
    ).toEqual({ textRoles: ['cabinet_info'] });
  });
});

describe('the form keeps roles and ways when it rebuilds the rules on save (ADR-041)', () => {
  const rules: CadMapping['rules'] = [
    { source: 'layer', layer: 'TXTNMPER', target: 'label', textRoles: ['box_number'] },
    { source: 'layer', layer: 'TXTCAP', target: 'label', textRoles: ['box_cabinet'] },
    { source: 'layer', layer: '1X12w Line', target: 'route', ways: 12 },
    {
      source: 'layer',
      layer: 'CABINA',
      target: 'cabinet',
      role: 'sub',
      textRoles: ['cabinet_info'],
    },
  ];

  it('loads the saved roles and ways into the form', () => {
    const state = initialFormState(secondaryView({ mapping: savedWith(rules) }), 'secondary');
    expect(state.meaning['TXTNMPER']).toEqual({ roles: ['box_number'], ways: '', aliases: {} });
    expect(state.meaning['1X12w Line']).toEqual({ roles: [], ways: '12', aliases: {} });
  });

  it('sends them back unchanged', () => {
    const view = secondaryView({ mapping: savedWith(rules) });
    const input = buildMappingInput(view, initialFormState(view, 'secondary'), 4);
    expect(input?.rules).toEqual(rules);
  });

  it('keeps them even when the file kind is not known yet', () => {
    const view = secondaryView({ mapping: savedWith(rules) });
    const input = buildMappingInput(view, initialFormState(view, null), 4);
    expect(input?.rules).toEqual(rules);
  });

  it('does not suggest into a saved mapping: a legacy mapping stays legacy until the PM asks', () => {
    const legacy = secondaryView({
      mapping: savedWith([
        { source: 'layer', layer: 'TXTNMPER', target: 'label' },
        { source: 'layer', layer: 'CABINA', target: 'cabinet', role: 'sub' },
      ]),
    });
    const input = buildMappingInput(legacy, initialFormState(legacy, 'secondary'), 4);
    expect(input).not.toBeNull();
    expect(input?.rules.some((rule) => rule.source === 'layer' && rule.textRoles)).toBe(false);
  });

  it('pre-suggests before the first save, and the suggestion is what gets sent', () => {
    const view = secondaryView();
    const first = initialFormState(view, 'secondary');
    const state = {
      ...first,
      attrs: { 'layer:CABINA': { kind: '', role: 'sub' as const, status: 'new' as const } },
    };
    const input = buildMappingInput(view, state, null);
    expect(input).not.toBeNull();
    expect(input?.rules).toContainEqual({
      source: 'layer',
      layer: 'TXTNMPER',
      target: 'label',
      textRoles: ['box_number'],
    });
    expect(input?.rules).toContainEqual({
      source: 'layer',
      layer: '1X12w Line',
      target: 'route',
      ways: 12,
    });
  });

  it('counts a change of roles or ways as an unsaved change', () => {
    const view = secondaryView({ mapping: savedWith(rules) });
    const state = initialFormState(view, 'secondary');
    const changed = {
      ...state,
      meaning: {
        ...state.meaning,
        TXTNMPER: { roles: ['box_number' as const, 'box_cabinet' as const], ways: '', aliases: {} },
      },
    };
    expect(formSignature(changed)).not.toBe(formSignature(state));
  });
});

describe('handhole type aliases (owner 2026-11-11)', () => {
  const hhText: MappingRule = {
    source: 'layer',
    layer: 'TXTNMPER',
    target: 'label',
    textRoles: ['handhole_type'],
  };
  const route: MappingRule = { source: 'layer', layer: '1X12w Line', target: 'route', ways: 12 };
  const cabinet: MappingRule = { source: 'layer', layer: 'CABINA', target: 'cabinet', role: 'sub' };
  const hhRules: MappingRule[] = [hhText, route, cabinet];
  const aliased = (handholeTypeAliases: Record<string, 'HH-I' | 'HH-II'>): MappingRule => ({
    source: 'layer',
    layer: 'TXTNMPER',
    target: 'label',
    textRoles: ['handhole_type'],
    handholeTypeAliases,
  });

  it('keeps the saved aliases through the form and back into the rules', () => {
    const withAliases: MappingRule[] = [aliased({ HH2: 'HH-II' }), route, cabinet];
    const view = secondaryView({ mapping: savedWith(withAliases) });
    const state = initialFormState(view, 'secondary');
    expect(state.meaning['TXTNMPER']?.aliases).toEqual({ HH2: 'HH-II' });
    const input = buildMappingInput(view, state, 3);
    expect(input?.rules).toContainEqual({
      source: 'layer',
      layer: 'TXTNMPER',
      target: 'label',
      textRoles: ['handhole_type'],
      handholeTypeAliases: { HH2: 'HH-II' },
    });
  });

  it('counts an alias change as unsaved and drops aliases when the role is unticked', () => {
    const withAliases = [aliased({ HH2: 'HH-II' })] as MappingRule[];
    const view = secondaryView({ mapping: savedWith(withAliases) });
    const state = initialFormState(view, 'secondary');
    const removed = {
      ...state,
      meaning: {
        ...state.meaning,
        TXTNMPER: { roles: ['handhole_type' as const], ways: '', aliases: {} },
      },
    };
    expect(formSignature(removed)).not.toBe(formSignature(state));
    expect(layerMeaningFields('label', { roles: [], ways: '', aliases: { HH2: 'HH-II' } })).toEqual(
      {},
    );
  });

  it('puts a confirmed type on the layer rule that reads handhole_type, version kept', () => {
    const view = secondaryView({ mapping: savedWith(hhRules) });
    const input = mappingWithAlias(view, 'TXTNMPER', ' hh2 ', 'HH-II');
    expect(input?.version).toBe(view.mapping?.version);
    expect(input?.rules[0]).toMatchObject({ handholeTypeAliases: { hh2: 'HH-II' } });
    expect(input?.rules[1]).toEqual(route);
    const again = mappingWithAlias(
      secondaryView({
        mapping: savedWith([aliased({ HH2: 'HH-I' }), route]),
      }),
      'TXTNMPER',
      'hh2',
      'HH-II',
    );
    expect(again?.rules[0]).toMatchObject({ handholeTypeAliases: { hh2: 'HH-II' } });
  });

  it('keeps the alias on the rule of the own text layer when two layers read handhole_type', () => {
    const other: MappingRule = {
      source: 'layer',
      layer: 'OTHERTXT',
      target: 'label',
      textRoles: ['handhole_type'],
    };
    const view = secondaryView({ mapping: savedWith([aliased({}), other, route]) });
    const onOther = mappingWithAlias(view, 'OTHERTXT', 'HH2', 'HH-II');
    expect(onOther?.rules[1]).toMatchObject({
      layer: 'OTHERTXT',
      handholeTypeAliases: { HH2: 'HH-II' },
    });
    expect(onOther?.rules[0]).not.toHaveProperty('handholeTypeAliases', { HH2: 'HH-II' });
    const first = mappingWithAlias(view, 'TXTNMPER', 'HH2', 'HH-I');
    expect(first?.rules[0]).toMatchObject({ handholeTypeAliases: { HH2: 'HH-I' } });
    expect(first?.rules[1]).toEqual(other);
    // A text on a layer with no such rule cannot be confirmed.
    expect(mappingWithAlias(view, 'TXT', 'HH2', 'HH-I')).toBeNull();
  });

  it('cannot keep an alias when no layer reads handhole_type', () => {
    expect(
      mappingWithAlias(secondaryView({ mapping: savedWith([route]) }), 'TXTNMPER', 'HH2', 'DH'),
    ).toBeNull();
    expect(mappingWithAlias(secondaryView({ mapping: null }), 'TXTNMPER', 'HH2', 'DH')).toBeNull();
  });
});
