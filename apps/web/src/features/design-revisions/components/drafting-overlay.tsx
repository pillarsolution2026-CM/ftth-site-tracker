'use client';

import { memo } from 'react';
import type { MessageKey } from '@ftth/i18n';
import { useI18n } from '@/shared/i18n/locale-provider';
import { COMMANDS } from '../model/cad-commands';
import { formatCoordinates, formatLength, formatPolar } from '../model/drafting';
import { effectiveLayer } from '../model/drawing-preview';
import { toScreen } from '../model/view-transform';
import type { DrawingViewer } from '../hooks/use-drawing-viewer';
import { usePointer } from '../hooks/use-drafting';
import { formatPrompt } from '../hooks/use-canvas-edit';
import { markerShape } from './status-bar';

/**
 * What the status bar's aids draw over the canvas (owner 2026-11-26, item 14): AutoSnap markers
 * and their tooltip, the acquired points and dotted tracking paths, the grid (F7), the Dynamic
 * Input tooltip at the pointer (F12), Selection Cycling's list and the Quick Properties palette.
 * Pointer events pass through to the canvas, except on the two lists.
 */

/** AutoCAD's 2D AutoSnap marker colour on a dark model space. */
const MARKER = '#5ef05e';
const TRACK = '#5ef05e';
const MARKER_PX = 6;
/** Grid lines closer than this on screen are thinned five times (AutoCAD's adaptive grid). */
const MIN_GRID_PX = 8;

/** AutoCAD's names of the object types (the Quick Properties / Selection list titles). */
const TYPE_NAME: Readonly<Record<string, string>> = {
  LINE: 'Line',
  LWPOLYLINE: 'Polyline',
  POLYLINE: 'Polyline',
  CIRCLE: 'Circle',
  ARC: 'Arc',
  ELLIPSE: 'Ellipse',
  SPLINE: 'Spline',
  POINT: 'Point',
  TEXT: 'Text',
  MTEXT: 'MText',
  INSERT: 'Block Reference',
  HATCH: 'Hatch',
  DIMENSION: 'Dimension',
  LEADER: 'Leader',
  SOLID: '2D Solid',
};
export const typeName = (kind: string) => TYPE_NAME[kind] ?? kind;

/** The grid is thinned (×5) at most this many times; denser than that it is not drawn. */
const MAX_GRID_THIN = 25;

/** The grid, only redrawn when the view or its spacing changes (never on a pointer move). */
export const Grid = memo(function Grid({
  cx,
  cy,
  scale,
  width,
  height,
  gridX,
  gridY,
}: {
  cx: number;
  cy: number;
  scale: number;
  width: number;
  height: number;
  gridX: number;
  gridY: number;
}) {
  const { t } = useI18n();
  let sx = gridX * scale;
  let sy = gridY * scale;
  let k = 1;
  while (Math.min(sx, sy) < MIN_GRID_PX && k <= MAX_GRID_THIN) {
    sx *= 5;
    sy *= 5;
    k *= 5;
  }
  // AutoCAD: «Grid too dense to display» — the pattern would be a smear, so it is not drawn.
  if (!(Math.min(sx, sy) >= MIN_GRID_PX)) {
    return (
      <p
        role="status"
        data-testid="grid-too-dense"
        className="pointer-events-none absolute bottom-8 left-1/2 -translate-x-1/2 rounded bg-[#1d2127]/90 px-2 py-0.5 text-xs text-[#d7dbe0]"
      >
        {t('design.cad.status.gridTooDense')}
      </p>
    );
  }
  const origin = toScreen({ cx, cy, scale }, { width, height }, 0, 0);
  const ox = ((origin.x % (sx * 5)) + sx * 5) % (sx * 5);
  const oy = ((origin.y % (sy * 5)) + sy * 5) % (sy * 5);
  return (
    <svg
      aria-hidden="true"
      data-testid="drafting-grid"
      className="pointer-events-none absolute inset-0 size-full"
    >
      <defs>
        <pattern
          id="cad-grid-minor"
          width={sx}
          height={sy}
          patternUnits="userSpaceOnUse"
          x={ox}
          y={oy}
        >
          <path d={`M${sx} 0H0V${sy}`} fill="none" stroke="#3a3f47" strokeWidth="0.6" />
        </pattern>
        <pattern
          id="cad-grid-major"
          width={sx * 5}
          height={sy * 5}
          patternUnits="userSpaceOnUse"
          x={ox}
          y={oy}
        >
          <rect width={sx * 5} height={sy * 5} fill="url(#cad-grid-minor)" />
          <path d={`M${sx * 5} 0H0V${sy * 5}`} fill="none" stroke="#4b525c" strokeWidth="0.8" />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill="url(#cad-grid-major)" />
    </svg>
  );
});

/** Markers, tracking paths and the AutoSnap / polar tooltip. */
function Snapping({ viewer }: { viewer: DrawingViewer }) {
  const { t } = useI18n();
  const { transform: tf, size, drafting } = viewer;
  const pointer = usePointer(drafting.store);
  const { settings } = drafting;
  if (!pointer.wants || !pointer.cursor) return null;
  const screen = (p: readonly [number, number]) => toScreen(tf, size, p[0], p[1]);
  const resolved = pointer.resolved;
  const far = Math.hypot(size.width, size.height) * 2;
  const paths = resolved?.tracks ?? [];
  const hit = resolved?.snap ?? null;
  let tip: string | null = null;
  if (hit) tip = t(`design.cad.status.mode.${hit.mode}` as MessageKey);
  else if (resolved?.polar) {
    tip = `${t(settings.ortho ? 'design.cad.status.orthoTip' : 'design.cad.status.polarTip')}: ${formatPolar(
      resolved.polar.distance,
      resolved.polar.angle,
      settings.units,
      settings.precision,
    )}`;
  } else if (paths.length > 0) tip = t('design.cad.status.trackTip');
  const marker = hit ? screen(hit.at) : null;
  const tipAt = marker ?? (resolved ? screen(resolved.at) : screen(pointer.cursor));
  return (
    <>
      <svg aria-hidden="true" className="pointer-events-none absolute inset-0 size-full">
        {pointer.acquired.map((a) => {
          const p = screen(a.at);
          return (
            <path
              key={`${a.at[0]},${a.at[1]}`}
              data-testid="acquired-point"
              d={`M${p.x - 4} ${p.y}H${p.x + 4}M${p.x} ${p.y - 4}V${p.y + 4}`}
              stroke={TRACK}
              strokeWidth="1.2"
            />
          );
        })}
        {paths.map((path, i) => {
          const from = screen(path.from);
          const a = (path.angle * Math.PI) / 180;
          return (
            <line
              key={i}
              data-testid="tracking-path"
              x1={from.x}
              y1={from.y}
              x2={from.x + Math.cos(a) * far}
              y2={from.y - Math.sin(a) * far}
              stroke={TRACK}
              strokeWidth="1"
              strokeDasharray="3 3"
            />
          );
        })}
        {hit?.from ? (
          <line
            x1={screen(hit.from).x}
            y1={screen(hit.from).y}
            x2={marker?.x}
            y2={marker?.y}
            stroke={TRACK}
            strokeWidth="1"
            strokeDasharray="3 3"
          />
        ) : null}
        {marker && hit ? (
          <g
            data-testid="snap-marker"
            data-mode={hit.mode}
            transform={`translate(${marker.x} ${marker.y})`}
            fill="none"
            stroke={MARKER}
            strokeWidth="2"
          >
            {markerShape(hit.mode, MARKER_PX)}
          </g>
        ) : null}
      </svg>
      {tip ? (
        <div
          data-testid="snap-tip"
          className="pointer-events-none absolute whitespace-nowrap rounded border border-[#6b7280] bg-[#3b4048] px-1.5 py-0.5 text-[11px] text-[#ffffff]"
          style={{ left: tipAt.x + 14, top: tipAt.y + 14 }}
        >
          {tip}
        </div>
      ) : null}
    </>
  );
}

/** Dynamic Input (F12): the prompt and the typed value at the pointer. */
function DynamicInput({ viewer }: { viewer: DrawingViewer }) {
  const { t } = useI18n();
  const { transform: tf, size, drafting, edit } = viewer;
  const pointer = usePointer(drafting.store);
  const { settings } = drafting;
  if (!settings.dyn || !edit.editing || !pointer.cursor) return null;
  const at = toScreen(tf, size, pointer.cursor[0], pointer.cursor[1]);
  const running = edit.command !== null;
  if (!running && edit.input === '') return null;
  const point = pointer.resolved?.at ?? pointer.cursor;
  let value: string | null = null;
  if (pointer.wants && pointer.anchor) {
    const dx = point[0] - pointer.anchor[0];
    const dy = point[1] - pointer.anchor[1];
    value = formatPolar(
      Math.hypot(dx, dy),
      (Math.atan2(dy, dx) * 180) / Math.PI,
      settings.units,
      settings.precision,
    );
  } else if (pointer.wants) value = formatCoordinates(point, settings.units, settings.precision);
  const prompt = running
    ? formatPrompt(t, edit.command ? COMMANDS[edit.command].name : null, edit.prompt)
    : null;
  return (
    <div
      data-testid="dynamic-input"
      dir="ltr"
      className="pointer-events-none absolute flex flex-col gap-0.5 text-[11px]"
      style={{ left: at.x + 18, top: at.y - 46 }}
    >
      {prompt ? (
        <span className="whitespace-nowrap rounded border border-[#6b7280] bg-[#3b4048] px-1.5 py-0.5 text-[#ffffff]">
          {prompt}
        </span>
      ) : null}
      <span className="flex gap-1">
        {edit.input !== '' ? (
          <span className="rounded border border-[#7fb2ff] bg-[#1d2127] px-1.5 py-0.5 font-mono text-[#ffffff]">
            {edit.input}
          </span>
        ) : null}
        {value ? (
          <span className="rounded border border-[#6b7280] bg-[#1d2127] px-1.5 py-0.5 font-mono text-[#d7dbe0]">
            {value}
          </span>
        ) : null}
      </span>
    </div>
  );
}

/** Selection Cycling: the objects under the pick, one to choose. */
function CycleList({ viewer }: { viewer: DrawingViewer }) {
  const { t } = useI18n();
  const { drafting, scene, transform: tf, size } = viewer;
  const cycle = drafting.cycle;
  if (!cycle || !scene) return null;
  const at = toScreen(tf, size, cycle.at.x, cycle.at.y);
  return (
    <div
      role="listbox"
      aria-label={t('design.cad.status.cycleTitle')}
      dir="ltr"
      onKeyDown={(event) => {
        if (event.key === 'Escape') drafting.setCycle(null);
      }}
      className="absolute z-40 min-w-40 rounded border border-[#4a505a] bg-[#2b2f36] py-1 text-xs text-[#e8eaed] shadow-xl"
      style={{ left: at.x + 12, top: at.y + 12 }}
    >
      <div className="flex items-center justify-between px-2 pb-1 font-semibold">
        {t('design.cad.status.cycleTitle')}
        <button
          type="button"
          aria-label={t('design.cad.dialogClose', { name: t('design.cad.status.cycleTitle') })}
          onClick={() => drafting.setCycle(null)}
          className="min-h-6 min-w-6 rounded hover:bg-white/10"
        >
          <span aria-hidden="true">✕</span>
        </button>
      </div>
      {cycle.candidates.map((index) => {
        const entity = scene.view.entities[index];
        const preview = viewer.edit.preview;
        const layer = preview
          ? scene.view.layers[effectiveLayer(scene, preview, index)]
          : undefined;
        // AutoCAD's list: the object's type and its layer (with the layer colour).
        return (
          <button
            key={index}
            type="button"
            role="option"
            aria-selected={cycle.lit === index}
            onClick={() => cycle.choose(index)}
            onMouseEnter={() => drafting.setCycle({ ...cycle, lit: index })}
            onFocus={() => drafting.setCycle({ ...cycle, lit: index })}
            className={`flex w-full items-center justify-between gap-3 px-2 py-1 text-start hover:bg-white/10 ${
              cycle.lit === index ? 'bg-white/10' : ''
            }`}
          >
            <span className="flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className="inline-block size-2.5 shrink-0 border border-white/40"
                style={{ backgroundColor: layer ? layer.color : 'transparent' }}
              />
              {typeName(entity?.kind ?? '')}
            </span>
            <span className="opacity-70">{layer ? layer.name : ''}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Quick Properties (QPMODE): the picked objects' general properties, read here. */
function QuickProperties({ viewer }: { viewer: DrawingViewer }) {
  const { t } = useI18n();
  const { edit, scene, drafting } = viewer;
  const preview = edit.preview;
  if (!drafting.settings.quickProperties || !edit.editing || edit.command !== null) return null;
  if (!scene || !preview || edit.chosen.size === 0) return null;
  const picked = [...edit.chosen];
  const kinds = new Set(picked.map((i) => scene.view.entities[i]?.kind ?? ''));
  const first = picked[0] as number;
  const title =
    picked.length === 1
      ? typeName(scene.view.entities[first]?.kind ?? '')
      : kinds.size === 1
        ? `${typeName([...kinds][0] ?? '')} (${picked.length})`
        : t('design.cad.status.qp.all', { count: picked.length });
  const layers = new Set(
    picked.map((i) => scene.view.layers[effectiveLayer(scene, preview, i)]?.name ?? ''),
  );
  const style = edit.selectionStyle;
  const varies = t('design.cad.status.qp.varies');
  const byLayer = t('design.cad.status.qp.byLayer');
  let length: string | null = null;
  if (
    picked.length === 1 &&
    ['LINE', 'LWPOLYLINE', 'POLYLINE'].includes(scene.view.entities[first]?.kind ?? '')
  ) {
    const flat = scene.view.entities[first]?.paths[0] ?? [];
    let sum = 0;
    for (let i = 2; i + 1 < flat.length; i += 2) {
      sum += Math.hypot(
        (flat[i] as number) - (flat[i - 2] as number),
        (flat[i + 1] as number) - (flat[i - 1] as number),
      );
    }
    length = formatLength(sum, drafting.settings.units, drafting.settings.precision);
  }
  const rows: [string, string][] = [
    [t('design.cad.status.qp.color'), style?.color ?? byLayer],
    [t('design.cad.status.qp.layer'), layers.size === 1 ? ([...layers][0] ?? '') : varies],
    [t('design.cad.status.qp.linetype'), style?.linetype ?? byLayer],
    [
      t('design.cad.status.qp.lineweight'),
      style?.lineweight !== null && style?.lineweight !== undefined
        ? `${style.lineweight} mm`
        : byLayer,
    ],
  ];
  if (length) rows.push([t('design.cad.status.qp.length'), length]);
  return (
    <section
      aria-label={t('design.cad.status.quickProperties')}
      dir="ltr"
      className="absolute bottom-2 right-2 z-30 w-56 rounded border border-[#4a505a] bg-[#2b2f36]/95 text-xs text-[#e8eaed] shadow-xl"
    >
      <div className="border-b border-[#4a505a] px-2 py-1 font-semibold">{title}</div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 px-2 py-1">
        {rows.map(([name, value]) => (
          <div key={name} className="contents">
            <dt className="opacity-75">{name}</dt>
            <dd className="truncate">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** Everything the status bar's aids draw over the canvas. */
export function DraftingOverlay({ viewer }: { viewer: DrawingViewer }) {
  const { settings } = viewer.drafting;
  return (
    <>
      {settings.grid ? (
        <Grid
          cx={viewer.transform.cx}
          cy={viewer.transform.cy}
          scale={viewer.transform.scale}
          width={viewer.size.width}
          height={viewer.size.height}
          gridX={settings.gridX}
          gridY={settings.gridY}
        />
      ) : null}
      <Snapping viewer={viewer} />
      <DynamicInput viewer={viewer} />
      <CycleList viewer={viewer} />
      <QuickProperties viewer={viewer} />
    </>
  );
}
