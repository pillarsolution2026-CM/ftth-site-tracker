'use client';

import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import { Ltr } from '@/shared/ui/ltr';
import { useI18n } from '@/shared/i18n/locale-provider';
import type { DrawingViewer } from '../hooks/use-drawing-viewer';
import { drawBase, drawOverlay, type DrawModel } from '../model/drawing-draw';
import { toWorld, wheelFactor, ZOOM_STEP, type ViewTransform } from '../model/view-transform';

/** Scenes up to this many entities are redrawn whole on every frame; bigger ones cache the base. */
export const CACHE_FROM_ENTITIES = 4000;
/** After a pan of a cached base the exact picture is redrawn when the pointer rests this long. */
const SETTLE_MS = 120;
const CLICK_SLOP_PX = 4;
const KEY_PAN_PX = 60;

interface Pointer {
  x: number;
  y: number;
}

interface BaseState {
  canvas: HTMLCanvasElement;
  tf: ViewTransform;
  model: DrawModel;
  width: number;
  height: number;
  dpr: number;
}

const sameBase = (a: BaseState, model: DrawModel, width: number, height: number, dpr: number) =>
  a.model.scene === model.scene &&
  a.model.preview === model.preview &&
  a.model.layerShown === model.layerShown &&
  a.width === width &&
  a.height === height &&
  a.dpr === dpr;

/**
 * The canvas of the drawing viewer: pan by drag, zoom by wheel / pinch / keys, click to inspect.
 * The heavy base (strokes and texts) is drawn on change only, through requestAnimationFrame; during
 * a pan of a big drawing the last base is moved instead and redrawn when the pointer rests.
 * The drawing's coordinates are LTR whatever the page direction.
 */
export function DrawingCanvas({
  viewer,
  model,
  children,
}: {
  viewer: DrawingViewer;
  model: DrawModel;
  children?: ReactNode;
}) {
  const { t } = useI18n();
  const { transform, size, setSize } = viewer;
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const baseRef = useRef<BaseState | null>(null);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [redrawTick, setRedrawTick] = useState(0);
  const pointers = useRef(new Map<number, Pointer>());
  const downAt = useRef<Pointer | null>(null);
  const moved = useRef(false);
  const pinch = useRef<{ distance: number } | null>(null);
  const forceFull = useRef(false);
  const zoomRef = useRef(viewer.zoomBy);

  // Canvas size follows the (resizable) container.
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const measure = () =>
      setSize({ width: Math.floor(element.clientWidth), height: Math.floor(element.clientHeight) });
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [setSize]);

  // Draw on change only.
  useEffect(() => {
    const canvas = canvasRef.current;
    const cache = viewer.cache;
    if (!canvas || !cache || size.width === 0 || size.height === 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const frame = requestAnimationFrame(() => {
      const pixelW = Math.round(size.width * dpr);
      const pixelH = Math.round(size.height * dpr);
      if (canvas.width !== pixelW) canvas.width = pixelW;
      if (canvas.height !== pixelH) canvas.height = pixelH;
      const viewport = { width: size.width, height: size.height, dpr };
      const big = model.scene.view.entities.length > CACHE_FROM_ENTITIES;
      const base = baseRef.current;
      const panned =
        big &&
        !forceFull.current &&
        base !== null &&
        sameBase(base, model, size.width, size.height, dpr) &&
        base.tf.scale === transform.scale &&
        (base.tf.cx !== transform.cx || base.tf.cy !== transform.cy);
      if (panned && base) {
        // Move the last picture; the exact one follows when the pointer rests.
        const dx = (base.tf.cx - transform.cx) * transform.scale;
        const dy = (transform.cy - base.tf.cy) * transform.scale;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(base.canvas, Math.round(dx * dpr), Math.round(dy * dpr));
        drawOverlay(ctx, model, cache, transform, viewport);
        return;
      }
      const reuse =
        base !== null &&
        base.tf === transform &&
        sameBase(base, model, size.width, size.height, dpr);
      if (!reuse) {
        const target = big ? (base?.canvas ?? document.createElement('canvas')) : canvas;
        if (big) {
          target.width = pixelW;
          target.height = pixelH;
        }
        const targetCtx = target === canvas ? ctx : target.getContext('2d');
        if (!targetCtx) return;
        drawBase(targetCtx, model, cache, transform, viewport);
        baseRef.current = big
          ? { canvas: target, tf: transform, model, width: size.width, height: size.height, dpr }
          : null;
      }
      forceFull.current = false;
      if (big && baseRef.current) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.drawImage(baseRef.current.canvas, 0, 0);
      }
      drawOverlay(ctx, model, cache, transform, viewport);
    });
    // A pan of a big drawing is settled by a full redraw when the pointer rests.
    const settle = window.setTimeout(() => {
      const base = baseRef.current;
      if (base && base.tf !== transform) {
        forceFull.current = true;
        setRedrawTick((tick) => tick + 1);
      }
    }, SETTLE_MS);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(settle);
    };
  }, [model, transform, size, viewer.cache, redrawTick]);

  // Wheel needs a non-passive listener to stop the page scrolling.
  useEffect(() => {
    zoomRef.current = viewer.zoomBy;
  });
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
      zoomRef.current(event.clientX - rect.left, event.clientY - rect.top, wheelFactor(delta));
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, []);

  const local = (event: PointerEvent<HTMLCanvasElement>): Pointer => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const onPointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
    const p = local(event);
    pointers.current.set(event.pointerId, p);
    event.currentTarget.setPointerCapture?.(event.pointerId);
    if (pointers.current.size === 1) {
      downAt.current = p;
      moved.current = false;
    } else {
      moved.current = true;
      const [a, b] = [...pointers.current.values()];
      pinch.current = a && b ? { distance: Math.hypot(a.x - b.x, a.y - b.y) } : null;
    }
  };

  const onPointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    const p = local(event);
    const world = toWorld(transform, size, p.x, p.y);
    setCursor({ x: world.x, y: world.y });
    const previous = pointers.current.get(event.pointerId);
    if (!previous) return;
    pointers.current.set(event.pointerId, p);
    if (pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      if (!a || !b || !pinch.current) return;
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch.current.distance > 0 && distance > 0) {
        // Midpoint moves by half of this finger's step.
        viewer.gesture(
          (a.x + b.x) / 2,
          (a.y + b.y) / 2,
          distance / pinch.current.distance,
          (p.x - previous.x) / 2,
          (p.y - previous.y) / 2,
        );
      }
      pinch.current = { distance };
      return;
    }
    const start = downAt.current;
    if (start && Math.hypot(p.x - start.x, p.y - start.y) > CLICK_SLOP_PX) moved.current = true;
    if (moved.current) viewer.pan(p.x - previous.x, p.y - previous.y);
  };

  const onPointerUp = (event: PointerEvent<HTMLCanvasElement>) => {
    const wasSingle = pointers.current.size === 1;
    const p = local(event);
    pointers.current.delete(event.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    if (wasSingle && !moved.current) viewer.click(p.x, p.y);
    if (pointers.current.size === 0) downAt.current = null;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLCanvasElement>) => {
    const cx = size.width / 2;
    const cy = size.height / 2;
    switch (event.key) {
      case '+':
      case '=':
        viewer.zoomBy(cx, cy, ZOOM_STEP);
        break;
      case '-':
      case '_':
        viewer.zoomBy(cx, cy, 1 / ZOOM_STEP);
        break;
      case '0':
        viewer.fit();
        break;
      case 'ArrowLeft':
        viewer.pan(KEY_PAN_PX, 0);
        break;
      case 'ArrowRight':
        viewer.pan(-KEY_PAN_PX, 0);
        break;
      case 'ArrowUp':
        viewer.pan(0, KEY_PAN_PX);
        break;
      case 'ArrowDown':
        viewer.pan(0, -KEY_PAN_PX);
        break;
      case 'Escape':
        viewer.closePopover();
        return;
      default:
        return;
    }
    event.preventDefault();
  };

  return (
    <div
      ref={containerRef}
      dir="ltr"
      className="relative h-[60vh] min-h-72 resize-y overflow-hidden rounded-md border border-(--color-border) bg-white"
    >
      <canvas
        ref={canvasRef}
        role="application"
        tabIndex={0}
        aria-label={t('design.viewer.canvasLabel')}
        aria-describedby="drawing-canvas-help"
        className="block size-full cursor-grab touch-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--color-focus)"
        style={{ width: '100%', height: '100%' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={() => setCursor(null)}
        onKeyDown={onKeyDown}
      />
      <p id="drawing-canvas-help" className="sr-only">
        {t('design.viewer.keysHelp')}
      </p>
      <div
        data-testid="drawing-coords"
        className="pointer-events-none absolute bottom-1 left-1 rounded bg-white/90 px-2 py-0.5 font-mono text-xs text-black"
      >
        <span className="font-sans">{t('design.viewer.coords')}: </span>
        <Ltr>{cursor ? `X ${cursor.x.toFixed(2)}  Y ${cursor.y.toFixed(2)}` : '—'}</Ltr>
      </div>
      {children}
    </div>
  );
}
