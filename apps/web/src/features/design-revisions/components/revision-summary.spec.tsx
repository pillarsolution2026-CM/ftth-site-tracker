import { screen } from '@testing-library/react';
import type { DesignRevisionDetail } from '@ftth/shared';
import { describe, expect, it } from 'vitest';
import { renderScreen } from '@/test-utils/render';
import { RevisionSummary } from './revision-summary';

function revision(counts: unknown): DesignRevisionDetail {
  return {
    drawingKind: 'secondary',
    crsEpsg: 32636,
    drawingUnit: 'm',
    metresPerUnit: '1',
    insUnits: null,
    cadFileName: 'a.dxf',
    baseRevisionId: null,
    createdAt: '2026-11-16T10:00:00.000Z',
    builtAt: null,
    publishedAt: null,
    unitsConflict: false,
    status: 'draft',
    errorCode: null,
    counts,
    textLinkCounts: null,
  } as unknown as DesignRevisionDetail;
}

describe('RevisionSummary totals (ADR-045)', () => {
  it('shows no drawing totals when counts.reading is absent', () => {
    renderScreen(
      <RevisionSummary revision={revision({ features: {}, routeLengthM: '0', groups: [] })} />,
    );
    expect(
      screen.queryByRole('region', { name: 'What the drawing reads' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('table', { name: 'Bundles by type' })).not.toBeInTheDocument();
  });

  it('shows the totals when counts.reading is present', () => {
    renderScreen(
      <RevisionSummary
        revision={revision({
          features: {},
          routeLengthM: '0',
          reading: {
            drawingKind: 'secondary',
            bundles: [
              { ways: 1, ductSize: null, count: 1, writtenLengthM: '1.000', withoutLength: 0 },
            ],
            connectors: [],
            spares: [],
            cables: [],
            handholes: [],
          },
        })}
      />,
    );
    expect(screen.getByRole('table', { name: 'Bundles by type' })).toBeInTheDocument();
  });
});
