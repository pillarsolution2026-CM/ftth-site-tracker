import proj4 from 'proj4';
import { assertFinitePoint, GeometryError, type Point } from './point.js';

/**
 * The single place in TypeScript where coordinates change CRS (ARCHITECTURE §4;
 * the Python worker's equivalent is `cad_worker/domain/geo.py`). Geometry is
 * stored and measured in the project CRS; WGS84 is for display and GPS only.
 */

export interface LonLat {
  readonly lon: number;
  readonly lat: number;
}

export interface UtmZone {
  readonly zone: number;
  readonly hemisphere: 'north' | 'south';
}

export interface ProjectCrs extends UtmZone {
  readonly epsg: number;
  toWgs84(p: Point): LonLat;
  fromWgs84(p: LonLat): Point;
}

const WGS84 = 'EPSG:4326';

/** WGS 84 / UTM: EPSG 32601–32660 (north) and 32701–32760 (south). */
export function utmZoneFromEpsg(epsg: number): UtmZone {
  if (Number.isInteger(epsg)) {
    if (epsg >= 32601 && epsg <= 32660) return { zone: epsg - 32600, hemisphere: 'north' };
    if (epsg >= 32701 && epsg <= 32760) return { zone: epsg - 32700, hemisphere: 'south' };
  }
  throw new GeometryError('UNSUPPORTED_CRS', `EPSG:${epsg} is not a WGS 84 / UTM zone`);
}

export function utmProj4Definition({ zone, hemisphere }: UtmZone): string {
  return `+proj=utm +zone=${zone}${hemisphere === 'south' ? ' +south' : ''} +datum=WGS84 +units=m +no_defs`;
}

export function createProjectCrs(epsg: number): ProjectCrs {
  const utm = utmZoneFromEpsg(epsg);
  const converter = proj4(WGS84, utmProj4Definition(utm));
  return {
    epsg,
    ...utm,
    toWgs84(p) {
      assertFinitePoint(p);
      const [lon, lat] = converter.inverse([p.x, p.y]) as [number, number];
      assertFiniteResult(lon, lat);
      return { lon, lat };
    },
    fromWgs84({ lon, lat }) {
      assertFinitePoint({ x: lon, y: lat });
      assertLonLatInRange(lon, lat);
      const [x, y] = converter.forward([lon, lat]) as [number, number];
      assertFiniteResult(x, y);
      return { x, y };
    },
  };
}

/** proj4 silently returns a wrong point for impossible input (e.g. a GPS glitch), so reject it here. */
function assertLonLatInRange(lon: number, lat: number): void {
  if (Math.abs(lon) > 180 || Math.abs(lat) > 90) {
    throw new GeometryError('COORDINATE_OUT_OF_RANGE', `Not a WGS84 position: (${lon}, ${lat})`);
  }
}

function assertFiniteResult(a: number, b: number): void {
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    throw new GeometryError(
      'NON_FINITE_COORDINATE',
      'CRS transform produced a non-finite coordinate',
    );
  }
}
