import type { BoxShapePreview } from '@ftth/shared';
import { previewPoints } from '../model/box-types-model';

/**
 * The picture of a box shape (ADR-043): the worker's normalized paths and texts drawn as SVG
 * elements — never injected as markup. The picture is a drawing, so it stays LTR in an RTL page.
 */
export function ShapePreview({
  preview,
  label,
  className = 'h-24 w-24',
}: {
  preview: BoxShapePreview | null;
  /** Accessible name of the picture. */
  label: string;
  className?: string;
}) {
  if (preview === null) {
    return (
      <div
        role="img"
        aria-label={label}
        className={`${className} flex shrink-0 items-center justify-center rounded border border-dashed border-(--color-border) text-2xl`}
      >
        <span aria-hidden="true">▢</span>
      </div>
    );
  }
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox="-0.6 -0.6 1.2 1.2"
      className={`${className} shrink-0 rounded border border-(--color-border) bg-white`}
    >
      {preview.paths.map((path, index) => (
        <polyline
          key={index}
          points={previewPoints(path)}
          fill="none"
          stroke="#000000"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      ))}
      {preview.texts.map((text, index) => (
        <text
          key={index}
          x={text.x}
          y={-text.y}
          fontSize={Math.max(text.height, 0.05)}
          textAnchor="middle"
          dominantBaseline="middle"
          fill="#000000"
          transform={`rotate(${-text.rotation} ${text.x} ${-text.y})`}
        >
          {text.text}
        </text>
      ))}
    </svg>
  );
}
