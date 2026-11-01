'use client';

import type { ReactElement } from 'react';
import type { AsBuiltGeometry } from '@ftth/shared';
import { useI18n } from '@/shared/i18n/locale-provider';
import { bboxOf, fitTransform, pathData, scaleBar, type ViewTransform } from '../model/drawing';

const WIDTH = 640;
const HEIGHT = 400;
const PADDING = 40;

type Layer = 'design' | 'current' | 'proposed';

/** Line style per layer. Colour only reinforces: dash, width and point symbol differ as well. */
const LAYER_STYLE: Record<
  Layer,
  {
    stroke: string;
    width: number;
    dash: string | undefined;
    symbol: 'square' | 'circle' | 'diamond';
  }
> = {
  design: { stroke: 'var(--color-text)', width: 2, dash: '8 6', symbol: 'square' },
  current: { stroke: 'var(--status-approved)', width: 2, dash: undefined, symbol: 'circle' },
  proposed: { stroke: 'var(--status-executed)', width: 4, dash: undefined, symbol: 'diamond' },
};

export interface ComparisonDrawingProps {
  design: AsBuiltGeometry | null;
  current: AsBuiltGeometry | null;
  proposed: AsBuiltGeometry | null;
  designCode: string | null;
  proposedLabel: string | null;
  crsEpsg: number;
}

function Symbol({ layer, x, y }: { layer: Layer; x: number; y: number }) {
  const style = LAYER_STYLE[layer];
  const common = { fill: 'var(--color-surface)', stroke: style.stroke, strokeWidth: 3 };
  if (style.symbol === 'square') {
    return <rect x={x - 7} y={y - 7} width={14} height={14} {...common} />;
  }
  if (style.symbol === 'circle') return <circle cx={x} cy={y} r={7} {...common} />;
  return <polygon points={`${x},${y - 9} ${x + 9},${y} ${x},${y + 9} ${x - 9},${y}`} {...common} />;
}

function Shape({
  layer,
  geometry,
  transform,
}: {
  layer: Layer;
  geometry: AsBuiltGeometry;
  transform: ViewTransform;
}) {
  const style = LAYER_STYLE[layer];
  if (geometry.type === 'Point') {
    const [x, y] = transform.project(geometry.coordinates);
    return (
      <g data-layer={layer} data-geometry="Point">
        <Symbol layer={layer} x={x} y={y} />
      </g>
    );
  }
  return (
    <g data-layer={layer} data-geometry="LineString">
      <path
        d={pathData(geometry.coordinates, transform)}
        fill="none"
        stroke={style.stroke}
        strokeWidth={style.width}
        strokeLinecap="round"
        strokeLinejoin="round"
        {...(style.dash ? { strokeDasharray: style.dash } : {})}
      />
    </g>
  );
}

/** Where a label sits: next to a point, over the middle vertex of a route. */
function labelAnchor(geometry: AsBuiltGeometry, transform: ViewTransform): [number, number] {
  if (geometry.type === 'Point') return transform.project(geometry.coordinates);
  const middle = geometry.coordinates[Math.floor(geometry.coordinates.length / 2)];
  return transform.project(middle ?? geometry.coordinates[0] ?? [0, 0]);
}

/**
 * Inline SVG comparison in project-CRS metres, fitted to the bounding box with y flipped (north
 * up). The SVG is always LTR: a map is not mirrored in RTL. Replaceable by the Phase 2 map viewer.
 */
export function ComparisonDrawing({
  design,
  current,
  proposed,
  designCode,
  proposedLabel,
  crsEpsg,
}: ComparisonDrawingProps) {
  const { t } = useI18n();
  const box = bboxOf([design, current, proposed]);
  if (!box) return <p>{t('asbuiltReview.detail.noGeometry')}</p>;
  const transform = fitTransform(box, WIDTH, HEIGHT, PADDING);
  const bar = scaleBar(transform.scale, 160);
  const layers: [Layer, AsBuiltGeometry | null][] = [
    ['design', design],
    ['current', current],
    ['proposed', proposed],
  ];

  const labels: ReactElement[] = [];
  const addLabel = (
    key: string,
    text: string | null,
    geometry: AsBuiltGeometry | null,
    dy: number,
  ) => {
    if (!text || !geometry) return;
    const [x, y] = labelAnchor(geometry, transform);
    labels.push(
      <text
        key={key}
        x={x}
        y={y + dy}
        textAnchor="middle"
        fontSize={13}
        fill="var(--color-text)"
        stroke="var(--color-surface)"
        strokeWidth={4}
        paintOrder="stroke"
        style={{ unicodeBidi: 'plaintext' }}
      >
        {text}
      </text>,
    );
  };
  addLabel('design-code', designCode, design, 24);
  addLabel('proposed-label', proposedLabel, proposed, -16);

  return (
    <figure className="m-0">
      <svg
        role="img"
        aria-label={t('asbuiltReview.drawing.label')}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        direction="ltr"
        className="h-auto w-full rounded-md border border-(--color-border) bg-(--color-surface)"
        data-testid="comparison-drawing"
      >
        <title>{t('asbuiltReview.drawing.label')}</title>
        {layers.map(([layer, geometry]) =>
          geometry ? (
            <Shape key={layer} layer={layer} geometry={geometry} transform={transform} />
          ) : null,
        )}
        {labels}
        {bar.metres > 0 ? (
          <g data-testid="scale-bar">
            <line
              x1={PADDING}
              x2={PADDING + bar.px}
              y1={HEIGHT - 14}
              y2={HEIGHT - 14}
              stroke="var(--color-text)"
              strokeWidth={3}
            />
            <text x={PADDING} y={HEIGHT - 20} fontSize={12} fill="var(--color-text)">
              {t('asbuiltReview.drawing.scale', { metres: bar.metres })}
            </text>
          </g>
        ) : null}
      </svg>
      <figcaption className="mt-1 text-sm">
        <bdi dir="ltr">{t('asbuiltReview.detail.crs', { epsg: crsEpsg })}</bdi>
      </figcaption>
    </figure>
  );
}

function LegendSample({ layer }: { layer: Layer }) {
  const style = LAYER_STYLE[layer];
  return (
    <svg width={44} height={18} aria-hidden="true" direction="ltr">
      <line
        x1={2}
        x2={42}
        y1={9}
        y2={9}
        stroke={style.stroke}
        strokeWidth={style.width}
        {...(style.dash ? { strokeDasharray: style.dash } : {})}
      />
    </svg>
  );
}

/** Text legend: what each line style means (never colour alone). */
export function DrawingLegend() {
  const { t } = useI18n();
  const entries: [Layer, 'design' | 'current' | 'proposed'][] = [
    ['design', 'design'],
    ['current', 'current'],
    ['proposed', 'proposed'],
  ];
  return (
    <section aria-label={t('asbuiltReview.legend.title')} className="text-sm">
      <h3 className="font-semibold">{t('asbuiltReview.legend.title')}</h3>
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {entries.map(([layer, key]) => (
          <li key={layer} className="flex items-center gap-2">
            <LegendSample layer={layer} />
            <span>{t(`asbuiltReview.legend.${key}`)}</span>
          </li>
        ))}
        <li>{t('asbuiltReview.legend.point')}</li>
      </ul>
    </section>
  );
}
