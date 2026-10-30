import { memo } from 'react';
import Svg, { Circle, Line, Polyline, Rect, Text as SvgText } from 'react-native-svg';
import type { FeatureType, OfflineFeature } from '@ftth/shared';
import { cadPalette, type CadMode } from '@ftth/ui-tokens';
import { toScreen, visibleFeatures, type Viewport } from '../model/viewport';

interface CadCanvasProps {
  features: readonly OfflineFeature[];
  viewport: Viewport;
  visible: ReadonlySet<FeatureType>;
  mode: CadMode;
  selectedId: string | null;
  /** Features with at least one update; drawn with a marker (never colour alone). */
  updatedIds: ReadonlySet<string>;
}

const POINT_RADIUS = 7;

/** Network features in project-CRS metres drawn as vectors, with the crosshair on top. */
export const CadCanvas = memo(function CadCanvas({
  features,
  viewport,
  visible,
  mode,
  selectedId,
  updatedIds,
}: CadCanvasProps) {
  const palette = cadPalette[mode];
  const shown = visibleFeatures(features, viewport, visible);
  const cx = viewport.widthPx / 2;
  const cy = viewport.heightPx / 2;
  return (
    <Svg width={viewport.widthPx} height={viewport.heightPx} testID="cad-canvas">
      <Rect width={viewport.widthPx} height={viewport.heightPx} fill={palette.background} />
      {shown.map((feature) => {
        const color = palette[feature.type];
        const selected = feature.id === selectedId;
        if (feature.geometry.type === 'LineString') {
          const points = feature.geometry.coordinates
            .map(([x, y]) => {
              const { sx, sy } = toScreen(viewport, x, y);
              return `${sx.toFixed(1)},${sy.toFixed(1)}`;
            })
            .join(' ');
          return (
            <Polyline
              key={feature.id}
              testID={`feature-${feature.id}`}
              points={points}
              stroke={color}
              strokeWidth={selected ? 5 : 2.5}
              strokeDasharray={updatedIds.has(feature.id) ? undefined : '8 4'}
              fill="none"
            />
          );
        }
        const [x, y] = feature.geometry.coordinates;
        const { sx, sy } = toScreen(viewport, x, y);
        return [
          <Circle
            key={feature.id}
            testID={`feature-${feature.id}`}
            cx={sx}
            cy={sy}
            r={selected ? POINT_RADIUS + 3 : POINT_RADIUS}
            stroke={color}
            strokeWidth={2.5}
            fill={updatedIds.has(feature.id) ? color : 'none'}
          />,
          feature.code ? (
            <SvgText
              key={`${feature.id}-code`}
              x={sx + POINT_RADIUS + 4}
              y={sy - POINT_RADIUS}
              fill={palette.text}
              fontSize={13}
            >
              {feature.code}
            </SvgText>
          ) : null,
        ];
      })}
      <Line
        x1={cx - 18}
        y1={cy}
        x2={cx + 18}
        y2={cy}
        stroke={palette.crosshair}
        strokeWidth={1.5}
      />
      <Line
        x1={cx}
        y1={cy - 18}
        x2={cx}
        y2={cy + 18}
        stroke={palette.crosshair}
        strokeWidth={1.5}
      />
      <Rect
        x={cx - 6}
        y={cy - 6}
        width={12}
        height={12}
        stroke={palette.crosshair}
        strokeWidth={1.5}
        fill="none"
      />
    </Svg>
  );
});
