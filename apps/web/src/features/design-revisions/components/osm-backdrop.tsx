'use client';

import { useEffect, useRef, useState } from 'react';
import type { LonLat } from '@ftth/geo';
import { useI18n } from '@/shared/i18n/locale-provider';
import { screenToMercator, tilesFor } from '../model/osm-backdrop';
import type { Size, ViewTransform } from '../model/view-transform';

/**
 * OpenStreetMap under the drawing, in place of the black background (owner 2026-11-24). It is
 * mounted only when the user turns it on, so no tile loads before that. The map is dimmed so
 * the drawing's light lines stay readable, as on AutoCAD's dark model space.
 */
export function OsmBackdrop({
  transform,
  size,
  toLonLat,
}: {
  transform: ViewTransform;
  size: Size;
  toLonLat: (x: number, y: number) => LonLat;
}) {
  const { t } = useI18n();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const images = useRef(new Map<string, HTMLImageElement>());
  const [loaded, setLoaded] = useState(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || size.width === 0 || size.height === 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const frame = requestAnimationFrame(() => {
      const pixelW = Math.round(size.width * dpr);
      const pixelH = Math.round(size.height * dpr);
      if (canvas.width !== pixelW) canvas.width = pixelW;
      if (canvas.height !== pixelH) canvas.height = pixelH;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, pixelW, pixelH);
      const toMercator = screenToMercator(transform, size, toLonLat);
      if (!toMercator) return;
      for (const tile of tilesFor(toMercator, size, dpr)) {
        let image = images.current.get(tile.url);
        if (!image) {
          image = new Image();
          image.crossOrigin = 'anonymous';
          image.onload = () => setLoaded((n) => n + 1);
          image.src = tile.url;
          images.current.set(tile.url, image);
        }
        if (!image.complete || image.naturalWidth === 0) continue;
        const [a, b, c, d, e, f] = tile.transform;
        ctx.setTransform(a * dpr, b * dpr, c * dpr, d * dpr, e * dpr, f * dpr);
        // A quarter pixel of overlap hides the seams between tiles.
        ctx.drawImage(image, 0, 0, 256, 256, -0.25, -0.25, 256.5, 256.5);
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [transform, size, toLonLat, loaded]);

  // Keep the cache small: forget the images of far zooms when it grows.
  useEffect(() => {
    const cache = images.current;
    if (cache.size > 400) cache.clear();
  }, [loaded]);

  return (
    <>
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        data-testid="osm-backdrop"
        className="pointer-events-none absolute inset-0 size-full opacity-60"
        style={{ width: '100%', height: '100%' }}
      />
      <a
        href="https://www.openstreetmap.org/copyright"
        target="_blank"
        rel="noreferrer"
        className="absolute bottom-1 right-1 z-10 rounded bg-[#1d2127]/90 px-1.5 py-0.5 text-[10px] text-[#d7dbe0] underline-offset-2 hover:underline"
      >
        {t('design.cad.osmAttribution')}
      </a>
    </>
  );
}
