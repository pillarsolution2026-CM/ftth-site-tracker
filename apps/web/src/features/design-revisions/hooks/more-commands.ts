import type { CommandId, CommandOption, Point } from '../model/cad-commands';
import type { ExtraContext, ExtraRun, ExtraSettings } from './extra-commands';
import {
  INQUIRY_OBJECT_STEPS,
  INQUIRY_TRACKED,
  inquiryAfterSelect,
  inquiryBegin,
  inquiryEnter,
  inquiryNumber,
  inquiryObject,
  inquiryOption,
  inquiryPoint,
  inquiryPrompt,
  inquirySketch,
  inquiryTransparentLabel,
  isInquiryCommand,
  type InquiryPromptKey,
  type InquiryStep,
} from './inquiry-commands';
import {
  isModify2Command,
  MODIFY2_OBJECT_STEPS,
  modify2AfterSelect,
  modify2Begin,
  modify2Enter,
  modify2Object,
  modify2Option,
  modify2Point,
  modify2Prompt,
  type Modify2PromptKey,
  type Modify2Step,
} from './modify2-commands';
import {
  isModify3Command,
  modify3AfterSelect,
  modify3Begin,
  modify3Enter,
  modify3Number,
  modify3Object,
  modify3Option,
  modify3Point,
  modify3Prompt,
  MODIFY3_OBJECT_STEPS,
  type Modify3PromptKey,
  type Modify3Step,
} from './modify3-commands';
import {
  isViewCommand,
  transparentLabel as viewTransparentLabel,
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
 * OOPS (view-commands) and ID / DIST / AREA / LIST / MEASUREGEOM (inquiry-commands). The
 * added-commands dispatcher (extra-commands) hands them on from here, one line per entry kind, so
 * the modules stay apart.
 */

export type MoreStep = ViewStep | InquiryStep | Modify2Step | Modify3Step;
export type MorePromptKey = ViewPromptKey | InquiryPromptKey | Modify2PromptKey | Modify3PromptKey;

export const MORE_OBJECT_STEPS: readonly string[] = [
  ...VIEW_OBJECT_STEPS,
  ...INQUIRY_OBJECT_STEPS,
  ...MODIFY2_OBJECT_STEPS,
  ...MODIFY3_OBJECT_STEPS,
];
export const MORE_TRACKED: readonly string[] = [...VIEW_TRACKED, ...INQUIRY_TRACKED];

export const isMoreCommand = (cmd: CommandId) =>
  isViewCommand(cmd) || isInquiryCommand(cmd) || isModify2Command(cmd) || isModify3Command(cmd);

/** The «>>» shown before the prompt of a transparent command, null otherwise. */
export const transparentLabel = (r: ExtraRun | null): string | null =>
  viewTransparentLabel(r) ?? inquiryTransparentLabel(r);

interface Prompt {
  key: MorePromptKey;
  options: CommandOption[];
  fallback: string | null;
}

export function morePrompt(r: ExtraRun, settings?: ExtraSettings): Prompt | null {
  if (isViewCommand(r.cmd)) return viewPrompt(r);
  if (isInquiryCommand(r.cmd)) return inquiryPrompt(r);
  if (isModify2Command(r.cmd)) return modify2Prompt(r);
  if (isModify3Command(r.cmd)) return modify3Prompt(r, settings?.modify3);
  return null;
}

export function moreBegin<R extends ExtraRun>(
  ctx: ExtraContext<R>,
  cmd: CommandId,
  fresh: (step: string) => R,
): R | null {
  if (isViewCommand(cmd)) return viewBegin(ctx, cmd, fresh);
  if (isInquiryCommand(cmd)) return inquiryBegin(ctx, cmd, fresh);
  if (isModify2Command(cmd)) return modify2Begin(ctx, cmd, fresh);
  if (isModify3Command(cmd)) return modify3Begin(ctx, cmd, fresh);
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
  if (isInquiryCommand(cmd)) return inquiryBegin(ctx, cmd, fresh, outer);
  return null;
}

export function moreAfterSelect<R extends ExtraRun>(ctx: ExtraContext<R>, r: R): R | null {
  if (isViewCommand(r.cmd)) return viewAfterSelect(ctx);
  if (isInquiryCommand(r.cmd)) return inquiryAfterSelect(ctx, r);
  if (isModify2Command(r.cmd)) return modify2AfterSelect(ctx, r);
  if (isModify3Command(r.cmd)) return modify3AfterSelect(ctx, r);
  ctx.finish();
  return null;
}

export function morePoint<R extends ExtraRun>(ctx: ExtraContext<R>, r: R, p: Point): void {
  if (isViewCommand(r.cmd)) viewPoint(ctx, r, p);
  else if (isInquiryCommand(r.cmd)) inquiryPoint(ctx, r, p);
  else if (isModify2Command(r.cmd)) modify2Point(ctx, p);
  else if (isModify3Command(r.cmd)) modify3Point(ctx, r, p);
}

export function moreNumber<R extends ExtraRun>(ctx: ExtraContext<R>, r: R, value: number): void {
  if (isViewCommand(r.cmd)) viewNumber(ctx, r, value);
  else if (isInquiryCommand(r.cmd)) inquiryNumber(ctx, r, value);
  else if (isModify3Command(r.cmd)) modify3Number(ctx, r, value);
}

export function moreOption<R extends ExtraRun>(ctx: ExtraContext<R>, r: R, key: string): void {
  if (isViewCommand(r.cmd)) viewOption(ctx, r, key);
  else if (isInquiryCommand(r.cmd)) inquiryOption(ctx, r, key);
  else if (isModify2Command(r.cmd)) modify2Option(ctx, r, key);
  else if (isModify3Command(r.cmd)) modify3Option(ctx, r, key);
}

export function moreEnter<R extends ExtraRun>(ctx: ExtraContext<R>, r: R): void {
  if (isViewCommand(r.cmd)) viewEnter(ctx, r);
  else if (isInquiryCommand(r.cmd)) inquiryEnter(ctx, r);
  else if (isModify2Command(r.cmd)) modify2Enter(ctx, r);
  else if (isModify3Command(r.cmd)) modify3Enter(ctx, r);
  else ctx.finish();
}

export function moreObject<R extends ExtraRun>(
  ctx: ExtraContext<R>,
  r: R,
  index: number | null,
  at: Point,
): void {
  if (isInquiryCommand(r.cmd)) inquiryObject(ctx, r, index, at);
  else if (isModify2Command(r.cmd)) modify2Object(ctx, r, index);
  else if (isModify3Command(r.cmd)) modify3Object(ctx, r, index, at);
  else ctx.say(ctx.msg('badSelection'));
}

/** A typed word that is no option of the prompt (ZOOM's `2X`); true when it was taken. */
export function moreWord<R extends ExtraRun>(ctx: ExtraContext<R>, r: R, word: string): boolean {
  if (isViewCommand(r.cmd)) return viewWord(ctx, r, word);
  return false;
}

export function moreSketch(r: ExtraRun, at: Point): { points: Point[]; closed: boolean } | null {
  if (isViewCommand(r.cmd)) return viewSketch(r, at);
  if (isInquiryCommand(r.cmd)) return inquirySketch(r, at);
  return null;
}
