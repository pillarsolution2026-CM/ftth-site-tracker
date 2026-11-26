import type { CommandId, CommandOption, Point } from '../model/cad-commands';
import type { ExtraContext, ExtraRun } from './extra-commands';
import {
  isViewCommand,
  VIEW_OBJECT_STEPS,
  VIEW_TRACKED,
  viewAfterSelect,
  viewBegin,
  viewEnter,
  viewNumber,
  viewOption,
  viewPoint,
  viewPrompt,
  viewSketch,
  viewWord,
  type ViewPromptKey,
  type ViewStep,
} from './view-commands';

/**
 * Round 3 (Phase 2C) commands on the one command line: ZOOM / PAN / REGEN / U / UNDO / REDO /
 * OOPS (view-commands). The added-commands dispatcher (extra-commands) hands them on from here,
 * one line per entry kind, so the modules stay apart.
 */

export type MoreStep = ViewStep;
export type MorePromptKey = ViewPromptKey;

export const MORE_OBJECT_STEPS: readonly string[] = [...VIEW_OBJECT_STEPS];
export const MORE_TRACKED: readonly string[] = [...VIEW_TRACKED];

export const isMoreCommand = (cmd: CommandId) => isViewCommand(cmd);

interface Prompt {
  key: MorePromptKey;
  options: CommandOption[];
  fallback: string | null;
}

export function morePrompt(r: ExtraRun): Prompt | null {
  if (isViewCommand(r.cmd)) return viewPrompt(r);
  return null;
}

export function moreBegin<R extends ExtraRun>(
  ctx: ExtraContext<R>,
  cmd: CommandId,
  fresh: (step: string) => R,
): R | null {
  if (isViewCommand(cmd)) return viewBegin(ctx, cmd, fresh);
  return null;
}

/** Starts a transparent command (`'ZOOM`) inside `outer`, which goes on after it. */
export function moreTransparent<R extends ExtraRun>(
  ctx: ExtraContext<R>,
  cmd: CommandId,
  fresh: (step: string) => R,
  outer: R,
): R | null {
  if (isViewCommand(cmd)) return viewBegin(ctx, cmd, fresh, outer);
  return null;
}

export function moreAfterSelect<R extends ExtraRun>(ctx: ExtraContext<R>, r: R): R | null {
  if (isViewCommand(r.cmd)) return viewAfterSelect(ctx);
  ctx.finish();
  return null;
}

export function morePoint<R extends ExtraRun>(ctx: ExtraContext<R>, r: R, p: Point): void {
  if (isViewCommand(r.cmd)) viewPoint(ctx, r, p);
}

export function moreNumber<R extends ExtraRun>(ctx: ExtraContext<R>, r: R, value: number): void {
  if (isViewCommand(r.cmd)) viewNumber(ctx, r, value);
}

export function moreOption<R extends ExtraRun>(ctx: ExtraContext<R>, r: R, key: string): void {
  if (isViewCommand(r.cmd)) viewOption(ctx, r, key);
}

export function moreEnter<R extends ExtraRun>(ctx: ExtraContext<R>, r: R): void {
  if (isViewCommand(r.cmd)) viewEnter(ctx, r);
  else ctx.finish();
}

export function moreObject<R extends ExtraRun>(
  ctx: ExtraContext<R>,
  r: R,
  index: number | null,
  at: Point,
): void {
  void at;
  void index;
  if (isViewCommand(r.cmd)) ctx.say(ctx.msg('badSelection'));
}

/** A typed word that is no option of the prompt (ZOOM's `2X`); true when it was taken. */
export function moreWord<R extends ExtraRun>(ctx: ExtraContext<R>, r: R, word: string): boolean {
  if (isViewCommand(r.cmd)) return viewWord(ctx, r, word);
  return false;
}

export function moreSketch(r: ExtraRun, at: Point): { points: Point[]; closed: boolean } | null {
  if (isViewCommand(r.cmd)) return viewSketch(r, at);
  return null;
}
