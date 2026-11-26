'use client';

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import { Ltr } from '@/shared/ui/ltr';
import { useI18n } from '@/shared/i18n/locale-provider';
import type { DrawingViewer } from '../hooks/use-drawing-viewer';
import {
  CANVAS_BG,
  drawBase,
  drawOverlay,
  SelectionLayer,
  viewShift,
  type DrawModel,
} from '../model/drawing-draw';
import { CanvasContextMenu } from './canvas-context-menu';
import { SnapMenu } from './snap-menu';
import type { CrosshairSize } from '../hooks/use-crosshair-size';
import { OsmBackdrop } from './osm-backdrop';
import { latinKey } from '../model/keyboard-layout';
import { toWorld, wheelFactor, ZOOM_STEP, type ViewTransform } from '../model/view-transform';

/** Scenes up to this many entities are redrawn whole on every frame; bigger ones cache the base. */
export const CACHE_FROM_ENTITIES = 300;
/** The pointer's work (snaps, rubber band, grips) runs at most once per this many ms. */
const POINTER_FRAME_MS = 16;
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

/** The crosshair before the pointer comes (a constant: React never resets what showHair set). */
const HAIR_HIDDEN = { display: 'none' } as const;

const sameFade = (a: DrawModel['lockedFade'], b: DrawModel['lockedFade']) =>
  a === b || (a !== undefined && b !== undefined && a.layers === b.layers && a.alpha === b.alpha);

const sameBase = (a: BaseState, model: DrawModel, width: number, height: number, dpr: number) =>
  a.model.scene === model.scene &&
  a.model.preview === model.preview &&
  a.model.layerShown === model.layerShown &&
  a.model.mapBehind === model.mapBehind &&
  a.model.objectShown === model.objectShown &&
  a.model.lineweights === model.lineweights &&
  a.model.transparency === model.transparency &&
  a.model.layerColor === model.layerColor &&
  a.model.noteHeight === model.noteHeight &&
  sameFade(a.model.lockedFade, model.lockedFade) &&
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
  fill = false,
  crosshair = 'full',
  children,
}: {
  viewer: DrawingViewer;
  model: DrawModel;
  /** Full screen: the canvas takes the height left instead of 72 % of the window. */
  fill?: boolean;
  /** AutoCAD's CURSORSIZE: across the drawing (100) or short arms (5) around the pick box. */
  crosshair?: CrosshairSize;
  children?: ReactNode;
}) {
  const { t } = useI18n();
  const { transform, size, setSize } = viewer;
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const baseRef = useRef<BaseState | null>(null);
  /**
   * The pointer on screen: AutoCAD's crosshair is drawn there (ADR-051), and its drawing
   * coordinates. Moved by ref, not React state: a pointer move renders nothing (audit 10.6).
   */
  const hairRef = useRef<HTMLDivElement>(null);
  const coordsRef = useRef<HTMLSpanElement>(null);
  const showHair = (p: Pointer | null, world?: { x: number; y: number }) => {
    const hair = hairRef.current;
    if (hair) {
      hair.style.display = p ? '' : 'none';
      if (p) {
        hair.style.setProperty('--hx', `${p.x}px`);
        hair.style.setProperty('--hy', `${p.y}px`);
      }
    }
    const coords = coordsRef.current;
    if (coords) {
      coords.textContent = world ? `X ${world.x.toFixed(2)}  Y ${world.y.toFixed(2)}` : '—';
    }
  };
  const [redrawTick, setRedrawTick] = useState(0);
  // The pointer a running command follows (ghost, rubber band): the canvas alone listens to it.
  const livePointer = useSyncExternalStore(
    viewer.edit.pointerStore.subscribe,
    viewer.edit.pointerStore.get,
    () => null,
  );
  const liveDraw = viewer.edit.liveDraw;
  const drawModel = useMemo<DrawModel>(() => {
    const drawn = liveDraw(livePointer);
    return drawn.ghost === null && drawn.sketch === null
      ? model
      : { ...model, ghost: drawn.ghost, sketch: drawn.sketch };
  }, [model, liveDraw, livePointer]);
  const pointers = useRef(new Map<number, Pointer>());
  const downAt = useRef<Pointer | null>(null);
  const moved = useRef(false);
  const pinch = useRef<{ distance: number } | null>(null);
  const forceFull = useRef(false);
  /** The picked objects, drawn once per selection / view (audit 10.1). */
  const selectionRef = useRef<SelectionLayer | null>(null);
  /** When the last wheel step came: a burst scales the cached base (audit 10.3). */
  const wheelAt = useRef(-Infinity);
  const zoomRef = useRef(viewer.zoomBy);
  /** Edit mode, layer tool: a left drag draws a selection box instead of panning (ADR-047). */
  const bandFrom = useRef<{ x: number; y: number } | null>(null);
  const boxing = viewer.edit.boxing;
  /** The right-click menu on picked objects (owner 2026-11-24), at canvas pixels. */
  const [menu, setMenu] = useState<Pointer | null>(null);
  /** Shift + right-click at a point prompt: the one-time Object Snap overrides (item 28). */
  const [snapMenu, setSnapMenu] = useState<Pointer | null>(null);

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
    const selection = (selectionRef.current ??= new SelectionLayer());
    const frame = requestAnimationFrame(() => {
      const pixelW = Math.round(size.width * dpr);
      const pixelH = Math.round(size.height * dpr);
      if (canvas.width !== pixelW) canvas.width = pixelW;
      if (canvas.height !== pixelH) canvas.height = pixelH;
      const viewport = { width: size.width, height: size.height, dpr };
      const big = model.scene.view.entities.length > CACHE_FROM_ENTITIES;
      const base = baseRef.current;
      const kept =
        big &&
        !forceFull.current &&
        base !== null &&
        sameBase(base, model, size.width, size.height, dpr);
      const panned =
        kept &&
        base.tf.scale === transform.scale &&
        (base.tf.cx !== transform.cx || base.tf.cy !== transform.cy);
      // A wheel burst scales the last picture (audit 10.3); the exact one follows at rest.
      const zoomed =
        kept &&
        base.tf.scale !== transform.scale &&
        performance.now() - wheelAt.current < SETTLE_MS;
      if ((panned || zoomed) && base) {
        // Move the last picture; the exact one follows when the pointer rests.
        const [r, , , , e, f] = viewShift(base.tf, transform, viewport);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        if (model.mapBehind) ctx.clearRect(0, 0, canvas.width, canvas.height);
        else {
          ctx.fillStyle = CANVAS_BG;
          ctx.fillRect(0, 0, canvas.width, canvas.height);
        }
        if (r === 1) ctx.drawImage(base.canvas, Math.round(e), Math.round(f));
        else ctx.drawImage(base.canvas, e, f, base.canvas.width * r, base.canvas.height * r);
        drawOverlay(ctx, drawModel, cache, transform, viewport, { selection, fast: true });
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
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(baseRef.current.canvas, 0, 0);
      }
      drawOverlay(ctx, drawModel, cache, transform, viewport, { selection });
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
  }, [model, drawModel, transform, size, viewer.cache, redrawTick]);

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
      wheelAt.current = performance.now();
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
    // The right button opens the menu (contextmenu); it neither pans nor picks.
    if (event.button === 2) return;
    setMenu(null);
    setSnapMenu(null);
    const p = local(event);
    pointers.current.set(event.pointerId, p);
    event.currentTarget.setPointerCapture?.(event.pointerId);
    if (pointers.current.size === 1) {
      downAt.current = p;
      moved.current = false;
      bandFrom.current = boxing && event.button === 0 ? toWorld(transform, size, p.x, p.y) : null;
    } else {
      moved.current = true;
      bandFrom.current = null;
      viewer.edit.setBand(null);
      const [a, b] = [...pointers.current.values()];
      pinch.current = a && b ? { distance: Math.hypot(a.x - b.x, a.y - b.y) } : null;
    }
  };

  // The pointer's heavy work (grip hover, object snaps, the command's rubber band) runs once per
  // frame with the latest position, not once per event (round 2, items 26 / 30).
  const viewerRef = useRef(viewer);
  const transformRef = useRef(transform);
  const sizeRef = useRef(size);
  useEffect(() => {
    viewerRef.current = viewer;
    transformRef.current = transform;
    sizeRef.current = size;
  });
  const pendingHover = useRef<Pointer | null>(null);
  const hoverFrame = useRef<number | null>(null);
  const lastHover = useRef(0);
  const flushHover = () => {
    if (hoverFrame.current !== null) cancelAnimationFrame(hoverFrame.current);
    hoverFrame.current = null;
    const p = pendingHover.current;
    pendingHover.current = null;
    if (!p) return;
    lastHover.current = performance.now();
    const current = viewerRef.current;
    current.hoverAt(p.x, p.y);
    if (current.edit.tracking) {
      current.edit.hover(toWorld(transformRef.current, sizeRef.current, p.x, p.y));
    }
  };
  const queueHover = (p: Pointer) => {
    pendingHover.current = p;
    if (hoverFrame.current !== null) return;
    if (performance.now() - lastHover.current >= POINTER_FRAME_MS) flushHover();
    else hoverFrame.current = requestAnimationFrame(flushHover);
  };
  useEffect(
    () => () => {
      if (hoverFrame.current !== null) cancelAnimationFrame(hoverFrame.current);
    },
    [],
  );

  const onPointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    const p = local(event);
    const world = toWorld(transform, size, p.x, p.y);
    showHair(p, world);
    queueHover(p);
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
    if (!moved.current) return;
    const from = bandFrom.current;
    if (from) viewer.edit.setBand({ x0: from.x, y0: from.y, x1: world.x, y1: world.y });
    else viewer.pan(p.x - previous.x, p.y - previous.y);
  };

  const onPointerUp = (event: PointerEvent<HTMLCanvasElement>) => {
    if (event.button === 2 && !pointers.current.has(event.pointerId)) return;
    const wasSingle = pointers.current.size === 1;
    const p = local(event);
    pointers.current.delete(event.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    const additive = event.shiftKey || event.ctrlKey || event.metaKey;
    const from = bandFrom.current;
    if (wasSingle && from && moved.current) {
      const world = toWorld(transform, size, p.x, p.y);
      // Shift + window takes the objects off the selection (AutoCAD).
      viewer.edit.pickBand({ x0: from.x, y0: from.y, x1: world.x, y1: world.y }, event.shiftKey);
    } else if (wasSingle && !moved.current) {
      viewer.click(p.x, p.y, additive);
    }
    bandFrom.current = null;
    if (pointers.current.size === 0) downAt.current = null;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLCanvasElement>) => {
    // Ctrl+1: AutoCAD's Properties palette.
    if ((event.ctrlKey || event.metaKey) && event.key === '1') {
      event.preventDefault();
      viewer.openProperties();
      return;
    }
    // CAD keys while editing (ADR-050): Esc, Enter, Ctrl+Z, Ctrl+Y, Delete and one-letter commands.
    // The key by its place, so M / L / C… work with the Arabic keyboard layout (item 27); the text
    // of a TEXT command is typed as it comes.
    const typed = viewer.edit.textEntry ? event.key : latinKey(event);
    if (viewer.edit.key(typed, event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      return;
    }
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
        viewer.edit.clearChosen();
        return;
      default:
        return;
    }
    event.preventDefault();
  };

  // CURSORSIZE 5: each arm is 2.5 % of the canvas (5 % across), never shorter than the pick box.
  const arm = Math.max(12, Math.round(0.025 * Math.max(size.width, size.height)));
  return (
    <div
      ref={containerRef}
      dir="ltr"
      className={`relative overflow-hidden border border-[#3b4048] bg-black ${
        fill ? 'min-h-0 flex-1' : 'h-[72vh] min-h-80 resize-y'
      }`}
    >
      {model.mapBehind && viewer.osm.toLonLat ? (
        <OsmBackdrop transform={transform} size={size} toLonLat={viewer.osm.toLonLat} />
      ) : null}
      <canvas
        ref={canvasRef}
        role="application"
        tabIndex={0}
        aria-label={t('design.viewer.canvasLabel')}
        aria-describedby="drawing-canvas-help"
        className="relative block size-full cursor-none touch-none outline-none focus:outline-none focus-visible:outline-none"
        style={{ width: '100%', height: '100%' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={() => {
          pendingHover.current = null;
          showHair(null);
        }}
        onKeyDown={onKeyDown}
        onContextMenu={(event) => {
          if (!viewer.edit.editing) return;
          event.preventDefault();
          if (event.shiftKey && viewer.edit.wantsPoint) {
            const rect = event.currentTarget.getBoundingClientRect();
            setMenu(null);
            setSnapMenu({ x: event.clientX - rect.left, y: event.clientY - rect.top });
            return;
          }
          if (viewer.edit.command !== null) return;
          const rect = event.currentTarget.getBoundingClientRect();
          const p = { x: event.clientX - rect.left, y: event.clientY - rect.top };
          viewer.pickForMenu(p.x, p.y);
          viewer.closePopover();
          setMenu(p);
        }}
      />
      {/* Shown and placed by showHair (CSS --hx / --hy), hidden until the pointer comes. */}
      <div
        ref={hairRef}
        aria-hidden="true"
        data-testid="crosshair"
        data-size={crosshair}
        className="pointer-events-none"
        style={HAIR_HIDDEN}
      >
        {crosshair === 'full' ? (
          <>
            <div className="absolute inset-y-0 w-px bg-white/70" style={{ left: 'var(--hx)' }} />
            <div className="absolute inset-x-0 h-px bg-white/70" style={{ top: 'var(--hy)' }} />
          </>
        ) : (
          <>
            <div
              className="absolute w-px bg-white/80"
              style={{ left: 'var(--hx)', top: `calc(var(--hy) - ${arm}px)`, height: arm * 2 }}
            />
            <div
              className="absolute h-px bg-white/80"
              style={{ top: 'var(--hy)', left: `calc(var(--hx) - ${arm}px)`, width: arm * 2 }}
            />
          </>
        )}
        <div
          className="absolute size-2.5 border border-white"
          style={{ left: 'calc(var(--hx) - 5px)', top: 'calc(var(--hy) - 5px)' }}
        />
      </div>
      <p id="drawing-canvas-help" className="sr-only">
        {t('design.viewer.keysHelp')}
      </p>
      <div
        data-testid="drawing-coords"
        className="pointer-events-none absolute left-1 top-1 rounded bg-[#1d2127]/90 px-2 py-0.5 font-mono text-xs text-[#d7dbe0]"
      >
        <span className="font-sans">{t('design.viewer.coords')}: </span>
        <Ltr>
          <span ref={coordsRef}>—</span>
        </Ltr>
      </div>
      {snapMenu ? (
        <SnapMenu
          viewer={viewer}
          x={snapMenu.x}
          y={snapMenu.y}
          onClose={() => {
            setSnapMenu(null);
            canvasRef.current?.focus({ preventScroll: true });
          }}
        />
      ) : null}
      {menu ? (
        <CanvasContextMenu
          viewer={viewer}
          x={menu.x}
          y={menu.y}
          onClose={() => {
            setMenu(null);
            canvasRef.current?.focus({ preventScroll: true });
          }}
        />
      ) : null}
      {children}
    </div>
  );
}
