import type { DrawingLinetype } from '@ftth/shared';
import { colorLabel } from './aci-colors';
import { ACI_COLORS, acadNumber, LINETYPE_NAMES, LINETYPES, LINEWEIGHTS } from './cad-commands';
import {
  isTextEntity,
  moveEdits,
  roundCoord,
  rotateEdits,
  scaleEdits,
  setCurveEdit,
  type CanvasEdit,
} from './canvas-edit';
import { effectiveLayer, type DrawingPreview, type PreviewStyle } from './drawing-preview';
import type { DrawingScene } from './drawing-scene';
import {
  geometryOf,
  normalAngle,
  objectName,
  polygonArea,
  polylineLength,
  type EntityGeometry,
  type Xy,
} from './entity-geometry';

/**
 * AutoCAD's Properties palette (owner 2026-11-26, item 12) for the picked objects: the object type
 * drop-down («All (n)» or one type), then General, Geometry, Text, Misc and Attributes. A cell the
 * user changes becomes a correction (layer → move_layer, colour / line type / line weight →
 * set_style, coordinates → set_curve / move_item, radius → scale_item, rotation → rotate_item,
 * contents → set_text, attribute → set_attribute). A field the view does not carry is read-only
 * and says why.
 */

export type PropertySection = 'general' | 'geometry' | 'text' | 'misc' | 'attributes';

/** Why a field cannot be changed here (i18n keys under `design.cad.prop.why`). */
export type ReadOnlyReason = 'notInView' | 'noCorrection' | 'computed' | 'noRule';

export type PropertyEditor =
  | { kind: 'number' }
  | { kind: 'text' }
  | { kind: 'select'; options: readonly { value: string; label: string }[] };

export interface PropertyRow {
  /** Stable id; the label is `design.cad.prop.<label>`. */
  id: string;
  label: string;
  section: PropertySection;
  /** The value shown; `*VARIES*` when the objects differ (AutoCAD). */
  value: string;
  /** The editor's value (a select's option value), when editable. */
  raw?: string;
  editor: PropertyEditor | null;
  reason?: ReadOnlyReason;
}

export const VARIES = '*VARIES*';
export const BY_LAYER = 'ByLayer';

export interface PropertiesInput {
  scene: DrawingScene;
  preview: DrawingPreview;
  /** The picked objects (one index per handle is enough). */
  indexes: readonly number[];
  /** Layers objects may be moved to (they have a rule). */
  layers: readonly string[];
  /** Polyline: which vertex the Vertex X / Y cells show (0-based). */
  vertex: number;
}

const n = (value: number) => acadNumber(Math.abs(value) < 5e-5 ? 0 : value);
const deg = (value: number) => acadNumber(normalAngle(value));

/** The type drop-down: «All (n)» first, then each type with its count. */
export function objectTypes(
  scene: DrawingScene,
  preview: DrawingPreview,
  indexes: readonly number[],
): { name: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const index of indexes) {
    const name = nameOf(scene, preview, index);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts].map(([name, count]) => ({ name, count }));
}

export const nameOf = (scene: DrawingScene, preview: DrawingPreview, index: number) =>
  objectName(geometryOf(scene, preview, index), scene.view.entities[index]?.kind ?? '');

function same(values: readonly string[]): string {
  const [first] = values;
  return first !== undefined && values.every((v) => v === first) ? first : VARIES;
}

function styleOf(preview: DrawingPreview, index: number): PreviewStyle {
  return preview.styleOf.get(index) ?? { color: null, linetype: null, lineweight: null };
}

/**
 * How an object is drawn now, as AutoCAD's Properties shows it: a style made here, else the
 * object's own colour in the file (not «ByLayer» when it has one); null fields are ByLayer.
 */
export function objectStyle(
  scene: DrawingScene,
  preview: DrawingPreview,
  index: number,
): PreviewStyle {
  const style = preview.styleOf.get(index);
  return {
    color: style?.color ?? scene.view.entities[index]?.color ?? null,
    linetype: style?.linetype ?? null,
    lineweight: style?.lineweight ?? null,
  };
}

const colorName = (hex: string | null) => colorLabel(hex);

/** The colour drop-down: ByLayer, the index colours, and the colour shown when it is another. */
function colorOptions(shown: string): { value: string; label: string }[] {
  const options = [
    { value: '', label: BY_LAYER },
    ...ACI_COLORS.map((c) => ({ value: c.hex, label: c.name })),
  ];
  if (shown && shown !== VARIES && !options.some((o) => o.value === shown))
    options.push({ value: shown, label: colorLabel(shown) });
  return options;
}

/**
 * AutoCAD's current properties for new objects (CECOLOR, CELTYPE, CELWEIGHT, CETRANSPARENCY):
 * set from the ribbon's Properties panel or the palette with nothing picked; null = ByLayer.
 * Transparency stays on the screen (no correction carries it).
 */
export interface CurrentStyle extends PreviewStyle {
  /** Percent 0-90; null = ByLayer. */
  transparency: number | null;
}

export const BY_LAYER_STYLE: CurrentStyle = {
  color: null,
  linetype: null,
  lineweight: null,
  transparency: null,
};

/**
 * The `set_style` a new object drawn now gets so it is drawn with the current properties (AutoCAD
 * draws with CECOLOR / CELTYPE / CELWEIGHT); none when they are all ByLayer. `handle` names the new
 * item (`NEW-<ref>` inside one «حفظ», ADR-061).
 */
export function currentStyleEdits(current: CurrentStyle, handle: string): CanvasEdit[] {
  if (current.color === null && current.linetype === null && current.lineweight === null) return [];
  return [
    {
      kind: 'set_style',
      handle,
      color: current.color,
      linetype: current.linetype,
      lineweight: current.lineweight,
    },
  ];
}

/** The palette with nothing picked: General with the current properties (AutoCAD). */
export function currentRows(current: CurrentStyle, layer: string): PropertyRow[] {
  const color = current.color ?? '';
  return [
    {
      id: 'color',
      label: 'color',
      section: 'general',
      value: colorName(current.color),
      raw: color,
      editor: { kind: 'select', options: colorOptions(color) },
    },
    { id: 'layer', label: 'layer', section: 'general', value: layer || '—', editor: null },
    {
      id: 'linetype',
      label: 'linetype',
      section: 'general',
      value: current.linetype ? LINETYPE_NAMES[current.linetype] : BY_LAYER,
      raw: current.linetype ?? '',
      editor: {
        kind: 'select',
        options: [
          { value: '', label: BY_LAYER },
          ...LINETYPES.map((lt) => ({ value: lt, label: LINETYPE_NAMES[lt] })),
        ],
      },
    },
    {
      id: 'lineweight',
      label: 'lineweight',
      section: 'general',
      value: current.lineweight === null ? BY_LAYER : `${current.lineweight.toFixed(2)} mm`,
      raw: current.lineweight === null ? '' : String(current.lineweight),
      editor: {
        kind: 'select',
        options: [
          { value: '', label: BY_LAYER },
          ...LINEWEIGHTS.map((w) => ({ value: String(w), label: `${w.toFixed(2)} mm` })),
        ],
      },
    },
    {
      id: 'transparency',
      label: 'transparency',
      section: 'general',
      value: current.transparency === null ? BY_LAYER : String(current.transparency),
      raw: current.transparency === null ? '' : String(current.transparency),
      editor: { kind: 'number' },
    },
  ];
}

/** A changed cell of the current properties; null when the value is not usable. */
export function currentPatch(rowId: string, value: string): Partial<CurrentStyle> | null {
  switch (rowId) {
    case 'color':
      return { color: value || null };
    case 'linetype':
      return { linetype: (value || null) as DrawingLinetype | null };
    case 'lineweight':
      return { lineweight: value === '' ? null : Number(value) };
    case 'transparency': {
      const text = value.trim();
      if (text === '' || text.toLowerCase() === 'bylayer') return { transparency: null };
      const v = Number(text);
      return Number.isInteger(v) && v >= 0 && v <= 90 ? { transparency: v } : null;
    }
    default:
      return null;
  }
}

export function propertyRows(input: PropertiesInput): PropertyRow[] {
  const { scene, preview, indexes } = input;
  if (indexes.length === 0) return [];
  // The colour shown is the object's own in the file too, not «ByLayer» (AutoCAD).
  const styles = indexes.map((i) => objectStyle(scene, preview, i));
  const layerNames = indexes.map(
    (i) => scene.view.layers[effectiveLayer(scene, preview, i)]?.name ?? '',
  );
  const color = same(styles.map((s) => s.color ?? ''));
  const linetype = same(styles.map((s) => s.linetype ?? ''));
  const lineweight = same(styles.map((s) => (s.lineweight === null ? '' : String(s.lineweight))));
  const layer = same(layerNames);
  const layerOptions = [...new Set([...input.layers, ...layerNames])].sort((a, b) =>
    a.localeCompare(b),
  );
  const rows: PropertyRow[] = [
    {
      id: 'color',
      label: 'color',
      section: 'general',
      value: color === VARIES ? VARIES : colorName(color || null),
      raw: color === VARIES ? undefined : color,
      editor: { kind: 'select', options: colorOptions(color) },
    },
    {
      id: 'layer',
      label: 'layer',
      section: 'general',
      value: layer,
      raw: layer === VARIES ? undefined : layer,
      editor: {
        kind: 'select',
        options: layerOptions.map((name) => ({ value: name, label: name })),
      },
    },
    {
      id: 'linetype',
      label: 'linetype',
      section: 'general',
      value:
        linetype === VARIES
          ? VARIES
          : linetype
            ? LINETYPE_NAMES[linetype as DrawingLinetype]
            : BY_LAYER,
      raw: linetype === VARIES ? undefined : linetype,
      editor: {
        kind: 'select',
        options: [
          { value: '', label: BY_LAYER },
          ...LINETYPES.map((lt) => ({ value: lt, label: LINETYPE_NAMES[lt] })),
        ],
      },
    },
    {
      id: 'ltscale',
      label: 'ltscale',
      section: 'general',
      value: '—',
      editor: null,
      reason: 'notInView',
    },
    {
      id: 'lineweight',
      label: 'lineweight',
      section: 'general',
      value:
        lineweight === VARIES
          ? VARIES
          : lineweight
            ? `${Number(lineweight).toFixed(2)} mm`
            : BY_LAYER,
      raw: lineweight === VARIES ? undefined : lineweight,
      editor: {
        kind: 'select',
        options: [
          { value: '', label: BY_LAYER },
          ...LINEWEIGHTS.map((w) => ({ value: String(w), label: `${w.toFixed(2)} mm` })),
        ],
      },
    },
    {
      id: 'transparency',
      label: 'transparency',
      section: 'general',
      value: BY_LAYER,
      editor: null,
      reason: 'notInView',
    },
  ];
  if (indexes.length !== 1) return rows;
  const index = indexes[0] as number;
  const geometry = geometryOf(scene, preview, index);
  if (geometry) rows.push(...geometryRows(geometry, input.vertex, isTextEntity(scene, index)));
  return rows;
}

const editable = (id: string, label: string, section: PropertySection, value: string) =>
  ({ id, label, section, value, raw: value, editor: { kind: 'number' } }) satisfies PropertyRow;
const fixed = (
  id: string,
  label: string,
  section: PropertySection,
  value: string,
  reason: ReadOnlyReason,
): PropertyRow => ({ id, label, section, value, editor: null, reason });

function geometryRows(g: EntityGeometry, vertex: number, textEditable: boolean): PropertyRow[] {
  switch (g.type) {
    case 'line': {
      const dx = g.end.x - g.start.x;
      const dy = g.end.y - g.start.y;
      return [
        editable('startX', 'startX', 'geometry', n(g.start.x)),
        editable('startY', 'startY', 'geometry', n(g.start.y)),
        editable('endX', 'endX', 'geometry', n(g.end.x)),
        editable('endY', 'endY', 'geometry', n(g.end.y)),
        fixed('deltaX', 'deltaX', 'geometry', n(dx), 'computed'),
        fixed('deltaY', 'deltaY', 'geometry', n(dy), 'computed'),
        fixed('length', 'length', 'geometry', n(Math.hypot(dx, dy)), 'computed'),
        fixed('angle', 'angle', 'geometry', deg((Math.atan2(dy, dx) * 180) / Math.PI), 'computed'),
      ];
    }
    case 'polyline': {
      const at = Math.min(Math.max(0, vertex), g.points.length - 1);
      const p = g.points[at] as Xy;
      const rows: PropertyRow[] = [
        {
          id: 'vertex',
          label: 'vertex',
          section: 'geometry',
          value: String(at + 1),
          raw: String(at),
          editor: {
            kind: 'select',
            options: g.points.map((_, i) => ({ value: String(i), label: String(i + 1) })),
          },
        },
        editable('vertexX', 'vertexX', 'geometry', n(p.x)),
        editable('vertexY', 'vertexY', 'geometry', n(p.y)),
        fixed('length', 'length', 'geometry', n(polylineLength(g.points, g.closed)), 'computed'),
      ];
      if (g.closed)
        rows.push(fixed('area', 'area', 'geometry', n(polygonArea(g.points)), 'computed'));
      rows.push({
        id: 'closed',
        label: 'closed',
        section: 'misc',
        value: g.closed ? 'Yes' : 'No',
        raw: g.closed ? 'yes' : 'no',
        editor: {
          kind: 'select',
          options: [
            { value: 'no', label: 'No' },
            { value: 'yes', label: 'Yes' },
          ],
        },
      });
      return rows;
    }
    case 'circle':
      return [
        editable('centerX', 'centerX', 'geometry', n(g.center.x)),
        editable('centerY', 'centerY', 'geometry', n(g.center.y)),
        editable('radius', 'radius', 'geometry', n(g.radius)),
        editable('diameter', 'diameter', 'geometry', n(g.radius * 2)),
        editable('circumference', 'circumference', 'geometry', n(2 * Math.PI * g.radius)),
        editable('area', 'area', 'geometry', n(Math.PI * g.radius * g.radius)),
      ];
    case 'arc': {
      const start = (Math.atan2(g.start.y - g.center.y, g.start.x - g.center.x) * 180) / Math.PI;
      const end = (Math.atan2(g.end.y - g.center.y, g.end.x - g.center.x) * 180) / Math.PI;
      const total = normalAngle(end - start);
      return [
        editable('centerX', 'centerX', 'geometry', n(g.center.x)),
        editable('centerY', 'centerY', 'geometry', n(g.center.y)),
        editable('radius', 'radius', 'geometry', n(g.radius)),
        fixed('startAngle', 'startAngle', 'geometry', deg(start), 'noCorrection'),
        fixed('endAngle', 'endAngle', 'geometry', deg(end), 'noCorrection'),
        fixed('totalAngle', 'totalAngle', 'geometry', deg(total), 'computed'),
        fixed(
          'arcLength',
          'arcLength',
          'geometry',
          n((g.radius * total * Math.PI) / 180),
          'computed',
        ),
      ];
    }
    case 'text':
      return [
        {
          id: 'contents',
          label: 'contents',
          section: 'text',
          value: g.text,
          raw: g.text,
          editor: textEditable ? { kind: 'text' } : null,
          reason: textEditable ? undefined : 'noCorrection',
        },
        fixed('style', 'style', 'text', '—', 'notInView'),
        fixed('height', 'height', 'text', n(g.height), 'noCorrection'),
        fixed('rotation', 'rotation', 'text', deg(g.rotation), 'noCorrection'),
        editable('positionX', 'positionX', 'geometry', n(g.at.x)),
        editable('positionY', 'positionY', 'geometry', n(g.at.y)),
      ];
    case 'insert': {
      const rows: PropertyRow[] = [
        g.name === null
          ? fixed('name', 'name', 'misc', '—', 'notInView')
          : fixed('name', 'name', 'misc', g.name, 'noCorrection'),
      ];
      if (g.at) {
        rows.push(
          editable('positionX', 'positionX', 'geometry', n(g.at.x)),
          editable('positionY', 'positionY', 'geometry', n(g.at.y)),
          editable('rotation', 'rotation', 'misc', deg(g.rotation ?? 0)),
          fixed('scaleX', 'scaleX', 'geometry', n(g.scaleX ?? 1), 'noCorrection'),
          fixed('scaleY', 'scaleY', 'geometry', n(g.scaleY ?? 1), 'noCorrection'),
        );
      } else {
        for (const id of ['positionX', 'positionY', 'rotation', 'scaleX', 'scaleY']) {
          rows.push(fixed(id, id, 'geometry', '—', 'notInView'));
        }
      }
      g.values.forEach((value, i) =>
        rows.push({
          id: `attr:${i}`,
          label: 'attribute',
          section: 'attributes',
          value,
          raw: value,
          editor: { kind: 'text' },
        }),
      );
      return rows;
    }
    default:
      return [];
  }
}

/** The corrections a changed cell makes; null when the value is not usable. */
export function propertyEdits(
  input: PropertiesInput,
  rowId: string,
  value: string,
): CanvasEdit[] | null {
  const { scene, preview, indexes } = input;
  const handles = [
    ...new Set(indexes.map((i) => scene.view.entities[i]?.handle).filter(Boolean)),
  ] as string[];
  if (handles.length === 0) return null;
  const styleEdits = (patch: Partial<PreviewStyle>): CanvasEdit[] =>
    handles.map((handle) => {
      const index = indexes.find((i) => scene.view.entities[i]?.handle === handle) as number;
      return { kind: 'set_style', handle, ...styleOf(preview, index), ...patch };
    });
  switch (rowId) {
    case 'color':
      return styleEdits({ color: value || null });
    case 'linetype':
      return styleEdits({ linetype: (value || null) as DrawingLinetype | null });
    case 'lineweight':
      return styleEdits({ lineweight: value === '' ? null : Number(value) });
    case 'layer':
      if (!input.layers.includes(value)) return null;
      return handles.map((handle) => ({ kind: 'move_layer', handle, toLayer: value }));
  }
  const index = indexes[0];
  const handle = handles[0];
  if (indexes.length !== 1 || index === undefined || handle === undefined) return null;
  const g = geometryOf(scene, preview, index);
  if (!g) return null;
  if (rowId === 'contents' && g.type === 'text') {
    const text = value.trim();
    return text && text !== g.text ? [{ kind: 'set_text', handle, text }] : null;
  }
  if (rowId.startsWith('attr:') && g.type === 'insert') {
    const from = g.values[Number(rowId.slice(5))];
    const to = value.trim();
    return from !== undefined && to && to !== from
      ? [{ kind: 'set_attribute', handle, from, to }]
      : null;
  }
  if (rowId === 'closed' && g.type === 'polyline') {
    const closed = value === 'yes';
    if (closed === g.closed || (closed && g.points.length < 3)) return null;
    return [setCurveEdit(handle, pairs(g.points), closed)];
  }
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const moveTo = (from: Xy, x: number, y: number) =>
    x === from.x && y === from.y ? null : moveEdits([handle], x - from.x, y - from.y);
  switch (g.type) {
    case 'line': {
      const start = { ...g.start };
      const end = { ...g.end };
      if (rowId === 'startX') start.x = number;
      else if (rowId === 'startY') start.y = number;
      else if (rowId === 'endX') end.x = number;
      else if (rowId === 'endY') end.y = number;
      else return null;
      return [setCurveEdit(handle, pairs([start, end]), false)];
    }
    case 'polyline': {
      const at = Math.min(Math.max(0, input.vertex), g.points.length - 1);
      const points = g.points.map((p) => ({ ...p }));
      const p = points[at] as Xy;
      if (rowId === 'vertexX') p.x = number;
      else if (rowId === 'vertexY') p.y = number;
      else return null;
      return [setCurveEdit(handle, pairs(points), g.closed)];
    }
    case 'circle':
    case 'arc': {
      if (rowId === 'centerX') return moveTo(g.center, number, g.center.y);
      if (rowId === 'centerY') return moveTo(g.center, g.center.x, number);
      const radius =
        rowId === 'radius'
          ? number
          : g.type === 'circle' && rowId === 'diameter'
            ? number / 2
            : g.type === 'circle' && rowId === 'circumference'
              ? number / (2 * Math.PI)
              : g.type === 'circle' && rowId === 'area'
                ? Math.sqrt(number / Math.PI)
                : NaN;
      if (!(radius > 0) || !(g.radius > 0)) return null;
      return scaleEdits([handle], g.center.x, g.center.y, roundCoord(radius / g.radius));
    }
    case 'text':
      if (rowId === 'positionX') return moveTo(g.at, number, g.at.y);
      if (rowId === 'positionY') return moveTo(g.at, g.at.x, number);
      return null;
    case 'insert':
      if (!g.at) return null;
      if (rowId === 'positionX') return moveTo(g.at, number, g.at.y);
      if (rowId === 'positionY') return moveTo(g.at, g.at.x, number);
      if (rowId === 'rotation') {
        const turn = number - (g.rotation ?? 0);
        return Math.abs(turn) < 1e-9 ? null : rotateEdits([handle], g.at.x, g.at.y, turn);
      }
      return null;
    default:
      return null;
  }
}

const pairs = (points: readonly Xy[]) => points.map((p) => [p.x, p.y] as [number, number]);
