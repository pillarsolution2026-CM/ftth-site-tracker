import { z } from 'zod';

/**
 * Network feature types created from a drawing (build plan, "شاشة الـMapping"):
 * route = duct/cable path (مسار), box = distribution box (صندوق), hhi = handhole,
 * joint = splice joint, mh = existing manhole (MH قائم).
 */
export const FEATURE_TYPES = ['route', 'box', 'hhi', 'joint', 'mh'] as const;
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
};

export const POINT_FEATURE_TYPES = ['box', 'hhi', 'joint', 'mh'] as const;
export const PointFeatureTypeSchema = z.enum(POINT_FEATURE_TYPES);
export type PointFeatureType = z.infer<typeof PointFeatureTypeSchema>;
export const LINE_FEATURE_TYPES = ['route'] as const;

export function isPointFeatureType(value: string): value is PointFeatureType {
  return (POINT_FEATURE_TYPES as readonly string[]).includes(value);
}
