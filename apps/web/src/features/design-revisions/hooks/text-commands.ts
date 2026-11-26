import {
  ACI_COLORS,
  acadNumber,
  type CommandId,
  type CommandOption,
  type Point,
} from '../model/cad-commands';
import { pointsCurveEdit, roundCoord, type CanvasEdit } from '../model/canvas-edit';
import type { PreviewTextFormat } from '../model/drawing-preview';
import { isTextEntity } from '../model/canvas-edit';
import type { Pt } from '../model/geometry';
import { nextCell, tableAt, tableInWindow, type TableShape, type TableSpec } from '../model/table';
import {
  autoNumber,
  changeCase,
  combineTexts,
  constantSize,
  DEFAULT_TEXT_OFFSET,
  encloseText,
  fitFactor,
  mostReadable,
  PLAIN_FORMAT,
  textLength,
  textState,
  turnBetween,
  type CountPlacement,
  type CountSort,
  type EncloseShape,
  type TextCase,
  type TextState,
} from '../model/text-tools';
import type { ExtraContext, ExtraRun } from './extra-commands';

/**
 * The Text panel of AutoCAD's Express Tools (ADR-055 part 7) and TABLE (owner 2026-11-26), on the
 * same command line as the others, with AutoCAD's prompts and defaults: TCASE, TORIENT, TEXTFIT,
 * TXT2MTXT, TCOUNT (Auto Number: texts and block values), TCIRCLE (Enclose in Object), TEXTMASK,
 * TEXTUNMASK; TABLE places the table of the Insert Table dialog and fills its cells. Contents are
 * `set_text` / `set_attribute`, turns `rotate_item`, frames `add_curve`; width factor, MText and
 * masks are `set_text_format` and tables `add_table` (screen only).
 */

export const TEXT_COMMANDS: ReadonlySet<CommandId> = new Set<CommandId>([
  'tcase',
  'torient',
  'textfit',
  'txt2mtxt',
  'tcount',
  'tcircle',
  'textmask',
  'textunmask',
  'table',
]);

/** Commands that start with «Select objects:» (noun-verb or verb-noun). */
const SELECTING_TEXT: ReadonlySet<CommandId> = new Set<CommandId>([
  'tcase',
  'torient',
  'txt2mtxt',
  'tcount',
  'tcircle',
  'textmask',
  'textunmask',
]);

export type TextStep =
  | 't_case'
  | 't_orient'
  | 't_fitPick'
  | 't_fitEnd'
  | 't_fitStart'
  | 't_mtCombine'
  | 't_cntSort'
  | 't_cntStart'
  | 't_cntPlace'
  | 't_cntFind'
  | 't_encOffset'
  | 't_encShape'
  | 't_encSize'
  | 't_maskType'
  | 't_maskColor'
  | 't_maskOffset'
  | 't_tblAt'
  | 't_tblCorner'
  | 't_tblCorner2'
  | 't_tblCell';

export type TextPromptKey =
  | 'tcaseMode'
  | 'torientAngle'
  | 'textfitPick'
  | 'textfitEnd'
  | 'textfitStart'
  | 'mtextSelect'
  | 'mtextCombine'
  | 'tcountSort'
  | 'tcountStart'
  | 'tcountPlace'
  | 'tcountFind'
  | 'tcircleOffset'
  | 'tcircleShape'
  | 'tcircleSize'
  | 'textmaskSelect'
  | 'textmaskType'
  | 'textmaskColor'
  | 'textmaskOffset'
  | 'textunmaskSelect'
  | 'tableAt'
  | 'tableCorner'
  | 'tableCorner2'
  | 'tableCell';

export const TEXT_OBJECT_STEPS: readonly string[] = ['t_fitPick'];
export const TEXT_TRACKED: readonly string[] = ['t_fitEnd', 't_tblCorner2'];
/** Steps where the command line takes free text (TCOUNT's string, a table cell). */
export const TEXT_TOOL_TEXT_STEPS: readonly string[] = ['t_cntFind', 't_tblCell'];

/** What the text commands keep between runs (AutoCAD keeps the last answers). */
export interface TextToolSettings {
  caseMode: TextCase;
  countSort: CountSort;
  countStart: number;
  countIncrement: number;
  countPlacement: CountPlacement;
  encloseOffset: number;
  encloseShape: EncloseShape;
  encloseConstant: boolean;
  maskOffset: number;
  /** null = Wipeout (the background); else a Solid of this colour. */
  maskColor: string | null;
  combine: boolean;
}

export const DEFAULT_TEXT_SETTINGS: TextToolSettings = {
  caseMode: 'U',
  countSort: 'Y',
  countStart: 1,
  countIncrement: 1,
  countPlacement: 'P',
  encloseOffset: DEFAULT_TEXT_OFFSET,
  encloseShape: 'C',
  encloseConstant: false,
  maskOffset: DEFAULT_TEXT_OFFSET,
  maskColor: null,
  combine: true,
};

/** Per run. */
export interface TextData {
  target?: number;
  start?: Point;
  spec?: TableSpec;
  table?: TableShape;
  cell?: { row: number; col: number };
  /** The layer the table goes on (the current layer when it was placed). */
  layer?: string;
  /** TCOUNT's answers of this run. */
  sort?: CountSort;
  first?: number;
  step?: number;
}

interface Prompt {
  key: TextPromptKey | 'selectObjects';
  options: CommandOption[];
  fallback: string | null;
}

const opt = (word: string, key: string): CommandOption => ({ word, key });
const pt = (p: Point): Pt => [p.x, p.y];
const textData = (r: ExtraRun): TextData => (r.flags.extra as TextData | undefined) ?? {};
const settingsOf = <R extends ExtraRun>(ctx: ExtraContext<R>) => ctx.settings.text;
const go = <R extends ExtraRun>(
  ctx: ExtraContext<R>,
  r: R,
  step: TextStep | 'select',
  patch: TextData = {},
): R => {
  const run = { ...r, step, flags: { ...r.flags, extra: { ...textData(r), ...patch } } };
  ctx.setRun(run);
  return run;
};

export const isTextCommand = (cmd: CommandId) => TEXT_COMMANDS.has(cmd);

const CASE_WORD: Record<TextCase, string> = {
  S: 'Sentence',
  L: 'lower',
  U: 'UPPER',
  T: 'Title',
  G: 'toGGLE',
};
const SORT_WORD: Record<CountSort, string> = { X: 'X', Y: 'Y', S: 'Select-order' };
const PLACE_WORD: Record<CountPlacement, string> = {
  O: 'Overwrite',
  P: 'Prefix',
  S: 'Suffix',
  F: 'Find&replace..',
};
const SHAPE_WORD: Record<EncloseShape, string> = { C: 'Circles', S: 'Slots', R: 'Rectangles' };

// ---------- prompts ----------

/** «Select objects:» of TXT2MTXT, TEXTMASK and TEXTUNMASK carries AutoCAD's own words. */
export function textSelectPrompt(r: ExtraRun): Prompt | null {
  if (r.step !== 'select') return null;
  const p = (key: Prompt['key'], options: CommandOption[] = []): Prompt => ({
    key,
    options,
    fallback: null,
  });
  if (r.cmd === 'txt2mtxt') return p('mtextSelect', [opt('Settings', 'SE')]);
  if (r.cmd === 'textmask') return p('textmaskSelect', [opt('Masktype', 'M'), opt('Offset', 'O')]);
  if (r.cmd === 'textunmask') return p('textunmaskSelect');
  return null;
}

export function textPrompt(r: ExtraRun, s: TextToolSettings): Prompt | null {
  const p = (
    key: Prompt['key'],
    options: CommandOption[] = [],
    fallback: string | null = null,
  ) => ({
    key,
    options,
    fallback,
  });
  const d = textData(r);
  switch (r.step as TextStep) {
    case 't_case':
      return p(
        'tcaseMode',
        (['S', 'L', 'U', 'T', 'G'] as const).map((k) => opt(CASE_WORD[k], k)),
        CASE_WORD[s.caseMode],
      );
    case 't_orient':
      return p('torientAngle', [], 'Most Readable');
    case 't_fitPick':
      return p('textfitPick');
    case 't_fitEnd':
      return p('textfitEnd', [opt('Start point', 'S')]);
    case 't_fitStart':
      return p('textfitStart');
    case 't_mtCombine':
      return p('mtextCombine', [opt('Yes', 'Y'), opt('No', 'N')], s.combine ? 'Yes' : 'No');
    case 't_cntSort':
      return p(
        'tcountSort',
        (['X', 'Y', 'S'] as const).map((k) => opt(SORT_WORD[k], k)),
        SORT_WORD[s.countSort],
      );
    case 't_cntStart':
      return p('tcountStart', [], `${s.countStart},${s.countIncrement}`);
    case 't_cntPlace':
      return p(
        'tcountPlace',
        (['O', 'P', 'S', 'F'] as const).map((k) => opt(PLACE_WORD[k], k)),
        PLACE_WORD[s.countPlacement],
      );
    case 't_cntFind':
      return p('tcountFind');
    case 't_encOffset':
      return p('tcircleOffset', [], acadNumber(s.encloseOffset));
    case 't_encShape':
      return p(
        'tcircleShape',
        (['C', 'S', 'R'] as const).map((k) => opt(SHAPE_WORD[k], k)),
        SHAPE_WORD[s.encloseShape],
      );
    case 't_encSize':
      return p(
        'tcircleSize',
        [opt('Variable', 'V'), opt('Constant', 'C')],
        s.encloseConstant ? 'Constant' : 'Variable',
      );
    case 't_maskType':
      return p(
        'textmaskType',
        [opt('Wipeout', 'W'), opt('Solid', 'S')],
        s.maskColor ? 'Solid' : 'Wipeout',
      );
    case 't_maskColor':
      return p('textmaskColor', [], '8');
    case 't_maskOffset':
      return p('textmaskOffset', [], acadNumber(s.maskOffset));
    case 't_tblAt':
      return p('tableAt');
    case 't_tblCorner':
      return p('tableCorner');
    case 't_tblCorner2':
      return p('tableCorner2');
    case 't_tblCell': {
      const cell = d.cell ?? { row: 0, col: 0 };
      return { key: 'tableCell', options: [], fallback: `${cell.row + 1},${cell.col + 1}` };
    }
  }
  return null;
}

// ---------- start ----------

export function textBegin<R extends ExtraRun>(
  ctx: ExtraContext<R>,
  cmd: CommandId,
  fresh: (step: string) => R,
): R | null {
  if (cmd === 'table') {
    // The Insert Table dialog comes first; its OK places the table (placeTable).
    ctx.openDialog?.({ kind: 'table' });
    ctx.finish();
    return null;
  }
  const s = settingsOf(ctx);
  if (cmd === 'textmask') {
    ctx.say(
      ctx.msg('textmaskSettings', {
        offset: s.maskOffset.toFixed(5),
        type: s.maskColor ? 'Solid' : 'Wipeout',
      }),
    );
  }
  if (cmd === 'textfit') {
    ctx.setSelection(new Set());
    const r = fresh('t_fitPick');
    ctx.setRun(r);
    return r;
  }
  const r = fresh('select');
  if (SELECTING_TEXT.has(cmd) && ctx.handles.length > 0) return textAfterSelect(ctx, r);
  ctx.setRun(r);
  return r;
}

/** The table of the Insert Table dialog is placed: the run asks where. */
export function tablePlace<R extends ExtraRun>(
  ctx: ExtraContext<R>,
  spec: TableSpec,
  fresh: (step: string) => R,
): R | null {
  if (!ctx.needDrawLayer()) return null;
  const r = fresh(spec.insertion === 'window' ? 't_tblCorner' : 't_tblAt');
  const run = {
    ...r,
    flags: { ...r.flags, extra: { spec, layer: ctx.drawLayer } satisfies TextData },
  };
  ctx.setRun(run);
  return run;
}

/** Texts (TEXT / MTEXT) among the picked objects, as drawn now. */
function pickedTexts<R extends ExtraRun>(ctx: ExtraContext<R>, blocks = false): TextState[] {
  const out: TextState[] = [];
  for (const index of ctx.selection) {
    const entity = ctx.scene.view.entities[index];
    const isBlock = blocks && entity?.kind === 'INSERT' && entity.texts.length > 0;
    if (!isTextEntity(ctx.scene, index) && !isBlock) continue;
    const state = textState(ctx.scene, ctx.shown, index);
    if (state) out.push(state);
  }
  return out;
}

export function textAfterSelect<R extends ExtraRun>(ctx: ExtraContext<R>, r: R): R | null {
  const blocks = r.cmd === 'tcount';
  const texts = pickedTexts(ctx, blocks);
  if (texts.length === 0) {
    ctx.say(ctx.msg('noTextPicked'));
    ctx.finish();
    return null;
  }
  ctx.say(ctx.msg('textsFound', { count: texts.length }));
  switch (r.cmd) {
    case 'tcase':
      return go(ctx, r, 't_case');
    case 'torient':
      return go(ctx, r, 't_orient');
    case 'tcount':
      return go(ctx, r, 't_cntSort');
    case 'tcircle':
      return go(ctx, r, 't_encOffset');
    case 'txt2mtxt':
      toMtext(ctx, texts);
      return null;
    case 'textmask':
      mask(ctx, texts, true);
      return null;
    case 'textunmask':
      mask(ctx, texts, false);
      return null;
  }
  ctx.finish();
  return null;
}

// ---------- entries ----------

/** An option of «Select objects:» (TXT2MTXT Settings, TEXTMASK Masktype / Offset). */
export function textSelectOption<R extends ExtraRun>(ctx: ExtraContext<R>, r: R, key: string) {
  if (r.cmd === 'txt2mtxt' && key === 'SE') go(ctx, r, 't_mtCombine');
  else if (r.cmd === 'textmask' && key === 'M') go(ctx, r, 't_maskType');
  else if (r.cmd === 'textmask' && key === 'O') go(ctx, r, 't_maskOffset');
}

export function textOption<R extends ExtraRun>(ctx: ExtraContext<R>, r: R, key: string): void {
  const s = settingsOf(ctx);
  const set = (patch: Partial<TextToolSettings>) => ctx.setSettings({ text: { ...s, ...patch } });
  switch (r.step as TextStep) {
    case 't_case':
      set({ caseMode: key as TextCase });
      changeCaseDone(ctx, key as TextCase);
      return;
    case 't_fitEnd':
      if (key === 'S') go(ctx, r, 't_fitStart');
      return;
    case 't_mtCombine':
      set({ combine: key === 'Y' });
      go(ctx, r, 'select');
      return;
    case 't_cntSort':
      set({ countSort: key as CountSort });
      go(ctx, r, 't_cntStart', { sort: key as CountSort });
      return;
    case 't_cntPlace':
      set({ countPlacement: key as CountPlacement });
      if (key === 'F') go(ctx, r, 't_cntFind');
      else countDone(ctx, r, key as CountPlacement, '');
      return;
    case 't_encShape':
      set({ encloseShape: key as EncloseShape });
      go(ctx, r, 't_encSize');
      return;
    case 't_encSize':
      set({ encloseConstant: key === 'C' });
      encloseDone(ctx, { ...s, encloseConstant: key === 'C' });
      return;
    case 't_maskType':
      if (key === 'S') go(ctx, r, 't_maskColor');
      else {
        set({ maskColor: null });
        go(ctx, r, 'select');
      }
      return;
  }
}

export function textNumber<R extends ExtraRun>(ctx: ExtraContext<R>, r: R, value: number): void {
  const s = settingsOf(ctx);
  const set = (patch: Partial<TextToolSettings>) => ctx.setSettings({ text: { ...s, ...patch } });
  switch (r.step as TextStep) {
    case 't_orient':
      orientDone(ctx, value);
      return;
    case 't_cntStart':
      if (!Number.isInteger(value)) {
        ctx.say(ctx.msg('wholeNumber'));
        return;
      }
      set({ countStart: value });
      go(ctx, r, 't_cntPlace', { first: value, step: s.countIncrement });
      return;
    case 't_encOffset':
      if (value < 0) {
        ctx.say(ctx.msg('badValue'));
        return;
      }
      set({ encloseOffset: value });
      go(ctx, r, 't_encShape');
      return;
    case 't_maskOffset':
      if (value < 0 || value > 5) {
        ctx.say(ctx.msg('maskOffsetRange'));
        return;
      }
      set({ maskOffset: value });
      go(ctx, r, 'select');
      return;
    case 't_maskColor': {
      const aci = ACI_COLORS.find((c) => c.aci === value);
      if (!aci) {
        ctx.say(ctx.msg('aciRange'));
        return;
      }
      set({ maskColor: aci.hex });
      go(ctx, r, 'select');
      return;
    }
    case 't_tblCell':
      textText(ctx, r, String(value));
      return;
  }
  ctx.say(ctx.msg('badPoint'));
}

export function textPoint<R extends ExtraRun>(ctx: ExtraContext<R>, r: R, p: Point): void {
  const s = settingsOf(ctx);
  const d = textData(r);
  switch (r.step as TextStep) {
    case 't_cntStart': {
      // «Start,increment»: 1,1 is read as a pair.
      if (!Number.isInteger(p.x) || !Number.isInteger(p.y)) {
        ctx.say(ctx.msg('wholeNumber'));
        return;
      }
      ctx.setSettings({ text: { ...s, countStart: p.x, countIncrement: p.y } });
      go(ctx, r, 't_cntPlace', { first: p.x, step: p.y });
      return;
    }
    case 't_fitStart':
      go(ctx, r, 't_fitEnd', { start: p });
      return;
    case 't_fitEnd':
      fitDone(ctx, d, p);
      return;
    case 't_tblAt':
      if (d.spec) startCells(ctx, r, tableAt(d.spec, pt(p)));
      return;
    case 't_tblCorner':
      go(ctx, r, 't_tblCorner2', { start: p });
      return;
    case 't_tblCorner2':
      if (d.spec && d.start) startCells(ctx, r, tableInWindow(d.spec, pt(d.start), pt(p)));
      return;
  }
  ctx.say(ctx.msg('badPoint'));
}

export function textObject<R extends ExtraRun>(
  ctx: ExtraContext<R>,
  r: R,
  index: number | null,
): void {
  if (r.step !== 't_fitPick') return;
  if (index === null || !isTextEntity(ctx.scene, index) || !ctx.pickable(index)) {
    ctx.say(ctx.msg('noTextPicked'));
    return;
  }
  const state = textState(ctx.scene, ctx.shown, index);
  if (!state) return;
  ctx.setSelection(new Set([index]));
  go(ctx, r, 't_fitEnd', { target: index, start: { x: state.x, y: state.y } });
}

export function textText<R extends ExtraRun>(ctx: ExtraContext<R>, r: R, value: string): void {
  const d = textData(r);
  if (r.step === 't_cntFind') {
    if (value === '') {
      ctx.say(ctx.msg('tcountNoFind'));
      return;
    }
    countDone(ctx, r, 'F', value);
    return;
  }
  if (r.step === 't_tblCell' && d.table && d.cell) {
    const cells = d.table.cells.map((row) => [...row]);
    const row = cells[d.cell.row];
    if (row) row[d.cell.col] = value.trim();
    const table = { ...d.table, cells };
    const next = nextCell(table, d.cell);
    if (next) go(ctx, r, 't_tblCell', { table, cell: next });
    else tableDone(ctx, { ...r, flags: { ...r.flags, extra: { ...d, table } } });
  }
}

export function textEnter<R extends ExtraRun>(ctx: ExtraContext<R>, r: R): void {
  const s = settingsOf(ctx);
  const d = textData(r);
  switch (r.step as TextStep) {
    case 't_case':
      changeCaseDone(ctx, s.caseMode);
      return;
    case 't_orient':
      orientDone(ctx, null);
      return;
    case 't_mtCombine':
      go(ctx, r, 'select');
      return;
    case 't_cntSort':
      go(ctx, r, 't_cntStart', { sort: s.countSort });
      return;
    case 't_cntStart':
      go(ctx, r, 't_cntPlace', { first: s.countStart, step: s.countIncrement });
      return;
    case 't_cntPlace':
      if (s.countPlacement === 'F') go(ctx, r, 't_cntFind');
      else countDone(ctx, r, s.countPlacement, '');
      return;
    case 't_encOffset':
      go(ctx, r, 't_encShape');
      return;
    case 't_encShape':
      go(ctx, r, 't_encSize');
      return;
    case 't_encSize':
      encloseDone(ctx, s);
      return;
    case 't_maskType':
      go(ctx, r, 'select');
      return;
    case 't_maskColor':
      textNumber(ctx, r, 8);
      return;
    case 't_maskOffset':
      go(ctx, r, 'select');
      return;
    case 't_fitEnd':
    case 't_fitPick':
      ctx.finish();
      return;
    case 't_tblCell':
      if (d.table && d.cell) {
        const next = nextCell(d.table, d.cell);
        if (next) go(ctx, r, 't_tblCell', { cell: next });
        else tableDone(ctx, r);
      }
      return;
  }
  ctx.finish();
}

/** Esc in the table's cells keeps the table, as AutoCAD's cell editor. */
export function textKeepOnCancel(r: ExtraRun): CanvasEdit[] {
  const d = textData(r);
  return r.cmd === 'table' && r.step === 't_tblCell' && d.table
    ? [tableEdit(d.layer ?? '', d.table)]
    : [];
}

/** What a running text command shows before it is kept (the table being filled). */
export function textPending(r: ExtraRun): CanvasEdit[] {
  return textKeepOnCancel(r);
}

export function textSketch(r: ExtraRun, at: Point): { points: Point[]; closed: boolean } | null {
  const d = textData(r);
  if (r.step === 't_fitEnd' && d.start) return { points: [d.start, at], closed: false };
  if (r.step === 't_tblCorner2' && d.start) {
    const s = d.start;
    return {
      points: [s, { x: at.x, y: s.y }, at, { x: s.x, y: at.y }],
      closed: true,
    };
  }
  return null;
}

// ---------- the work ----------

/** The format of a text with `patch` on top of what it has (set_text_format: latest wins). */
function formatEdit<R extends ExtraRun>(
  ctx: ExtraContext<R>,
  state: TextState,
  patch: Partial<PreviewTextFormat>,
): CanvasEdit {
  const current = ctx.shown.textFormatOf.get(state.index) ?? PLAIN_FORMAT;
  const next = { ...current, ...patch };
  return {
    kind: 'set_text_format',
    handle: state.handle,
    widthFactor: next.widthFactor,
    mtext: next.mtext,
    wrap: next.wrap === null ? null : roundCoord(next.wrap),
    mask: next.mask,
  };
}

function changeCaseDone<R extends ExtraRun>(ctx: ExtraContext<R>, mode: TextCase): void {
  const out: CanvasEdit[] = [];
  for (const state of pickedTexts(ctx)) {
    const text = changeCase(state.text, mode);
    if (text !== state.text && text.trim() !== '' && text.length <= 255) {
      out.push({ kind: 'set_text', handle: state.handle, text });
    }
  }
  if (out.length > 0) ctx.add(out);
  ctx.say(ctx.msg('textsChanged', { count: out.length }));
  ctx.finish();
}

/** TORIENT: every text to `angle` (null = Most Readable), each about its own point. */
function orientDone<R extends ExtraRun>(ctx: ExtraContext<R>, angle: number | null): void {
  const out: CanvasEdit[] = [];
  for (const state of pickedTexts(ctx)) {
    const to = angle === null ? mostReadable(state.rotation) : angle;
    const turn = roundCoord(turnBetween(state.rotation, to));
    if (Math.abs(turn) < 1e-9) continue;
    out.push({
      kind: 'rotate_item',
      handle: state.handle,
      x: roundCoord(state.x),
      y: roundCoord(state.y),
      angle: turn,
    });
  }
  if (out.length > 0) ctx.add(out);
  ctx.say(ctx.msg('textsChanged', { count: out.length }));
  ctx.finish();
}

function fitDone<R extends ExtraRun>(ctx: ExtraContext<R>, d: TextData, end: Point): void {
  const index = d.target;
  const state = index === undefined ? null : textState(ctx.scene, ctx.shown, index);
  const start = d.start;
  if (!state || !start) return ctx.finish();
  const factor = fitFactor(state, pt(start), pt(end));
  if (factor === null || factor < 0.01 || factor > 100) {
    ctx.say(ctx.msg('textfitBad'));
    return;
  }
  const out: CanvasEdit[] = [];
  const dx = start.x - state.x;
  const dy = start.y - state.y;
  if (Math.abs(dx) > 1e-9 || Math.abs(dy) > 1e-9) {
    out.push({ kind: 'move_item', handle: state.handle, dx: roundCoord(dx), dy: roundCoord(dy) });
  }
  out.push(formatEdit(ctx, state, { widthFactor: factor }));
  ctx.add(out);
  ctx.finish();
}

/** TXT2MTXT: with Combine, one MText of the texts (top to bottom); else each becomes MText. */
function toMtext<R extends ExtraRun>(ctx: ExtraContext<R>, texts: TextState[]): void {
  const s = settingsOf(ctx);
  const plain = texts.filter((t) => t.kind === 'TEXT' || !t.format.mtext);
  if (s.combine && plain.length > 1) {
    const combined = combineTexts(plain);
    if (!combined) {
      ctx.say(ctx.msg('mtextTooLong'));
      ctx.finish();
      return;
    }
    const out: CanvasEdit[] = [];
    if (combined.text !== combined.first.text) {
      out.push({ kind: 'set_text', handle: combined.first.handle, text: combined.text });
    }
    out.push(formatEdit(ctx, combined.first, { mtext: true, wrap: combined.wrap }));
    for (const rest of combined.rest) out.push({ kind: 'erase_item', handle: rest.handle });
    ctx.add(out);
    ctx.say(ctx.msg('mtextCombined', { count: plain.length }));
  } else {
    const out = plain
      .filter((t) => !t.format.mtext)
      .map((t) =>
        formatEdit(ctx, t, {
          mtext: true,
          wrap: textLength(t.text, t.height, t.format.widthFactor),
        }),
      );
    if (out.length > 0) ctx.add(out);
    ctx.say(ctx.msg('mtextConverted', { count: out.length }));
  }
  ctx.finish();
}

/** TCOUNT: the numbers placed; texts by `set_text`, block values by `set_attribute`. */
function countDone<R extends ExtraRun>(
  ctx: ExtraContext<R>,
  r: R,
  placement: CountPlacement,
  find: string,
): void {
  const s = settingsOf(ctx);
  const d = textData(r);
  const texts = pickedTexts(ctx, true);
  const numbered = autoNumber(
    texts,
    d.sort ?? s.countSort,
    d.first ?? s.countStart,
    d.step ?? s.countIncrement,
    placement,
    find,
  );
  const byIndex = new Map(texts.map((t) => [t.index, t]));
  const out: CanvasEdit[] = [];
  for (const item of numbered) {
    const state = byIndex.get(item.index);
    if (!state || item.text === state.text) continue;
    out.push(
      state.kind === 'INSERT'
        ? { kind: 'set_attribute', handle: state.handle, from: state.text, to: item.text }
        : { kind: 'set_text', handle: state.handle, text: item.text },
    );
  }
  if (out.length > 0) ctx.add(out);
  ctx.say(ctx.msg('textsChanged', { count: out.length }));
  ctx.finish();
}

/** TCIRCLE: a closed polyline around each text on the current layer. */
function encloseDone<R extends ExtraRun>(ctx: ExtraContext<R>, s: TextToolSettings): void {
  if (!ctx.needDrawLayer()) return;
  const texts = pickedTexts(ctx);
  const size = s.encloseConstant ? constantSize(texts) : null;
  const out = texts.map((state) =>
    pointsCurveEdit(ctx.drawLayer, encloseText(state, s.encloseOffset, s.encloseShape, size), true),
  );
  if (out.length > 0) ctx.add(out);
  ctx.say(ctx.msg('textsEnclosed', { count: out.length }));
  ctx.finish();
}

/** TEXTMASK / TEXTUNMASK. */
function mask<R extends ExtraRun>(ctx: ExtraContext<R>, texts: TextState[], on: boolean): void {
  const s = settingsOf(ctx);
  const out = texts
    .filter((t) => on || t.format.mask !== null)
    .map((t) =>
      formatEdit(ctx, t, {
        mask: on ? { offset: s.maskOffset, color: s.maskColor } : null,
      }),
    );
  if (out.length > 0) ctx.add(out);
  ctx.say(
    on
      ? ctx.msg('textsMasked', { count: out.length, type: s.maskColor ? 'Solid' : 'Wipeout' })
      : ctx.msg('textsUnmasked', { count: out.length }),
  );
  ctx.finish();
}

function startCells<R extends ExtraRun>(ctx: ExtraContext<R>, r: R, table: TableShape): void {
  go(ctx, r, 't_tblCell', { table, cell: { row: 0, col: 0 } });
}

function tableEdit(layer: string, table: TableShape): CanvasEdit {
  return {
    kind: 'add_table',
    layer,
    x: roundCoord(table.x),
    y: roundCoord(table.y),
    columns: table.columns.map(roundCoord),
    rows: table.rows.map(roundCoord),
    height: roundCoord(table.height),
    styles: table.styles,
    cells: table.cells,
  };
}

function tableDone<R extends ExtraRun>(ctx: ExtraContext<R>, r: R): void {
  const d = textData(r);
  if (d.table) ctx.add([tableEdit(d.layer ?? ctx.drawLayer, d.table)]);
  ctx.finish();
}
