import { describe, expect, it } from 'vitest';
import {
  CadMappingInputSchema,
  suggestBlockTarget,
  suggestLayerTarget,
  suggestTextTarget,
} from '../cad/cad-mapping.schemas.js';
import { CadJobSchema } from '../cad/cad-job.schemas.js';
import { isSupportedProjectEpsg } from '../cad/crs-detection.schemas.js';
import { drawingUnitFromInsUnits, METRES_PER_UNIT } from '../cad/drawing-units.js';
import { hasPermission } from '../auth/permissions.js';
import {
  PublishDesignRevisionRequestSchema,
  ReviewTextLinkRequestSchema,
  tileSignaturePayload,
} from './design-revision.schemas.js';
import { classifyLinkText, TEXT_LINK_TARGETS } from './text-link.js';

const baseMapping = { crsEpsg: 32636, drawingUnit: 'm', version: null } as const;

describe('CadMappingInputSchema', () => {
  it('accepts layer, block and text rules', () => {
    const parsed = CadMappingInputSchema.parse({
      ...baseMapping,
      rules: [
        { source: 'layer', layer: 'N_DUC_CBL', target: 'route' },
        { source: 'block', block: 'sub', target: 'box' },
        { source: 'text', layer: 'RRR', text: ' NEW-HHI ', target: 'hhi' },
      ],
    });
    expect(parsed.rules[2]).toMatchObject({ text: 'NEW-HHI' });
  });

  it('requires a drawing unit (no default, ADR-018)', () => {
    const input = { crsEpsg: 32636, version: null, rules: [] };
    expect(CadMappingInputSchema.safeParse(input).success).toBe(false);
  });

  it('rejects a route target on a block or text rule', () => {
    for (const rule of [
      { source: 'block', block: 'sub', target: 'route' },
      { source: 'text', layer: 'RRR', text: 'x', target: 'route' },
    ]) {
      expect(CadMappingInputSchema.safeParse({ ...baseMapping, rules: [rule] }).success).toBe(
        false,
      );
    }
  });

  it('rejects duplicate rules (text compared case-insensitively)', () => {
    const result = CadMappingInputSchema.safeParse({
      ...baseMapping,
      rules: [
        { source: 'text', layer: 'RRR', text: 'NEW-HHI', target: 'hhi' },
        { source: 'text', layer: 'RRR', text: 'new-hhi', target: 'box' },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('accepts only WGS 84 / UTM EPSG codes', () => {
    expect(isSupportedProjectEpsg(32636)).toBe(true);
    expect(isSupportedProjectEpsg(32738)).toBe(true);
    expect(isSupportedProjectEpsg(4326)).toBe(false);
    expect(isSupportedProjectEpsg(3857)).toBe(false);
    expect(
      CadMappingInputSchema.safeParse({ ...baseMapping, crsEpsg: 4326, rules: [] }).success,
    ).toBe(false);
  });
});

describe('suggestions (plan examples)', () => {
  it.each([
    ['N_DUC_CBL', 'route'],
    ['sub', 'box'],
    ['jont 144', 'joint'],
    ['CAP F36', 'label'],
    ['N-CABLE-TXT', 'label'],
    ['building', 'background'],
    ['tx', 'background'],
  ])('layer %s → %s', (name, target) => {
    expect(suggestLayerTarget(name).target).toBe(target);
  });

  it('suggests blocks and texts', () => {
    expect(suggestBlockTarget('sub')).toBe('box');
    expect(suggestBlockTarget('JONT 144')).toBe('joint');
    expect(suggestBlockTarget('144')).toBeNull();
    expect(suggestTextTarget('NEW-HHI')).toBe('hhi');
    expect(suggestTextTarget('HHI 5')).toBeNull();
  });
});

describe('text link patterns', () => {
  it.each([
    ['F 36 C', 'cable'],
    ['F144C', 'cable'],
    ['1X2Way16/12', 'duct'],
    ['150.0M', 'length'],
    ['85 m', 'length'],
    ['1-1', 'box_id'],
    ['3 - 3', 'box_id'],
    ['12B', 'box_bpu'],
    ['4 U', 'box_bpu'],
    ['NEW-HHI', 'other'],
    ['F 36 C extra', 'other'],
  ])('%s → %s', (text, kind) => {
    expect(classifyLinkText(text)).toBe(kind);
  });

  it('links cable/duct/length to routes and box ids to boxes', () => {
    expect(TEXT_LINK_TARGETS.length).toEqual(['route']);
    expect(TEXT_LINK_TARGETS.box_id).toEqual(['box']);
  });
});

describe('drawing units', () => {
  it('maps $INSUNITS codes without guessing', () => {
    expect(drawingUnitFromInsUnits(1)).toBe('in');
    expect(drawingUnitFromInsUnits(6)).toBe('m');
    expect(drawingUnitFromInsUnits(0)).toBeNull();
    expect(drawingUnitFromInsUnits(3)).toBeNull();
    expect(drawingUnitFromInsUnits(null)).toBeNull();
    expect(METRES_PER_UNIT.in).toBe('0.0254');
  });
});

describe('revision requests', () => {
  it('publish acknowledgement defaults to false', () => {
    expect(PublishDesignRevisionRequestSchema.parse({})).toEqual({ acknowledgeOpenItems: false });
  });

  it('review actions', () => {
    expect(ReviewTextLinkRequestSchema.safeParse({ action: 'reject' }).success).toBe(true);
    expect(ReviewTextLinkRequestSchema.safeParse({ action: 'guess' }).success).toBe(false);
  });

  it('build-revision job is part of the job union', () => {
    const job = CadJobSchema.parse({
      id: '00000000-0000-4000-8000-000000000001',
      type: 'cad.build_revision',
      revisionId: '00000000-0000-4000-8000-000000000002',
      projectId: '00000000-0000-4000-8000-000000000003',
      cadFileId: '00000000-0000-4000-8000-000000000004',
      attempt: 1,
      enqueuedAt: '2026-10-28T10:00:00.000Z',
    });
    expect(job.type).toBe('cad.build_revision');
  });

  it('tile signature payload is stable', () => {
    expect(tileSignaturePayload('design_features', 'p', 'r', 10)).toBe('design_features|p|r|10');
  });

  it('design permissions: pm writes, supervisor reads, contractor nothing', () => {
    expect(hasPermission(['pm'], 'design:write')).toBe(true);
    expect(hasPermission(['supervisor'], 'design:read')).toBe(true);
    expect(hasPermission(['supervisor'], 'design:write')).toBe(false);
    expect(hasPermission(['contractor'], 'design:read')).toBe(false);
  });
});
