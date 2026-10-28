import type { CadMapping } from '@ftth/shared';
import { describe, expect, it } from 'vitest';
import { initialEpsgText, parseEpsg } from './epsg';
import { mappingErrorKey, needsReload } from './mapping-errors';
import {
  buildMappingInput,
  formSignature,
  initialFormState,
  isSuggestedLayer,
  textRuleRows,
} from './mapping-form';
import { CAD_FILE_ID, detection, mappingView } from './mapping-fixtures';

function saved(overrides: Partial<CadMapping> = {}): CadMapping {
  return {
    cadFileId: CAD_FILE_ID,
    rules: [
      { source: 'layer', layer: 'N_DUC_CBL', target: 'route' },
      { source: 'layer', layer: 'BUILDINGS', target: 'ignore' },
      { source: 'block', block: 'HHI-BLOCK', target: 'joint' },
      { source: 'text', layer: 'RRR', text: 'note', target: 'mh' },
      { source: 'text', layer: 'OLD', text: 'GONE', target: 'box' },
    ],
    crsEpsg: 32636,
    drawingUnit: 'm',
    metresPerUnit: '1',
    version: 3,
    updatedById: null,
    updatedAt: '2026-10-28T10:00:00.000Z',
    ...overrides,
  };
}

describe('parseEpsg', () => {
  it('accepts WGS 84 / UTM codes of both hemispheres', () => {
    expect(parseEpsg(' 32636 ')).toEqual({ ok: true, value: 32636 });
    expect(parseEpsg('32736')).toEqual({ ok: true, value: 32736 });
  });

  it('rejects empty, non-numeric and unsupported codes', () => {
    expect(parseEpsg('')).toEqual({ ok: false, error: 'required' });
    expect(parseEpsg('4326')).toEqual({ ok: false, error: 'unsupported' });
    expect(parseEpsg('326.36')).toEqual({ ok: false, error: 'unsupported' });
    expect(parseEpsg('32661')).toEqual({ ok: false, error: 'unsupported' });
    expect(parseEpsg('abc')).toEqual({ ok: false, error: 'unsupported' });
  });
});

describe('initialEpsgText', () => {
  it('prefers the saved mapping, then the suggestion, then the project CRS', () => {
    expect(initialEpsgText(mappingView({ mapping: saved({ crsEpsg: 32635 }) }))).toBe('32635');
    expect(
      initialEpsgText(mappingView({ crsDetection: detection({ suggestedEpsg: 32637 }) })),
    ).toBe('32637');
    expect(initialEpsgText(mappingView({ crsDetection: detection({ suggestedEpsg: null }) }))).toBe(
      '32636',
    );
  });

  it('leaves the field empty when nothing supported is known', () => {
    const view = mappingView({
      projectEpsg: 4326,
      crsDetection: detection({ suggestedEpsg: null }),
    });
    expect(initialEpsgText(view)).toBe('');
  });
});

describe('initialFormState', () => {
  it('prefills suggestions on a first visit and never a drawing unit', () => {
    const state = initialFormState(mappingView());
    expect(state.unit).toBe('');
    expect(state.epsg).toBe('32636');
    expect(state.layers).toEqual({ N_DUC_CBL: 'route', BUILDINGS: 'background' });
    expect(state.blocks).toEqual({ 'HHI-BLOCK': 'hhi', TREE: 'follow' });
    expect(Object.values(state.texts).sort()).toEqual(['hhi', 'none']);
  });

  it('shows the saved rules; a block or text without a rule is "follow" / "no rule"', () => {
    const state = initialFormState(mappingView({ mapping: saved() }));
    expect(state.unit).toBe('m');
    expect(state.layers).toEqual({ N_DUC_CBL: 'route', BUILDINGS: 'ignore' });
    expect(state.blocks).toEqual({ 'HHI-BLOCK': 'joint', TREE: 'follow' });
    const rows = textRuleRows(mappingView({ mapping: saved() }));
    const byText = Object.fromEntries(rows.map((row) => [row.text, state.texts[row.key]]));
    // case-insensitive match of the saved "note" rule; NEW-HHI has no saved rule
    expect(byText).toEqual({ 'NEW-HHI': 'none', NOTE: 'mh', GONE: 'box' });
  });

  it('keeps a saved text rule that fell out of the limited text list', () => {
    const rows = textRuleRows(mappingView({ mapping: saved() }));
    expect(rows.find((row) => row.text === 'GONE')).toMatchObject({ layer: 'OLD', count: null });
  });

  it('falls back to the suggestion for a layer that has no saved rule', () => {
    const view = mappingView({
      mapping: saved({ rules: [{ source: 'layer', layer: 'BUILDINGS', target: 'ignore' }] }),
    });
    expect(initialFormState(view).layers['N_DUC_CBL']).toBe('route');
  });
});

describe('isSuggestedLayer', () => {
  it('marks a suggestion that was never saved, and only while it is unchanged', () => {
    const view = mappingView();
    expect(isSuggestedLayer(view, 'N_DUC_CBL', 'route')).toBe(true);
    expect(isSuggestedLayer(view, 'N_DUC_CBL', 'box')).toBe(false);
    expect(isSuggestedLayer(mappingView({ mapping: saved() }), 'N_DUC_CBL', 'route')).toBe(false);
  });
});

describe('buildMappingInput', () => {
  it('sends every layer rule plus block and text rules, with the chosen unit', () => {
    const view = mappingView();
    const state = { ...initialFormState(view), unit: 'm' as const };
    const input = buildMappingInput(view, state, null);
    expect(input).toEqual({
      rules: [
        { source: 'layer', layer: 'N_DUC_CBL', target: 'route' },
        { source: 'layer', layer: 'BUILDINGS', target: 'background' },
        { source: 'block', block: 'HHI-BLOCK', target: 'hhi' },
        { source: 'text', layer: 'RRR', text: 'NEW-HHI', target: 'hhi' },
      ],
      crsEpsg: 32636,
      drawingUnit: 'm',
      version: null,
    });
  });

  it('carries the saved version for an update', () => {
    const view = mappingView({ mapping: saved() });
    const input = buildMappingInput(view, initialFormState(view), 3);
    expect(input?.version).toBe(3);
  });

  it('omits blocks that follow their layer and texts without a rule', () => {
    const view = mappingView();
    const state = initialFormState(view);
    const input = buildMappingInput(
      view,
      {
        ...state,
        unit: 'in',
        blocks: { 'HHI-BLOCK': 'follow', TREE: 'follow' },
        texts: Object.fromEntries(Object.keys(state.texts).map((key) => [key, 'none' as const])),
      },
      null,
    );
    expect(input?.rules.map((rule) => rule.source)).toEqual(['layer', 'layer']);
  });

  it('refuses to build a payload without a chosen unit or with a bad EPSG', () => {
    const view = mappingView();
    const state = initialFormState(view);
    expect(buildMappingInput(view, state, null)).toBeNull();
    expect(buildMappingInput(view, { ...state, unit: 'm', epsg: '4326' }, null)).toBeNull();
  });

  it('keeps the first of two texts that differ only by case (they would be duplicates)', () => {
    const view = mappingView({
      texts: [
        { layer: 'RRR', text: 'NEW-HHI', count: 4, suggestedTarget: 'hhi' },
        { layer: 'RRR', text: 'new-hhi', count: 1, suggestedTarget: 'hhi' },
      ],
    });
    const input = buildMappingInput(view, { ...initialFormState(view), unit: 'm' }, null);
    expect(input?.rules.filter((rule) => rule.source === 'text')).toHaveLength(1);
  });
});

describe('formSignature', () => {
  it('changes with any edit and not with key order', () => {
    const state = initialFormState(mappingView());
    expect(formSignature({ ...state, unit: 'm' })).not.toBe(formSignature(state));
    const reordered = {
      ...state,
      layers: { BUILDINGS: 'background', N_DUC_CBL: 'route' },
    } as const;
    expect(formSignature(reordered)).toBe(formSignature(state));
  });
});

describe('mapping errors', () => {
  it('maps known 409 reasons and offers a reload for version conflicts', () => {
    expect(mappingErrorKey('CONFLICT', 'VERSION_MISMATCH')).toBe('mapping.error.VERSION_MISMATCH');
    expect(mappingErrorKey('CONFLICT', 'REVISION_IN_PROGRESS')).toBe(
      'mapping.error.REVISION_IN_PROGRESS',
    );
    expect(mappingErrorKey('CONFLICT', 'SOMETHING')).toBe('errors.CONFLICT');
    expect(mappingErrorKey('NETWORK', null)).toBe('errors.NETWORK');
    expect(needsReload('CONFLICT', 'VERSION_MISMATCH')).toBe(true);
    expect(needsReload('CONFLICT', 'MAPPING_VERSION_MISMATCH')).toBe(true);
    expect(needsReload('CONFLICT', 'NO_MAPPING')).toBe(false);
  });
});
