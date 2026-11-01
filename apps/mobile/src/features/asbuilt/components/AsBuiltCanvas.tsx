import { memo } from 'react';
import Svg, { Circle, Polyline, Rect, Text as SvgText } from 'react-native-svg';
import type { FeatureType } from '@ftth/shared';
import { cadPalette, minTouchTarget, type CadMode } from '@ftth/ui-tokens';
import { toScreen, type Viewport } from '../../cad/model/viewport';
import type { RenderModel } from '../model/render-model';

interface Props {
  model: RenderModel;
  viewport: Viewport;
  mode: CadMode;
  visible: ReadonlySet<FeatureType>;
}

const POINT_RADIUS = 7;
/** Marker glyph by style (colour is never the only cue). */
const PENDING_GLYPH = '⏳';
const ADDED_GLYPH = '+';

const pointsAttr = (viewport: Viewport, coords: readonly (readonly [number, number])[]) =>
  coords
    .map(([x, y]) => {
      const { sx, sy } = toScreen(viewport, x, y);
      return `${sx.toFixed(1)},${sy.toFixed(1)}`;
    })
    .join(' ');

/**
 * The drawing in As-Built mode: design dashed under the As-Built geometry, approved As-Built in
 * the As-Built colour, my pending edits in the pending colour with a glyph, grips on the
 * selected route, the route being drawn, and the snap ring while dragging.
 */
export const AsBuiltCanvas = memo(function AsBuiltCanvas({
  model,
  viewport,
  mode,
  visible,
}: Props) {
  const palette = cadPalette[mode];
  return (
    <Svg width={viewport.widthPx} height={viewport.heightPx} testID="asbuilt-canvas">
      <Rect width={viewport.widthPx} height={viewport.heightPx} fill={palette.background} />
      {model.design.map((d) =>
        d.kind === 'route' ? (
          <Polyline
            key={`design-${d.id}`}
            testID={`design-${d.id}`}
            points={pointsAttr(viewport, d.coords)}
            stroke={palette.route}
            strokeWidth={1.5}
            strokeDasharray="8 4"
            fill="none"
            opacity={0.7}
          />
        ) : (
          (() => {
            const [x, y] = d.coords[0] ?? [0, 0];
            const { sx, sy } = toScreen(viewport, x, y);
            return (
              <Circle
                key={`design-${d.id}`}
                testID={`design-${d.id}`}
                cx={sx}
                cy={sy}
                r={POINT_RADIUS}
                stroke={palette.text}
                strokeWidth={1.5}
                strokeDasharray="4 3"
                fill="none"
              />
            );
          })()
        ),
      )}
      {model.features
        .filter((f) => visible.has(f.type))
        .map((f) => {
          const base = palette[f.type];
          const color =
            f.style === 'design'
              ? base
              : f.style === 'pending'
                ? palette.asbuiltPending
                : palette.asbuilt;
          const dash = f.style === 'pending' ? '2 5' : undefined;
          const first = f.coords[0] ?? [0, 0];
          const mid = f.coords[Math.floor(f.coords.length / 2)] ?? first;
          const anchor = toScreen(viewport, mid[0], mid[1]);
          const glyph =
            f.style === 'pending' ? PENDING_GLYPH : f.style === 'session' ? ADDED_GLYPH : '';
          const label = f.text ? `${glyph} ${f.text}`.trim() : glyph;
          const textFill = f.textIsAsBuilt || f.style !== 'design' ? color : palette.text;
          return [
            f.kind === 'route' ? (
              <Polyline
                key={f.id}
                testID={`feature-${f.id}`}
                points={pointsAttr(viewport, f.coords)}
                stroke={color}
                strokeWidth={f.selected ? 5 : 2.5}
                strokeDasharray={dash}
                fill="none"
              />
            ) : (
              <Circle
                key={f.id}
                testID={`feature-${f.id}`}
                cx={anchor.sx}
                cy={anchor.sy}
                r={f.selected ? POINT_RADIUS + 3 : POINT_RADIUS}
                stroke={color}
                strokeWidth={2.5}
                strokeDasharray={dash}
                fill={f.style === 'design' ? 'none' : color}
              />
            ),
            label ? (
              <SvgText
                key={`${f.id}-text`}
                x={anchor.sx + POINT_RADIUS + 4}
                y={anchor.sy - POINT_RADIUS}
                fill={textFill}
                fontSize={13}
              >
                {label}
              </SvgText>
            ) : null,
          ];
        })}
      {model.draft.length > 0 ? (
        <>
          {model.draft.length > 1 ? (
            <Polyline
              testID="draft-route"
              points={pointsAttr(
                viewport,
                model.draft.map((p) => [p.x, p.y] as const),
              )}
              stroke={palette.asbuilt}
              strokeWidth={3}
              fill="none"
            />
          ) : null}
          {model.draft.map((p, i) => {
            const { sx, sy } = toScreen(viewport, p.x, p.y);
            return (
              <Circle
                key={`draft-${i}`}
                cx={sx}
                cy={sy}
                r={5}
                fill={palette.asbuilt}
                stroke={palette.text}
                strokeWidth={1}
              />
            );
          })}
        </>
      ) : null}
      {model.grips.map((grip) => {
        const { sx, sy } = toScreen(viewport, grip.at.x, grip.at.y);
        const key = `grip-${grip.kind}-${grip.index}`;
        // The finger target is 44 dp (model hit radius); the drawn handle is smaller.
        return grip.kind === 'vertex' ? (
          <Rect
            key={key}
            testID={key}
            x={sx - 7}
            y={sy - 7}
            width={14}
            height={14}
            fill={grip.selected ? palette.crosshair : palette.asbuilt}
            stroke={palette.text}
            strokeWidth={2}
          />
        ) : (
          <Circle
            key={key}
            testID={key}
            cx={sx}
            cy={sy}
            r={5}
            fill="none"
            stroke={palette.asbuilt}
            strokeWidth={2}
          />
        );
      })}
      {model.snapAt
        ? (() => {
            const { sx, sy } = toScreen(viewport, model.snapAt.x, model.snapAt.y);
            return (
              <Circle
                testID="snap-ring"
                cx={sx}
                cy={sy}
                r={minTouchTarget / 4 + 4}
                stroke={palette.crosshair}
                strokeWidth={2}
                fill="none"
              />
            );
          })()
        : null}
    </Svg>
  );
});
