import { z } from 'zod';
import type { FeatureType } from '../design/feature-types.js';
import type { DrawingKind } from './drawing-kind.schemas.js';

/**
 * Text roles (ADR-041, reading ADR-040 B/C). Layer names change from drawing to drawing, so the
 * PM gives each text layer its MEANING on the mapping screen: a layer rule carries `textRoles`
 * and every readable text on that layer is read with the patterns of those roles. Mirrored by
 * `workers/cad/cad_worker/domain/text_roles.py` — change both together.
 *
 * Al-Fath examples (names only; never fixed): Secondary TXTNMPER «9» = box_number, TXTCAP «1-3»
 * = box_cabinet, txtbox «F4C» = box_cable_type, TXTLINTH «398M» = box_cable_length, txt ftth
 * «1way 7/3.5» + «10.0M» = bundle_label, «SP3(7/3.5)» = bundle_spare, CABINA «1-7» «22U» «22B»
 * «2P» = cabinet_info. General EXCH «500M/4way 16/12» = bundle_label, «520M/144Core F.O» =
 * cable_label, «SP 48» = cable_spare; «04A» = handhole_number, «HH1» / «DH» = handhole_type.
 *
 * Order matters: a text on a layer with several roles is read by the FIRST role of this list
 * (among the layer's roles) whose pattern matches.
 */
export const TEXT_ROLES = [
  'cable_spare',
  'bundle_spare',
  'cable_label',
  'bundle_label',
  'box_cable_type',
  'box_cable_length',
  'box_cabinet',
  'box_number',
  'handhole_type',
  'handhole_number',
  'cabinet_info',
] as const;
export const TextRoleSchema = z.enum(TEXT_ROLES);
export type TextRole = z.infer<typeof TextRoleSchema>;

/** The feature type a role's texts are linked to (nearest one, within the text-link radius). */
export const TEXT_ROLE_FEATURE: Readonly<Record<TextRole, FeatureType>> = {
  cable_spare: 'route',
  bundle_spare: 'route',
  cable_label: 'route',
  bundle_label: 'route',
  box_cable_type: 'box',
  box_cable_length: 'box',
  box_cabinet: 'box',
  box_number: 'box',
  handhole_type: 'hhi',
  handhole_number: 'hhi',
  cabinet_info: 'cabinet',
};

/** Roles each drawing kind reads (ADR-040). A role outside its kind is refused by the API. */
export const TEXT_ROLES_BY_KIND: Readonly<Record<DrawingKind, readonly TextRole[]>> = {
  general: [
    'cable_spare',
    'cable_label',
    'bundle_label',
    'handhole_type',
    'handhole_number',
    'cabinet_info',
  ],
  secondary: [
    'bundle_spare',
    'bundle_label',
    'box_cable_type',
    'box_cable_length',
    'box_cabinet',
    'box_number',
    'cabinet_info',
  ],
};

/**
 * A layer rule may carry text roles when its target is `label` or the roles' feature type (texts
 * written on the symbol layer itself, e.g. CABINA = cabinet circles + their texts).
 */
export function textRoleFitsTarget(role: TextRole, target: string): boolean {
  return target === 'label' || TEXT_ROLE_FEATURE[role] === target;
}

// ---------- handhole types (owner list, ADR-040) ----------

/** DH (70×70×70 cm inside), HH-I, HH-II (CH), MH-I … MH-IV. */
export const HANDHOLE_TYPES = ['DH', 'HH-I', 'HH-II', 'MH-I', 'MH-II', 'MH-III', 'MH-IV'] as const;
export const HandholeTypeSchema = z.enum(HANDHOLE_TYPES);
export type HandholeType = z.infer<typeof HandholeTypeSchema>;

/**
 * Written forms → type. Keys are upper-case with spaces and hyphens removed. Besides the canonical
 * names only the owner's own examples are accepted: «HH1» = HH-I, «CH» = HH-II. Other spellings
 * (HH2, MH1 …) are an open question (ADR-041) and read as an unknown type.
 */
const HANDHOLE_TYPE_ALIASES: Readonly<Record<string, HandholeType>> = {
  DH: 'DH',
  HHI: 'HH-I',
  HH1: 'HH-I',
  HHII: 'HH-II',
  CH: 'HH-II',
  MHI: 'MH-I',
  MHII: 'MH-II',
  MHIII: 'MH-III',
  MHIV: 'MH-IV',
};

export function handholeTypeOf(written: string): HandholeType | null {
  const key = written
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '');
  return HANDHOLE_TYPE_ALIASES[key] ?? null;
}

// ---------- reading one text ----------

/** A written length, normalised to metres with 3 decimals ("10.0M" → "10.000"). */
export type WrittenLength = string;

export type RoleReading =
  | { role: 'cable_spare'; cores: number }
  | { role: 'bundle_spare'; count: number; ductSize: string }
  | { role: 'cable_label'; cores: number; lengthM: WrittenLength | null }
  | {
      role: 'bundle_label';
      ways: number | null;
      ductSize: string | null;
      lengthM: WrittenLength | null;
    }
  | { role: 'box_cable_type'; cores: number }
  | { role: 'box_cable_length'; lengthM: WrittenLength }
  | { role: 'box_cabinet'; cabinet: string }
  | { role: 'box_number'; number: string }
  /** `type` null: the text looks like a type but is not in the list (HANDHOLE_TYPE_UNKNOWN). */
  | { role: 'handhole_type'; type: HandholeType | null; written: string }
  | { role: 'handhole_number'; number: string }
  | { role: 'cabinet_info'; field: CabinetInfoField; value: string };

/** Cabinet circle texts (ADR-040): name «1-7», type «22U», boxes «22B», «2P» (information). */
export const CABINET_INFO_FIELDS = ['name', 'type', 'box_count', 'ports'] as const;
export type CabinetInfoField = (typeof CABINET_INFO_FIELDS)[number];

// JavaScript `\d` is ASCII-only; Python must spell it `[0-9]` and use `fullmatch`.
const NUM = String.raw`\d+(?:\.\d+)?`;
const LEN = String.raw`(${NUM})\s*M`;
const DUCT = String.raw`(${NUM})\s*\/\s*(${NUM})`;
const re = (source: string) => new RegExp(`^${source}$`, 'i');

const P = {
  cableSpare: re(String.raw`SP\s*(\d+)`),
  bundleSpare: re(String.raw`SP\s*(\d+)\s*\(\s*${DUCT}\s*\)`),
  cable: re(String.raw`(?:${LEN}\s*\/\s*)?(\d+)\s*(?:-\s*)?Cores?\b.*`),
  /** «4way 16/12», «500M/4way 16/12», «450m/1x4 way 16/12» (one bundle of 4 ways). */
  bundle: re(String.raw`(?:${LEN}\s*\/\s*)?(?:\d+\s*x\s*)?(\d+)\s*(?:-\s*)?ways?(?:\s+${DUCT})?`),
  lengthOnly: re(LEN),
  boxCableType: re(String.raw`F\s*(\d+)\s*C`),
  cabinetName: re(String.raw`(\d+)\s*-\s*(\d+)`),
  boxNumber: re(String.raw`(\d{1,4})`),
  /** Letters with at most one digit or a Roman numeral: «HH1», «MH-IV», «XX». Not «CH01». */
  handholeTypeLike: re(String.raw`[A-Z]{1,3}(?:[\s-]?(?:[IVX]{1,4}|\d))?`),
  /** «04A», «CH01», «12». */
  handholeNumber: re(String.raw`[A-Z]{0,3}[\s-]?\d{1,4}[A-Z]?`),
  cabinetType: re(String.raw`(\d+)\s*U`),
  cabinetBoxes: re(String.raw`(\d+)\s*B`),
  cabinetPorts: re(String.raw`(\d+)\s*P`),
} as const;

/** "10.0" → "10.000"; more than 3 decimals rounds half up (strings only, never floats). */
export function writtenMetres3(written: string): WrittenLength {
  const [intPart = '0', frac = ''] = written.split('.');
  if (frac.length <= 3) return `${BigInt(intPart).toString()}.${frac.padEnd(3, '0')}`;
  const scaled = BigInt(intPart + frac.slice(0, 3)) + (Number(frac[3]) >= 5 ? 1n : 0n);
  const digits = scaled.toString().padStart(4, '0');
  return `${digits.slice(0, -3)}.${digits.slice(-3)}`;
}

/** "7 / 3.5" → "7/3.5". */
const duct = (outer: string, inner: string) => `${outer}/${inner}`;
const cabinetName = (a: string, b: string) => `${Number(a)}-${Number(b)}`;

/** Capture group `i` of a match, '' when it did not take part. */
type Groups = (i: number) => string;
const match = (pattern: RegExp, value: string): Groups | null => {
  const m = pattern.exec(value);
  return m ? (i) => m[i] ?? '' : null;
};

function readAs(role: TextRole, value: string): RoleReading | null {
  let g: Groups | null;
  switch (role) {
    case 'cable_spare':
      g = match(P.cableSpare, value);
      return g ? { role, cores: Number(g(1)) } : null;
    case 'bundle_spare':
      g = match(P.bundleSpare, value);
      return g ? { role, count: Number(g(1)), ductSize: duct(g(2), g(3)) } : null;
    case 'cable_label':
      g = match(P.cable, value);
      if (!g) return null;
      return { role, cores: Number(g(2)), lengthM: g(1) ? writtenMetres3(g(1)) : null };
    case 'bundle_label':
      g = match(P.bundle, value);
      if (g) {
        return {
          role,
          ways: Number(g(2)),
          ductSize: g(3) && g(4) ? duct(g(3), g(4)) : null,
          lengthM: g(1) ? writtenMetres3(g(1)) : null,
        };
      }
      // Secondary: the length is a text of its own next to the type («10.0M»).
      g = match(P.lengthOnly, value);
      return g ? { role, ways: null, ductSize: null, lengthM: writtenMetres3(g(1)) } : null;
    case 'box_cable_type':
      g = match(P.boxCableType, value);
      return g ? { role, cores: Number(g(1)) } : null;
    case 'box_cable_length':
      g = match(P.lengthOnly, value);
      return g ? { role, lengthM: writtenMetres3(g(1)) } : null;
    case 'box_cabinet':
      g = match(P.cabinetName, value);
      return g ? { role, cabinet: cabinetName(g(1), g(2)) } : null;
    case 'box_number':
      g = match(P.boxNumber, value);
      return g ? { role, number: g(1) } : null;
    case 'handhole_type': {
      const type = handholeTypeOf(value);
      if (type) return { role, type, written: value };
      return P.handholeTypeLike.test(value) ? { role, type: null, written: value } : null;
    }
    case 'handhole_number':
      return P.handholeNumber.test(value)
        ? { role, number: value.toUpperCase().replace(/\s+/g, '') }
        : null;
    case 'cabinet_info':
      if ((g = match(P.cabinetName, value))) {
        return { role, field: 'name', value: cabinetName(g(1), g(2)) };
      }
      if ((g = match(P.cabinetType, value))) return { role, field: 'type', value: `${g(1)}U` };
      if ((g = match(P.cabinetBoxes, value))) return { role, field: 'box_count', value: g(1) };
      if ((g = match(P.cabinetPorts, value))) return { role, field: 'ports', value: g(1) };
      return null;
  }
}

/** Longer texts are never read as a role (also keeps the patterns away from hostile input). */
export const MAX_ROLE_TEXT_LENGTH = 64;

/**
 * Reads a text with the roles of its layer: the first role (in TEXT_ROLES order) whose pattern
 * matches the whole trimmed text. null = the text means nothing for these roles (it is kept as an
 * unlinked text, never guessed).
 */
export function readRoleText(text: string, roles: readonly TextRole[]): RoleReading | null {
  const value = text.trim();
  if (value === '' || value.length > MAX_ROLE_TEXT_LENGTH) return null;
  for (const role of TEXT_ROLES) {
    if (!roles.includes(role)) continue;
    const reading = readAs(role, value);
    if (reading) return reading;
  }
  return null;
}

// ---------- identities ----------

/** Cabinets are matched by name across the two drawings (ADR-040): «1 - 7» = «1-7». */
export function cabinetNameKey(name: string): string {
  return name.trim().toUpperCase().replace(/\s+/g, '');
}

/**
 * A Secondary box's identity is its cabinet + its number (ADR-040), stored as the feature `code`:
 * cabinet 1-3, box 9 → "1-3/9". (Display format: open question, ADR-041.)
 */
export function boxCode(cabinet: string, number: string): string {
  return `${cabinetNameKey(cabinet)}/${number.trim()}`;
}

// ---------- suggestions (only suggestions: the PM confirms every rule) ----------

/** Share of a layer's sample texts a role must read to be suggested; technical tuning. */
export const TEXT_ROLE_SUGGEST_MIN_SHARE = 0.3;

/**
 * Roles to suggest for a layer from its sample texts (`MappingTextRow`s of that layer): the roles
 * of the drawing kind that fit the layer's target and read at least the minimum share of samples.
 */
export function suggestTextRoles(
  kind: DrawingKind,
  target: string,
  samples: readonly { text: string; count: number }[],
): TextRole[] {
  const allowed = TEXT_ROLES_BY_KIND[kind].filter((role) => textRoleFitsTarget(role, target));
  const total = samples.reduce((sum, s) => sum + s.count, 0);
  if (allowed.length === 0 || total === 0) return [];
  const read = new Map<TextRole, number>();
  for (const sample of samples) {
    const reading = readRoleText(sample.text, allowed);
    if (reading) read.set(reading.role, (read.get(reading.role) ?? 0) + sample.count);
  }
  return TEXT_ROLES.filter((role) => (read.get(role) ?? 0) / total >= TEXT_ROLE_SUGGEST_MIN_SHARE);
}

/** Technical bound on a bundle's ways (largest seen: 24). */
export const MAX_BUNDLE_WAYS = 288;

/**
 * Bundle ways suggested from a route layer name or kind: «1X12w Line» → 12, «OUTER DUCT 4 WAY
 * PRIMARY» → 4, «Single 1w Line» → 1. null when the name says nothing.
 */
export function suggestBundleWays(name: string): number | null {
  const m = /(\d+)\s*(?:-\s*)?w(?:ays?)?\b/i.exec(name.slice(0, 256));
  if (!m) return null;
  const ways = Number(m[1]);
  return ways >= 1 && ways <= MAX_BUNDLE_WAYS ? ways : null;
}
