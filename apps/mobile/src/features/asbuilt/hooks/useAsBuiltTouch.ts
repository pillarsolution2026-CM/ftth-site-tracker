import { useMemo, useRef } from 'react';
import type { GestureResponderEvent } from 'react-native';
import { pan, toWorld, zoomAt, type Viewport } from '../../cad/model/viewport';
import { TAP_SLOP_PX, type Pointer } from '../model/editor-ui';
import type { AsBuiltEditor } from './useAsBuiltEditor';

interface Touch {
  pageX: number;
  pageY: number;
}
const spread = (a: Touch, b: Touch) => Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY);

/**
 * Touches on the As-Built canvas. A finger that lands on a symbol (move tool) or a grip (reshape
 * tool) drags it; otherwise one finger pans, two fingers pinch-zoom, and a short touch is a tap
 * for the active tool. Plain responder props (no PanResponder), so tests can drive them.
 */
export function useAsBuiltTouch(
  handlers: AsBuiltEditor['handlers'],
  viewport: Viewport | null,
  setViewport: (next: Viewport) => void,
  origin: { x: number; y: number },
) {
  const latest = useRef({ handlers, viewport, setViewport, origin });
  latest.current = { handlers, viewport, setViewport, origin };
  const touch = useRef<{
    grabbed: boolean;
    start: Touch | null;
    last: Touch | null;
    pinch: number | null;
    travel: number;
    multi: boolean;
  }>({ grabbed: false, start: null, last: null, pinch: null, travel: 0, multi: false });

  return useMemo(() => {
    const pointerAt = (point: Touch): Pointer | null => {
      const { viewport: vp, origin: o } = latest.current;
      if (!vp) return null;
      return {
        world: toWorld(vp, point.pageX - o.x, point.pageY - o.y),
        metresPerPixel: vp.metresPerPixel,
      };
    };
    return {
      onStartShouldSetResponder: () => true,
      onMoveShouldSetResponder: () => true,
      onResponderGrant: (event: GestureResponderEvent) => {
        const [first] = event.nativeEvent.touches;
        const pointer = first ? pointerAt(first) : null;
        touch.current = {
          grabbed: pointer ? latest.current.handlers.down(pointer) : false,
          start: first ?? null,
          last: first ?? null,
          pinch: null,
          travel: 0,
          multi: false,
        };
      },
      onResponderMove: (event: GestureResponderEvent) => {
        const { viewport: vp, origin: o, setViewport: emit } = latest.current;
        const [a, b] = event.nativeEvent.touches;
        const state = touch.current;
        if (a && b) {
          state.multi = true;
          if (vp && !state.grabbed) {
            const now = spread(a, b);
            if (state.pinch) {
              emit(
                zoomAt(
                  vp,
                  now / state.pinch,
                  (a.pageX + b.pageX) / 2 - o.x,
                  (a.pageY + b.pageY) / 2 - o.y,
                ),
              );
            }
            state.pinch = now;
          }
          state.last = null;
          return;
        }
        if (!a) return;
        state.pinch = null;
        if (state.start) {
          state.travel = Math.max(state.travel, spread(a, state.start));
        }
        if (state.grabbed) {
          const pointer = pointerAt(a);
          if (pointer) latest.current.handlers.move(pointer);
        } else if (vp && state.last) {
          emit(pan(vp, a.pageX - state.last.pageX, a.pageY - state.last.pageY));
        }
        state.last = a;
      },
      onResponderRelease: () => {
        const state = touch.current;
        if (state.grabbed) {
          latest.current.handlers.up();
        } else if (!state.multi && state.start && state.travel <= TAP_SLOP_PX) {
          const pointer = pointerAt(state.start);
          if (pointer) latest.current.handlers.tap(pointer);
        }
        touch.current = {
          grabbed: false,
          start: null,
          last: null,
          pinch: null,
          travel: 0,
          multi: false,
        };
      },
      onResponderTerminationRequest: () => false,
    };
  }, []);
}
