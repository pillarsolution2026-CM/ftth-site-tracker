import { MAX_TEXT_LENGTH } from '@ftth/shared';
import { angleOf, applyAffine, scaleOf } from './affine';
import type { DrawingPreview, PreviewTextFormat } from './drawing-preview';
import type { DrawingScene } from './drawing-scene';
import { arcPoints, circlePoints, type Pt } from './geometry';

/**
 * AutoCAD Express Tools' Text panel (ADR-055 part 7), pure: TCASE, TORIENT, TEXTFIT, TXT2MTXT,
 * TCOUNT (Auto Number), TCIRCLE (Enclose in Object) and TEXTMASK. The screen only knows a text's
 * point, height, rotation and content, so a text's length is estimated from its characters.
 */

/** Advance of one character × height (an estimate of a sans-serif font; TEXTFIT works on it). */
export const CHAR_ADVANCE = 0.6;
/** AutoCAD's default offset factor of TCIRCLE and TEXTMASK. */
export const DEFAULT_TEXT_OFFSET = 0.35;
/** The format of a text with none (set_text_format all off). */
export const PLAIN_FORMAT: PreviewTextFormat = {
  widthFactor: null,
  mtext: false,
  wrap: null,
  mask: null,
};

/** A text as drawn now: insertion point, height, rotation (degrees), content, width factor. */
export interface TextState {
  index: number;
  handle: string;
  /** TEXT, MTEXT (the file's), or INSERT for a block's first value (TCOUNT). */
  kind: string;
  x: number;
  y: number;
  height: number;
  rotation: number;
  text: string;
  format: PreviewTextFormat;
}

/** The first text of an entity as the screen draws it, or null when it has none. */
export function textState(
  scene: DrawingScene,
  preview: DrawingPreview,
  index: number,
): TextState | null {
  const entity = scene.view.entities[index];
  const first = entity?.texts[0];
  if (!entity || !first || preview.erased.has(index)) return null;
  const turned = preview.transformOf.get(index);
  const at = turned ? applyAffine(turned, first.x, first.y) : { x: first.x, y: first.y };
  const text =
    entity.kind === 'INSERT'
      ? (preview.attrOf.get(index)?.get(first.text) ?? first.text)
      : (preview.textOf.get(index) ?? first.text);
  return {
    index,
    handle: entity.handle,
    kind: entity.kind,
    x: at.x,
    y: at.y,
    height: first.height * (turned ? scaleOf(turned) : 1),
    rotation: first.rotation + (turned ? angleOf(turned) : 0),
    text,
    format: preview.textFormatOf.get(index) ?? PLAIN_FORMAT,
  };
}

/** The drawn length of a text along its direction (estimated; × its width factor). */
export function textLength(text: string, height: number, widthFactor: number | null): number {
  return Math.max(height * 0.5, text.length * height * CHAR_ADVANCE) * (widthFactor ?? 1);
}

/** The four corners of a text's box (base line from the insertion point), counter-clockwise. */
export function textBox(state: TextState, offset = 0): Pt[] {
  const length = textLength(state.text, state.height, state.format.widthFactor);
  const a = (state.rotation * Math.PI) / 180;
  const u: Pt = [Math.cos(a), Math.sin(a)];
  const v: Pt = [-u[1], u[0]];
  const corner = (along: number, up: number): Pt => [
    state.x + u[0] * along + v[0] * up,
    state.y + u[1] * along + v[1] * up,
  ];
  return [
    corner(-offset, -offset),
    corner(length + offset, -offset),
    corner(length + offset, state.height + offset),
    corner(-offset, state.height + offset),
  ];
}

// ---------- TCASE ----------

export type TextCase = 'S' | 'L' | 'U' | 'T' | 'G';

/** AutoCAD's TCASE: Sentence, lower, UPPER, Title, toGgle. */
export function changeCase(text: string, mode: TextCase): string {
  switch (mode) {
    case 'L':
      return text.toLowerCase();
    case 'U':
      return text.toUpperCase();
    case 'G':
      return [...text]
        .map((c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase()))
        .join('');
    case 'T':
      return text.toLowerCase().replace(/(^|\s)(\S)/g, (_, space: string, c: string) => {
        return space + c.toUpperCase();
      });
    case 'S':
      return text
        .toLowerCase()
        .replace(/(^\s*|[.!?]\s+)(\S)/g, (_, lead: string, c: string) => lead + c.toUpperCase());
  }
}

// ---------- TORIENT ----------

/** An angle in [0, 360). */
export const normalAngle = (degrees: number) => ((degrees % 360) + 360) % 360;

/**
 * TORIENT's «Most Readable»: a text that would read upside down (between 90° and 270°) turns by
 * 180°; the others keep their angle. Returns the new rotation.
 */
export function mostReadable(rotation: number): number {
  const a = normalAngle(rotation);
  return a > 90 + 1e-9 && a <= 270 + 1e-9 ? normalAngle(a + 180) : a;
}

/** The turn (degrees, ±180) that brings `from` to `to`. */
export function turnBetween(from: number, to: number): number {
  const d = normalAngle(to - from);
  return d > 180 ? d - 360 : d;
}

// ---------- TEXTFIT ----------

/**
 * TEXTFIT: the width factor that makes the text reach `end` from its start along its direction
 * (null when the end point is behind the start or on it).
 */
export function fitFactor(state: TextState, start: Pt, end: Pt): number | null {
  const a = (state.rotation * Math.PI) / 180;
  const along = (end[0] - start[0]) * Math.cos(a) + (end[1] - start[1]) * Math.sin(a);
  const natural = textLength(state.text, state.height, null);
  if (!(along > 0) || !(natural > 0)) return null;
  return Math.round((along / natural) * 1e6) / 1e6;
}

// ---------- TCOUNT ----------

export type CountSort = 'X' | 'Y' | 'S';
export type CountPlacement = 'O' | 'P' | 'S' | 'F';

export interface Numbered {
  index: number;
  text: string;
}

/**
 * AutoCAD's TCOUNT: sorts the texts (X: left to right; Y: top to bottom; Select-order: as
 * picked), numbers them from `start` by `increment`, and places each number: Overwrite (the number
 * alone), Prefix («n text»), Suffix («text n») or Find&replace (each `find` in the text becomes the
 * number; a text without it is left and takes no number). Texts that would pass 255 characters
 * are left too.
 */
export function autoNumber(
  items: readonly Pick<TextState, 'index' | 'x' | 'y' | 'text'>[],
  sort: CountSort,
  start: number,
  increment: number,
  placement: CountPlacement,
  find = '',
): Numbered[] {
  const order = [...items];
  if (sort === 'X') order.sort((a, b) => a.x - b.x || b.y - a.y);
  else if (sort === 'Y') order.sort((a, b) => b.y - a.y || a.x - b.x);
  const out: Numbered[] = [];
  let n = start;
  for (const item of order) {
    const number = String(n);
    let text: string;
    if (placement === 'O') text = number;
    else if (placement === 'P') text = `${number} ${item.text}`;
    else if (placement === 'S') text = `${item.text} ${number}`;
    else {
      if (find === '' || !item.text.includes(find)) continue;
      text = item.text.split(find).join(number);
    }
    if (text.trim() === '' || text.length > MAX_TEXT_LENGTH) continue;
    out.push({ index: item.index, text });
    n += increment;
  }
  return out;
}

// ---------- TCIRCLE ----------

export type EncloseShape = 'C' | 'S' | 'R';

/** Points of TCIRCLE's circle, slot or rectangle around a text (closed polyline). */
export function encloseText(
  state: TextState,
  factor: number,
  shape: EncloseShape,
  size: { length: number; height: number } | null = null,
): Pt[] {
  const offset = factor * state.height;
  const length = size?.length ?? textLength(state.text, state.height, state.format.widthFactor);
  const height = size?.height ?? state.height;
  const a = (state.rotation * Math.PI) / 180;
  const u: Pt = [Math.cos(a), Math.sin(a)];
  const v: Pt = [-u[1], u[0]];
  const natural = textLength(state.text, state.height, state.format.widthFactor);
  // The centre of the text's own box: a constant size is centred on it.
  const centre: Pt = [
    state.x + (u[0] * natural) / 2 + (v[0] * state.height) / 2,
    state.y + (u[1] * natural) / 2 + (v[1] * state.height) / 2,
  ];
  const at = (along: number, up: number): Pt => [
    centre[0] + u[0] * along + v[0] * up,
    centre[1] + u[1] * along + v[1] * up,
  ];
  const halfL = length / 2 + offset;
  const halfH = height / 2 + offset;
  if (shape === 'C') return circlePoints(centre, Math.hypot(length / 2, height / 2) + offset);
  if (shape === 'R')
    return [at(-halfL, -halfH), at(halfL, -halfH), at(halfL, halfH), at(-halfL, halfH)];
  // A slot: two half circles of radius halfH joined by straight sides.
  const straight = Math.max(0, halfL - halfH);
  const rightEnd = at(straight, 0);
  const leftEnd = at(-straight, 0);
  return [
    ...arcPoints(rightEnd, halfH, a - Math.PI / 2, Math.PI),
    ...arcPoints(leftEnd, halfH, a + Math.PI / 2, Math.PI),
  ];
}

/** TCIRCLE «Constant»: the size of the largest text, for all. */
export function constantSize(states: readonly TextState[]): { length: number; height: number } {
  let length = 0;
  let height = 0;
  for (const s of states) {
    length = Math.max(length, textLength(s.text, s.height, s.format.widthFactor));
    height = Math.max(height, s.height);
  }
  return { length, height };
}

// ---------- TXT2MTXT ----------

/**
 * TXT2MTXT with «Combine text»: the texts top to bottom (then left to right) joined into one, and
 * the width it wraps at (the widest of them, so the lines come back about as they were). Null when
 * the result passes 255 characters.
 */
export function combineTexts(
  states: readonly TextState[],
): { first: TextState; text: string; wrap: number; rest: TextState[] } | null {
  const order = [...states].sort((a, b) => b.y - a.y || a.x - b.x);
  const [first, ...rest] = order;
  if (!first) return null;
  const text = order.map((s) => s.text.trim()).join(' ');
  if (text.length > MAX_TEXT_LENGTH) return null;
  const wrap = Math.max(...order.map((s) => textLength(s.text, s.height, s.format.widthFactor)));
  return { first, text, wrap, rest };
}

/** The lines of a wrapped MText (words kept whole), for drawing. */
export function wrapLines(text: string, height: number, widthFactor: number | null, wrap: number) {
  const words = text.split(/\s+/).filter((w) => w !== '');
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const next = line === '' ? word : `${line} ${word}`;
    if (line !== '' && textLength(next, height, widthFactor) > wrap * (1 + 1e-9)) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line !== '') lines.push(line);
  return lines;
}
