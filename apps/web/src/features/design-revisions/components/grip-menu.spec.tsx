import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/test-utils/render';
import type { DrawingViewer } from '../hooks/use-drawing-viewer';
import type { Grip, GripMenuItem } from '../model/grips';
import { GripMenu } from './grip-menu';

/** Audit 3 (phase 2B): AutoCAD's multifunctional grip menu on a hovered polyline grip. */

const grip = (kind: Grip['kind']): Grip => ({
  x: 10,
  y: 10,
  kind,
  index: 0,
  vertex: 0,
  handles: ['A'],
  editable: true,
});

function viewerWith(hover: Grip, items: GripMenuItem[], hot: Grip | null = null) {
  const chooseGripMenu = vi.fn();
  const hoverAt = vi.fn();
  const viewer = {
    hoverGrip: hover,
    hoverAt,
    size: { width: 400, height: 300 },
    transform: { scale: 1, cx: 0, cy: 0 },
    edit: {
      editing: true,
      command: null,
      hotGrip: hot,
      gripMenuOf: () => items,
      chooseGripMenu,
    },
  } as unknown as DrawingViewer;
  return { viewer, chooseGripMenu, hoverAt };
}

describe('GripMenu', () => {
  it('a vertex grip offers Stretch Vertex / Add Vertex / Remove Vertex; a click chooses', async () => {
    const vertex = grip('vertex');
    const { viewer, chooseGripMenu, hoverAt } = viewerWith(vertex, [
      'stretch',
      'addVertex',
      'removeVertex',
    ]);
    renderScreen(<GripMenu viewer={viewer} />);
    const items = screen.getAllByRole('menuitem').map((b) => b.textContent);
    expect(items).toEqual(['Stretch Vertex', 'Add Vertex', 'Remove Vertex']);
    await userEvent.click(screen.getByRole('menuitem', { name: 'Remove Vertex' }));
    expect(chooseGripMenu).toHaveBeenCalledWith(vertex, 'removeVertex');
    expect(hoverAt).toHaveBeenCalled();
  });

  it('a segment grip offers Stretch / Add Vertex / Convert to Arc', () => {
    const { viewer } = viewerWith(grip('segment'), ['stretch', 'addVertex', 'toArc']);
    renderScreen(<GripMenu viewer={viewer} />);
    expect(screen.getAllByRole('menuitem').map((b) => b.textContent)).toEqual([
      'Stretch',
      'Add Vertex',
      'Convert to Arc',
    ]);
  });

  it('shows nothing while a grip is hot or for grips without a menu', () => {
    const g = grip('vertex');
    const { viewer } = viewerWith(g, ['stretch'], g);
    const { container } = renderScreen(<GripMenu viewer={viewer} />);
    expect(container.querySelector('[role="menu"]')).toBeNull();
    const other = viewerWith(grip('center'), []);
    renderScreen(<GripMenu viewer={other.viewer} />);
    expect(screen.queryByRole('menu')).toBeNull();
  });
});
