'use client';

import 'maplibre-gl/dist/maplibre-gl.css';
import { useEffect, useRef, useState } from 'react';
import type {
  GeoJSONSource,
  Map as MapLibreMap,
  MapMouseEvent,
  RasterSourceSpecification,
} from 'maplibre-gl';
import type { PlacementAdjust } from '@ftth/shared';
import { Button } from '@/shared/ui/button';
import { Card } from '@/shared/ui/card';
import { Input } from '@/shared/ui/input';
import { Notice } from '@/shared/ui/notice';
import { useI18n } from '@/shared/i18n/locale-provider';
import {
  MAX_HAND_SCALE,
  MIN_HAND_SCALE,
  angleBetween,
  lonLatToProject,
  moveAdjust,
  scaleBetween,
  turnAdjust,
} from '../model/placement-form';
import type { PlacementPreview } from '../model/placement-preview';

const WORKER_URL = '/maplibre-gl-worker.mjs';

export type HandTool = 'none' | 'move' | 'rotate' | 'scale';
const TOOLS: readonly HandTool[] = ['none', 'move', 'rotate', 'scale'];

/**
 * Base maps are a list so satellite layers can be added later without changing the screen
 * (ADR-035: OpenStreetMap for now; Esri / Google need an account or a key).
 */
const BASE_MAPS: Record<'osm', RasterSourceSpecification> = {
  osm: {
    type: 'raster',
    tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
    tileSize: 256,
    maxzoom: 19,
    attribution: '© OpenStreetMap contributors',
  },
};

export interface PlacementMapProps {
  preview: PlacementPreview;
  projectEpsg: number;
  adjust: PlacementAdjust;
  /** Number of route lines shown when the server cut the list. */
  truncatedAt: number | null;
  disabled: boolean;
  onAdjust: (adjust: PlacementAdjust) => void;
  onReset: () => void;
}

/** The drawing at its new place over OpenStreetMap, with Move / Rotate / Scale (ADR-035). */
export function PlacementMap(props: PlacementMapProps) {
  const { t } = useI18n();
  const { preview, adjust, disabled } = props;
  const [tool, setTool] = useState<HandTool>('none');
  const centre = preview.centre;

  const turnBy = (deg: number, factor: number) => {
    if (centre) props.onAdjust(turnAdjust(adjust, centre, deg, factor));
  };

  return (
    <Card aria-labelledby="placement-map-title" role="region" className="flex flex-col gap-4">
      <h2 id="placement-map-title" className="text-lg font-semibold">
        {t('mapping.placement.map.title')}
      </h2>
      <p className="text-sm">{t('mapping.placement.map.hint')}</p>
      {props.truncatedAt !== null ? (
        <Notice kind="info">
          {t('mapping.placement.map.truncated', { count: props.truncatedAt })}
        </Notice>
      ) : null}

      {disabled ? null : (
        <fieldset className="flex flex-wrap items-center gap-2">
          <legend className="mb-1 text-sm font-medium">{t('mapping.placement.map.tool')}</legend>
          {TOOLS.map((value) => (
            <label
              key={value}
              className={
                'inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-md border px-3 ' +
                (tool === value
                  ? 'border-2 border-(--color-brand) font-semibold'
                  : 'border-(--color-border)')
              }
            >
              <input
                type="radio"
                name="placement-tool"
                value={value}
                checked={tool === value}
                disabled={value !== 'none' && !centre}
                onChange={() => setTool(value)}
              />
              {t(`mapping.placement.map.tools.${value}`)}
            </label>
          ))}
          {tool !== 'none' ? (
            <p className="w-full text-sm" role="status">
              {t('mapping.placement.map.dragHint', {
                tool: t(`mapping.placement.map.tools.${tool}`),
              })}
            </p>
          ) : null}
        </fieldset>
      )}

      <MapView
        preview={preview}
        projectEpsg={props.projectEpsg}
        adjust={adjust}
        tool={disabled ? 'none' : tool}
        onAdjust={props.onAdjust}
      />

      <section aria-labelledby="placement-adjust" className="flex flex-col gap-3">
        <h3 id="placement-adjust" className="font-semibold">
          {t('mapping.placement.map.adjust')}
        </h3>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <NumberField
            id="placement-dx"
            label={t('mapping.placement.map.dx')}
            value={adjust.dx}
            disabled={disabled}
            onCommit={(value) => props.onAdjust(moveAdjust(adjust, value - adjust.dx, 0))}
          />
          <NumberField
            id="placement-dy"
            label={t('mapping.placement.map.dy')}
            value={adjust.dy}
            disabled={disabled}
            onCommit={(value) => props.onAdjust(moveAdjust(adjust, 0, value - adjust.dy))}
          />
          <NumberField
            id="placement-rotation"
            label={t('mapping.placement.map.rotationDeg')}
            value={adjust.rotationDeg}
            disabled={disabled || !centre}
            onCommit={(value) => turnBy(value - adjust.rotationDeg, 1)}
          />
          <NumberField
            id="placement-scale"
            label={t('mapping.placement.map.scale')}
            value={adjust.scale}
            disabled={disabled || !centre}
            onCommit={(value) => {
              if (value >= MIN_HAND_SCALE && value <= MAX_HAND_SCALE)
                turnBy(0, value / adjust.scale);
            }}
          />
        </div>
        {disabled ? null : (
          <div>
            <Button variant="outline" onClick={props.onReset}>
              {t('mapping.placement.map.reset')}
            </Button>
          </div>
        )}
      </section>
    </Card>
  );
}

/** A number input that applies on blur / Enter, so typing "-" or "1." is not cut short. */
function NumberField({
  id,
  label,
  value,
  disabled,
  onCommit,
}: {
  id: string;
  label: string;
  value: number;
  disabled: boolean;
  onCommit: (value: number) => void;
}) {
  const [text, setText] = useState(String(value));
  const [last, setLast] = useState(value);
  if (last !== value) {
    setLast(value);
    setText(String(value));
  }
  const commit = () => {
    const parsed = Number(text.trim());
    if (text.trim() !== '' && Number.isFinite(parsed) && parsed !== value) onCommit(parsed);
    else setText(String(value));
  };
  return (
    <Input
      id={id}
      dir="ltr"
      inputMode="decimal"
      label={label}
      value={text}
      disabled={disabled}
      onChange={(event) => setText(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          commit();
        }
      }}
    />
  );
}

function MapView({
  preview,
  projectEpsg,
  adjust,
  tool,
  onAdjust,
}: {
  preview: PlacementPreview;
  projectEpsg: number;
  adjust: PlacementAdjust;
  tool: HandTool;
  onAdjust: (adjust: PlacementAdjust) => void;
}) {
  const { t } = useI18n();
  const container = useRef<HTMLDivElement | null>(null);
  const map = useRef<MapLibreMap | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  // Fit the view again whenever the set of control points changes (a placed drawing moves far).
  const fittedFor = useRef<string | null>(null);
  const fitKey = preview.points.features
    .filter((f) => f.properties.kind === 'placed')
    .map((f) => f.properties.label)
    .join(',');
  // Latest values for the drag handlers registered once.
  const live = useRef({ preview, adjust, tool, onAdjust, projectEpsg });
  live.current = { preview, adjust, tool, onAdjust, projectEpsg };

  useEffect(() => {
    let cancelled = false;
    let instance: MapLibreMap | null = null;
    void (async () => {
      try {
        const maplibre = await import('maplibre-gl');
        if (cancelled || !container.current) return;
        // Served from /public (scripts/copy-map-worker.mjs): bundling breaks the default URL.
        maplibre.setWorkerUrl(WORKER_URL);
        instance = new maplibre.Map({
          container: container.current,
          attributionControl: { compact: true },
          style: {
            version: 8,
            sources: { base: BASE_MAPS.osm },
            layers: [{ id: 'base', type: 'raster', source: 'base' }],
          },
          center: [31.2, 30.0],
          zoom: 5,
        });
        instance.addControl(new maplibre.NavigationControl({ showCompass: false }));
        instance.on('load', () => {
          if (!instance) return;
          const colours = themeColours();
          instance.addSource('lines', { type: 'geojson', data: live.current.preview.lines });
          instance.addSource('points', { type: 'geojson', data: live.current.preview.points });
          instance.addLayer({
            id: 'routes',
            type: 'line',
            source: 'lines',
            filter: ['==', ['get', 'kind'], 'route'],
            paint: { 'line-color': colours.brand, 'line-width': 2 },
          });
          instance.addLayer({
            id: 'errors',
            type: 'line',
            source: 'lines',
            filter: ['==', ['get', 'kind'], 'error'],
            paint: { 'line-color': colours.danger, 'line-width': 1.5, 'line-dasharray': [2, 2] },
          });
          instance.addLayer({
            id: 'items',
            type: 'circle',
            source: 'points',
            filter: [
              '!',
              ['in', ['get', 'kind'], ['literal', ['placed', 'target', 'target-excluded']]],
            ],
            paint: {
              'circle-radius': 3,
              'circle-color': colours.brand,
              'circle-stroke-color': '#ffffff',
              'circle-stroke-width': 1,
            },
          });
          instance.addLayer({
            id: 'targets',
            type: 'circle',
            source: 'points',
            filter: ['in', ['get', 'kind'], ['literal', ['target', 'target-excluded']]],
            paint: {
              'circle-radius': 6,
              'circle-color': 'rgba(0,0,0,0)',
              'circle-stroke-color': [
                'case',
                ['==', ['get', 'kind'], 'target-excluded'],
                '#888888',
                colours.danger,
              ],
              'circle-stroke-width': 2,
            },
          });
          instance.addLayer({
            id: 'placed',
            type: 'circle',
            source: 'points',
            filter: ['==', ['get', 'kind'], 'placed'],
            paint: { 'circle-radius': 4, 'circle-color': colours.danger },
          });
          setState('ready');
        });
        registerDrag(instance, live);
        map.current = instance;
      } catch {
        if (!cancelled) setState('unavailable');
      }
    })();
    return () => {
      cancelled = true;
      instance?.remove();
      map.current = null;
    };
  }, []);

  useEffect(() => {
    const instance = map.current;
    if (state !== 'ready' || !instance) return;
    (instance.getSource('lines') as GeoJSONSource | undefined)?.setData(preview.lines);
    (instance.getSource('points') as GeoJSONSource | undefined)?.setData(preview.points);
    if (fittedFor.current !== fitKey && preview.bounds) {
      fittedFor.current = fitKey;
      instance.fitBounds(preview.bounds, { padding: 40, duration: 0, maxZoom: 18 });
    }
  }, [preview, state, fitKey]);

  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    if (tool === 'none') instance.dragPan.enable();
    else instance.dragPan.disable();
  }, [tool, state]);

  return (
    <div className="flex flex-col gap-2">
      {state === 'unavailable' ? (
        <Notice kind="warning">{t('mapping.placement.map.unavailable')}</Notice>
      ) : null}
      <div
        ref={container}
        className="h-[28rem] w-full overflow-hidden rounded-md border border-(--color-border)"
        dir="ltr"
        aria-label={t('mapping.placement.map.title')}
        role="application"
        hidden={state === 'unavailable'}
      />
      {state === 'loading' ? <p role="status">{t('common.loading')}</p> : null}
    </div>
  );
}

/** Pointer drags of the hand tools: each drag starts from the adjustment it found. */
function registerDrag(
  instance: MapLibreMap,
  live: {
    current: {
      preview: PlacementPreview;
      adjust: PlacementAdjust;
      tool: HandTool;
      onAdjust: (adjust: PlacementAdjust) => void;
      projectEpsg: number;
    };
  },
) {
  let drag: {
    start: { x: number; y: number };
    adjust: PlacementAdjust;
    pivot: { x: number; y: number };
    toProject: (lon: number, lat: number) => { x: number; y: number };
  } | null = null;

  instance.on('mousedown', (event: MapMouseEvent) => {
    const { tool, preview, adjust, projectEpsg } = live.current;
    if (tool === 'none' || !preview.centre) return;
    event.preventDefault();
    const toProject = lonLatToProject(projectEpsg);
    drag = {
      start: toProject(event.lngLat.lng, event.lngLat.lat),
      adjust,
      pivot: preview.centre,
      toProject,
    };
  });
  instance.on('mousemove', (event: MapMouseEvent) => {
    if (!drag) return;
    const { tool, onAdjust } = live.current;
    const here = drag.toProject(event.lngLat.lng, event.lngLat.lat);
    if (tool === 'move') {
      onAdjust(moveAdjust(drag.adjust, here.x - drag.start.x, here.y - drag.start.y));
    } else if (tool === 'rotate') {
      onAdjust(turnAdjust(drag.adjust, drag.pivot, angleBetween(drag.pivot, drag.start, here), 1));
    } else if (tool === 'scale') {
      onAdjust(turnAdjust(drag.adjust, drag.pivot, 0, scaleBetween(drag.pivot, drag.start, here)));
    }
  });
  const end = () => {
    drag = null;
  };
  instance.on('mouseup', end);
  instance.on('mouseout', end);
}

function themeColours() {
  const style = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    brand: read('--color-brand', '#1d4ed8'),
    danger: read('--status-rejected', '#b91c1c'),
  };
}
