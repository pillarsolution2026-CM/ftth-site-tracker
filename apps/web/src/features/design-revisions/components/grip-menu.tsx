'use client';

import type { MessageKey } from '@ftth/i18n';
import { useI18n } from '@/shared/i18n/locale-provider';
import type { DrawingViewer } from '../hooks/use-drawing-viewer';
import type { GripMenuItem } from '../model/grips';
import { toScreen } from '../model/view-transform';

const LABELS: Record<GripMenuItem, string> = {
  stretch: 'gripMenuStretch',
  addVertex: 'gripMenuAddVertex',
  removeVertex: 'gripMenuRemoveVertex',
  toArc: 'gripMenuToArc',
  toLine: 'gripMenuToLine',
};

/**
 * AutoCAD's multifunctional grip menu (audit 3, phase 2B): hovering a polyline's vertex grip shows
 * Stretch Vertex / Add Vertex / Remove Vertex, a segment's middle grip Stretch / Add Vertex /
 * Convert to Arc (or Convert to Line), next to the grip.
 */
export function GripMenu({ viewer }: { viewer: DrawingViewer }) {
  const { t } = useI18n();
  const { hoverGrip: grip, edit, size, transform } = viewer;
  if (!grip || !edit.editing || edit.command !== null || edit.hotGrip !== null) return null;
  const items = edit.gripMenuOf(grip);
  if (items.length === 0) return null;
  const at = toScreen(transform, size, grip.x, grip.y);
  const label = (item: GripMenuItem) =>
    t(
      `design.cad.cmd.${item === 'stretch' && grip.kind === 'vertex' ? 'gripMenuStretchVertex' : LABELS[item]}` as MessageKey,
    );
  return (
    <div
      role="menu"
      aria-label={t('design.cad.cmd.gripMenuLabel')}
      dir="ltr"
      style={{
        left: Math.max(4, Math.min(at.x + 10, size.width - 150)),
        top: Math.max(4, Math.min(at.y + 10, size.height - 90)),
      }}
      onMouseEnter={() => viewer.holdGripMenu(true)}
      onMouseLeave={() => viewer.holdGripMenu(false)}
      className="absolute z-10 flex w-36 flex-col rounded-sm border border-neutral-500 bg-neutral-800 py-1 text-xs text-white shadow-lg"
    >
      {items.map((item) => (
        <button
          key={item}
          type="button"
          role="menuitem"
          className="px-3 py-1 text-start hover:bg-sky-700 focus:bg-sky-700 focus:outline-none"
          onClick={() => {
            edit.chooseGripMenu(grip, item);
            // The grip may be gone (Remove Vertex): the menu closes until the next hover.
            viewer.closeGripMenu();
          }}
        >
          {label(item)}
        </button>
      ))}
    </div>
  );
}
