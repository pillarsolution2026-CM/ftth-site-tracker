import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/test-utils/render';
import { fittingTools, Panel, panelShare, PANEL_ORDER, RibbonFit } from './cad-ribbon';

/**
 * Items 31 + 31b (owner 2026-11-26): the ribbon's width is divided EQUALLY between all panels;
 * each panel shows the tools that fit and the rest go under the ▾ next to its title; no panel
 * collapses to a bare title; it is recomputed when the ribbon is resized.
 */

describe('equal ribbon panels (items 31 + 31b)', () => {
  it('divides the ribbon equally between all nine panels', () => {
    expect(PANEL_ORDER).toHaveLength(9);
    expect(panelShare(1800, PANEL_ORDER.length)).toBe(200);
    expect(panelShare(1000, PANEL_ORDER.length)).toBe(111);
    expect(panelShare(0, PANEL_ORDER.length)).toBe(0);
  });

  it('keeps the tools that fit, at least one, and all while not laid out', () => {
    // 17 px padding, 2 px between tools.
    expect(fittingTools([60, 60, 60], 201)).toBe(3);
    expect(fittingTools([60, 60, 60], 200)).toBe(2);
    expect(fittingTools([60, 60, 60], 150)).toBe(2);
    expect(fittingTools([60, 60, 60], 80)).toBe(1);
    expect(fittingTools([300, 60], 100)).toBe(1);
    expect(fittingTools([60, 60], 0)).toBe(2);
    expect(fittingTools([], 100)).toBe(0);
  });

  describe('a panel at its share', () => {
    beforeEach(() => {
      vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (
        this: HTMLElement,
      ) {
        // A tool's wrapper measures its own tool (data-w on the button).
        const tool = this.querySelector<HTMLElement>('[data-w]');
        return Number(tool?.dataset.w ?? 0);
      });
    });
    afterEach(() => vi.restoreAllMocks());

    let setShare: (share: number) => void = () => undefined;
    function Harness({ first }: { first: number }) {
      const [share, set] = useState(first);
      setShare = set;
      return (
        <RibbonFit.Provider value={{ share }}>
          <Panel id="draw" title="Draw" more={<button type="button">Spline</button>}>
            <button type="button" data-w="60">
              Line
            </button>
            <button type="button" data-w="60">
              Polyline
            </button>
            <button type="button" data-w="60">
              Circle
            </button>
          </Panel>
        </RibbonFit.Provider>
      );
    }

    it('shows what fits, the rest under ▾ with the slide-out; recomputed when resized', async () => {
      const user = userEvent.setup();
      renderScreen(<Harness first={150} />);
      const panel = screen.getByRole('group', { name: 'Draw' });
      expect(panel).toHaveStyle({ width: '150px' });
      expect(within(panel).getByRole('button', { name: 'Line' })).toBeInTheDocument();
      expect(within(panel).getByRole('button', { name: 'Polyline' })).toBeInTheDocument();
      expect(within(panel).queryByRole('button', { name: 'Circle' })).not.toBeInTheDocument();
      await user.click(within(panel).getByRole('button', { name: /Draw/ }));
      const flyout = within(panel).getByRole('group', { name: /Draw/ });
      expect(within(flyout).getByRole('button', { name: 'Circle' })).toBeInTheDocument();
      expect(within(flyout).getByRole('button', { name: 'Spline' })).toBeInTheDocument();
      // Narrower: one tool stays (never a bare title).
      act(() => setShare(60));
      expect(within(panel).getByRole('button', { name: 'Line' })).toBeInTheDocument();
      expect(within(flyout).getByRole('button', { name: 'Polyline' })).toBeInTheDocument();
      // Wider again: everything is back on the panel.
      act(() => setShare(400));
      expect(within(panel).getAllByRole('button', { name: 'Circle' })).toHaveLength(1);
      expect(within(flyout).queryByRole('button', { name: 'Circle' })).not.toBeInTheDocument();
    });
  });
});
