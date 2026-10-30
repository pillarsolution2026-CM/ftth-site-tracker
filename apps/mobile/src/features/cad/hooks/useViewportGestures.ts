import { useMemo, useRef } from 'react';
import { PanResponder, type GestureResponderEvent, type PanResponderInstance } from 'react-native';
import { pan, zoomAt, type Viewport } from '../model/viewport';

interface Touch {
  pageX: number;
  pageY: number;
}

const spread = (a: Touch, b: Touch) => Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY);

/**
 * One finger pans, two fingers pinch-zoom around their midpoint; no rotation (plan). Built on
 * React Native's PanResponder, so no extra native module is needed.
 */
export function useViewportGestures(
  viewport: Viewport | null,
  onChange: (next: Viewport) => void,
  origin: { x: number; y: number },
): PanResponderInstance {
  const state = useRef<{ last: Touch | null; pinch: number | null }>({ last: null, pinch: null });
  const latest = useRef({ viewport, onChange, origin });
  latest.current = { viewport, onChange, origin };

  return useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (event: GestureResponderEvent) => {
          const [touch] = event.nativeEvent.touches;
          state.current = { last: touch ?? null, pinch: null };
        },
        onPanResponderMove: (event: GestureResponderEvent) => {
          const { viewport: vp, onChange: emit, origin: o } = latest.current;
          if (!vp) return;
          const touches = event.nativeEvent.touches;
          const [a, b] = touches;
          if (a && b) {
            const distanceNow = spread(a, b);
            if (state.current.pinch) {
              const midX = (a.pageX + b.pageX) / 2 - o.x;
              const midY = (a.pageY + b.pageY) / 2 - o.y;
              emit(zoomAt(vp, distanceNow / state.current.pinch, midX, midY));
            }
            state.current = { last: null, pinch: distanceNow };
            return;
          }
          if (a) {
            const last = state.current.last;
            if (last) emit(pan(vp, a.pageX - last.pageX, a.pageY - last.pageY));
            state.current = { last: a, pinch: null };
          }
        },
        onPanResponderRelease: () => {
          state.current = { last: null, pinch: null };
        },
      }),
    [],
  );
}
