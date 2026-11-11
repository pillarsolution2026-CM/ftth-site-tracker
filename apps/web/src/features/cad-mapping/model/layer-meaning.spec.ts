import type { CadMapping, CadMappingView } from '@ftth/shared';
import { describe, expect, it } from 'vitest';
import {
  layerMeaningFields,
  layerTargetsFor,
  layersWithBadWays,
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
      meaning: { TXTNMPER: { roles: ['box_cable_type' as const], ways: '' } },
    };
    const next = withSuggestedMeaning(view, chosen, 'secondary');
    expect(next.meaning['TXTNMPER']?.roles).toEqual(['box_cable_type']);
    expect(next.meaning['TXTCAP']?.roles).toEqual(['box_cabinet']);
    expect(next.meaning['1X12w Line']).toEqual({ roles: [], ways: '12' });
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
    const bad = { ...state, meaning: { '1X12w Line': { roles: [], ways: '300' } } };
    expect(layersWithBadWays(view, bad)).toEqual(['1X12w Line']);
    expect(layersWithBadWays(view, state)).toEqual([]);
  });

  it('sends ways only with a route target and roles only where they fit', () => {
    expect(layerMeaningFields('route', { roles: [], ways: '12' })).toEqual({ ways: 12 });
    expect(layerMeaningFields('label', { roles: [], ways: '12' })).toEqual({});
    expect(
      layerMeaningFields('cabinet', { roles: ['cabinet_info', 'box_number'], ways: '' }),
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
    expect(state.meaning['TXTNMPER']).toEqual({ roles: ['box_number'], ways: '' });
    expect(state.meaning['1X12w Line']).toEqual({ roles: [], ways: '12' });
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
        TXTNMPER: { roles: ['box_number' as const, 'box_cabinet' as const], ways: '' },
      },
    };
    expect(formSignature(changed)).not.toBe(formSignature(state));
  });
});
