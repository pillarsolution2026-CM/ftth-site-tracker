import { z } from 'zod';

/**
 * Drawing unit = what one drawing coordinate unit means in the real world (ADR-018, Proposed).
 * It is NOT decided globally: the PM picks it per drawing on the mapping screen, it is stored
 * with every design revision, and every length in metres goes through `METRES_PER_UNIT`.
 * There is deliberately no default.
 */
export const DRAWING_UNITS = ['m', 'cm', 'mm', 'km', 'in', 'ft'] as const;
export const DrawingUnitSchema = z.enum(DRAWING_UNITS);
export type DrawingUnit = z.infer<typeof DrawingUnitSchema>;

/** Exact conversion factors as decimal strings (international inch and foot). */
export const METRES_PER_UNIT: Readonly<Record<DrawingUnit, string>> = {
  m: '1',
  cm: '0.01',
  mm: '0.001',
  km: '1000',
  in: '0.0254',
  ft: '0.3048',
};

/** DXF `$INSUNITS` codes that correspond to a DrawingUnit (DXF reference; 0 = unitless). */
export const INSUNITS_TO_DRAWING_UNIT: Readonly<Record<number, DrawingUnit>> = {
  1: 'in',
  2: 'ft',
  4: 'mm',
  5: 'cm',
  6: 'm',
  7: 'km',
};

/** The DrawingUnit declared by `$INSUNITS`, or null when unitless/absent/unsupported. */
export function drawingUnitFromInsUnits(insUnits: number | null | undefined): DrawingUnit | null {
  if (insUnits === null || insUnits === undefined) return null;
  return INSUNITS_TO_DRAWING_UNIT[insUnits] ?? null;
}
