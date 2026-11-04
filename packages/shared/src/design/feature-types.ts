import { z } from 'zod';

/**
 * Network feature types created from a drawing (build plan, "شاشة الـMapping"):
 * route = duct/cable path (مسار), box = distribution box (صندوق), hhi = handhole,
 * joint = splice joint, mh = existing manhole (MH قائم), cabinet = main or sub cabinet (كابينة,
 * ADR-033/034), ring = single-way microduct laid to a house with no box and no fiber yet (ADR-033).
 */
export const FEATURE_TYPES = ['route', 'box', 'hhi', 'joint', 'mh', 'cabinet', 'ring'] as const;
export const FeatureTypeSchema = z.enum(FEATURE_TYPES);
export type FeatureType = z.infer<typeof FeatureTypeSchema>;

export const FEATURE_GEOMETRY_KINDS = ['line', 'point'] as const;
export type FeatureGeometryKind = (typeof FEATURE_GEOMETRY_KINDS)[number];

export const FEATURE_GEOMETRY: Readonly<Record<FeatureType, FeatureGeometryKind>> = {
  route: 'line',
  box: 'point',
  hhi: 'point',
  joint: 'point',
  mh: 'point',
  cabinet: 'point',
  ring: 'point',
};

export const POINT_FEATURE_TYPES = ['box', 'hhi', 'joint', 'mh', 'cabinet', 'ring'] as const;
export const PointFeatureTypeSchema = z.enum(POINT_FEATURE_TYPES);
export type PointFeatureType = z.infer<typeof PointFeatureTypeSchema>;
export const LINE_FEATURE_TYPES = ['route'] as const;

export function isPointFeatureType(value: string): value is PointFeatureType {
  return (POINT_FEATURE_TYPES as readonly string[]).includes(value);
}

/** A main cabinet (e.g. an Outdoor GPON) can feed several sub cabinets (ADR-034). */
export const CABINET_ROLES = ['main', 'sub'] as const;
export const CabinetRoleSchema = z.enum(CABINET_ROLES);
export type CabinetRole = z.infer<typeof CabinetRoleSchema>;

/** Existing items are counted like new ones, with their status (ADR-034). */
export const ITEM_STATUSES = ['new', 'existing'] as const;
export const ItemStatusSchema = z.enum(ITEM_STATUSES);
export type ItemStatus = z.infer<typeof ItemStatusSchema>;

/**
 * Free kind given by the PM on a mapping rule, e.g. a microduct bundle `1x12w` / `4 way` on a
 * route, or `144` / `36` on a joint (ADR-033). Counted and measured per kind; never interpreted.
 */
export const FeatureKindSchema = z.string().trim().min(1).max(64);
