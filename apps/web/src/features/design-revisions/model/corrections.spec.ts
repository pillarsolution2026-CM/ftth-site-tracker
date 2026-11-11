import type { DrawingCorrection } from '@ftth/shared';
import { describe, expect, it } from 'vitest';
import {
  changesSinceBuild,
  correctionErrorKey,
  labelOffset,
  pendingPlaces,
  placeKey,
  problemHandle,
  routePieces,
  toolOf,
} from './corrections';

const base: DrawingCorrection = {
  id: '55555555-5555-4555-8555-555555555555',
  cadFileId: '33333333-3333-4333-8333-333333333333',
  correction: { kind: 'move_layer', handle: 'A1', toLayer: 'X' },
  problem: { code: 'WRONG_LAYER', handle: 'A1' },
  createdBy: null,
  createdAt: '2026-11-09T10:00:00.000Z',
  withdrawnBy: null,
  withdrawnAt: null,
};

describe('corrections model', () => {
  it('maps each problem code to one tool; the ring check has none', () => {
    expect(toolOf('WRONG_LAYER')).toBe('move_layer');
    expect(toolOf('LABEL_MISSING')).toBe('add_text');
    expect(toolOf('LABEL_TYPE_MISMATCH')).toBe('label_type_mismatch');
    expect(toolOf('LABEL_LENGTH_MISSING')).toBe('set_text');
    expect(toolOf('ROUTE_SPLIT')).toBe('merge_routes');
    expect(toolOf('RING_LABEL_MISMATCH')).toBe('none');
  });

  it.each([
    ['HANDHOLE_TYPE_MISSING', 'add_text'],
    ['HANDHOLE_TYPE_UNKNOWN', 'set_text'],
    ['HANDHOLE_NOT_DRAWN', 'add_item'],
    ['BOX_NUMBER_DUPLICATE', 'set_text'],
    ['BOX_NOT_REACHED', 'none'],
    ['CABINET_BOX_COUNT_MISMATCH', 'set_text'],
    ['CABINET_ZONE_MISSING', 'none'],
    ['SPARE_CORES_MISMATCH', 'set_text'],
    ['CABLE_SLACK_TOO_SHORT', 'set_text'],
    ['CABLE_SLACK_TOO_LONG', 'set_text'],
  ] as const)('ADR-041: %s uses the %s tool', (code, tool) => {
    expect(toolOf(code)).toBe(tool);
  });

  it('a route LABEL_TYPE_MISMATCH (its place carries a role) edits the text, a point keeps the old tool', () => {
    expect(toolOf('LABEL_TYPE_MISMATCH', { params: { role: 'bundle_label' } })).toBe('set_text');
    expect(toolOf('LABEL_TYPE_MISMATCH', { params: undefined })).toBe('label_type_mismatch');
    expect(toolOf('LABEL_TYPE_MISMATCH', {})).toBe('label_type_mismatch');
  });

  it('splits a ROUTE_SPLIT handle into its pieces', () => {
    expect(routePieces('A/B')).toEqual(['A', 'B']);
    expect(routePieces('1F/2A/3C')).toEqual(['1F', '2A', '3C']);
  });

  it('cuts a very long problem handle to the contract limit', () => {
    expect(problemHandle('x'.repeat(100))).toHaveLength(64);
    expect(placeKey('ROUTE_SPLIT', 'x'.repeat(100))).toBe(`ROUTE_SPLIT:${'x'.repeat(64)}`);
  });

  it('pending places are those with an active correction, matched by code and handle', () => {
    const pending = pendingPlaces([
      base,
      { ...base, problem: { code: 'ROUTE_SPLIT', handle: 'B1/B2' } },
      { ...base, problem: { code: 'LABEL_MISSING', handle: 'C' }, withdrawnAt: base.createdAt },
      { ...base, problem: null },
    ]);
    expect(pending.has(placeKey('WRONG_LAYER', 'A1'))).toBe(true);
    expect(pending.has(placeKey('ROUTE_SPLIT', 'B1/B2'))).toBe(true);
    expect(pending.has(placeKey('LABEL_MISSING', 'C'))).toBe(false);
    expect(pending.has(placeKey('WRONG_LAYER', 'ZZ'))).toBe(false);
  });

  it('label offset is half a metre in drawing units', () => {
    expect(labelOffset(1)).toBe(0.5);
    expect(labelOffset(0.001)).toBe(500);
    expect(labelOffset(0.0254)).toBe(19.685);
    expect(labelOffset(null)).toBe(1);
  });

  it('counts corrections made or withdrawn after the build', () => {
    const built = '2026-11-09T09:00:00.000Z';
    expect(changesSinceBuild([], built)).toBe(0);
    expect(changesSinceBuild([base], null)).toBe(0);
    expect(changesSinceBuild([base], built)).toBe(1);
    expect(
      changesSinceBuild(
        [
          {
            ...base,
            createdAt: '2026-11-08T00:00:00.000Z',
            withdrawnAt: '2026-11-09T10:00:00.000Z',
          },
        ],
        built,
      ),
    ).toBe(1);
    expect(changesSinceBuild([{ ...base, createdAt: '2026-11-08T00:00:00.000Z' }], built)).toBe(0);
  });

  it('known reasons get their own message, anything else the generic one', () => {
    expect(correctionErrorKey('VALIDATION_FAILED', 'HANDLE_NOT_FOUND')).toBe(
      'design.corrections.error.HANDLE_NOT_FOUND',
    );
    expect(correctionErrorKey('CONFLICT', 'ALREADY_WITHDRAWN')).toBe(
      'design.corrections.error.ALREADY_WITHDRAWN',
    );
    expect(correctionErrorKey('CONFLICT', 'SOMETHING')).toBe('errors.CONFLICT');
    expect(correctionErrorKey('NETWORK', null)).toBe('errors.NETWORK');
  });
});
