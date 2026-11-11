import { screen, within } from '@testing-library/react';
import type { ReadingTotals } from '@ftth/shared';
import { describe, expect, it } from 'vitest';
import { renderScreen } from '@/test-utils/render';
import { ReadingSummary } from './reading-summary';

const secondary: ReadingTotals = {
  drawingKind: 'secondary',
  bundles: [
    { ways: 1, ductSize: '7/3.5', count: 187, writtenLengthM: '1870.500', withoutLength: 2 },
    { ways: 12, ductSize: null, count: 3, writtenLengthM: '650.000', withoutLength: 0 },
  ],
  connectors: [{ ductSize: '7/3.5', count: 187 }],
  spares: [{ ductSize: '7/3.5', singles: 187, endCaps: 374 }],
  cables: [],
  handholes: [],
};

const general: ReadingTotals = {
  drawingKind: 'general',
  bundles: [{ ways: 4, ductSize: '16/12', count: 5, writtenLengthM: '2500.000', withoutLength: 0 }],
  connectors: [],
  spares: [],
  cables: [{ cores: 144, count: 2, writtenLengthM: '1040.000' }],
  handholes: [
    { type: 'HH-I', count: 3 },
    { type: 'DH', count: 4 },
    { type: null, count: 1 },
  ],
};

describe('ReadingSummary (ADR-041)', () => {
  it('shows bundles with their written length and the Secondary connectors, spares and end caps', () => {
    renderScreen(<ReadingSummary reading={secondary} />);
    const bundles = screen.getByRole('table', { name: 'Bundles by type' });
    expect(within(bundles).getByText('1 way')).toBeInTheDocument();
    expect(within(bundles).getByText('1,870.500')).toBeInTheDocument();
    // A bundle type with no duct size shows a dash, not a made-up value.
    expect(within(bundles).getAllByText('—').length).toBeGreaterThan(0);
    const fittings = screen.getByRole('table', { name: 'Connectors and spares' });
    expect(within(fittings).getByText('Connectors')).toBeInTheDocument();
    expect(within(fittings).getByText('374')).toBeInTheDocument();
    expect(screen.queryByRole('table', { name: 'Handholes by type' })).not.toBeInTheDocument();
  });

  it('shows the General cables by cores and handholes by type, untyped ones apart', () => {
    renderScreen(<ReadingSummary reading={general} />);
    expect(
      within(screen.getByRole('table', { name: 'Cables by cores' })).getByText('144'),
    ).toBeInTheDocument();
    const handholes = screen.getByRole('table', { name: 'Handholes by type' });
    expect(within(handholes).getByText('HH-I')).toBeInTheDocument();
    expect(within(handholes).getByText('DH')).toBeInTheDocument();
    expect(within(handholes).getByText('No type')).toBeInTheDocument();
    expect(screen.queryByRole('table', { name: 'Connectors and spares' })).not.toBeInTheDocument();
  });

  it('says the lengths are the written ones', () => {
    renderScreen(<ReadingSummary reading={general} />);
    expect(screen.getByText(/WRITTEN ones, not measured/)).toBeInTheDocument();
  });
});
