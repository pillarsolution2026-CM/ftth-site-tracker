import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderScreen } from '@/test-utils/render';
import { Grid } from './drafting-overlay';

/** Round 2, items 26 / 30: the grid is thinned as AutoCAD's, and hidden when it would be a smear. */
const view = { cx: 0, cy: 0, width: 800, height: 600, gridX: 10, gridY: 10 };

describe('the grid (F7)', () => {
  it('is drawn when its lines are apart enough', () => {
    renderScreen(<Grid {...view} scale={2} />);
    expect(screen.getByTestId('drafting-grid')).toBeInTheDocument();
    expect(screen.queryByTestId('grid-too-dense')).toBeNull();
  });

  it('is thinned when zoomed out, still drawn', () => {
    renderScreen(<Grid {...view} scale={0.05} />);
    expect(screen.getByTestId('drafting-grid')).toBeInTheDocument();
  });

  it('says «Grid too dense to display» and draws nothing when zoomed far out', () => {
    renderScreen(<Grid {...view} scale={0.0001} />);
    expect(screen.queryByTestId('drafting-grid')).toBeNull();
    expect(screen.getByTestId('grid-too-dense')).toHaveTextContent('Grid too dense to display');
  });
});
