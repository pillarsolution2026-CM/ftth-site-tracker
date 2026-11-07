import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { parseKml, readKmlBytes } from './kml';

const doc = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document>${body}</Document></kml>`;

const point = (name: string, coords: string) =>
  `<Placemark><name>${name}</name><Point><coordinates>${coords}</coordinates></Point></Placemark>`;

describe('parseKml', () => {
  it('reads Point placemarks as lon,lat and skips lines, polygons and bad coordinates', () => {
    const result = parseKml(
      doc(
        point('Cab 1-7', ' 32.7832490,30.9845069,0 ') +
          '<Folder>' +
          point('04B', '32.79,30.99') +
          '</Folder>' +
          '<Placemark><name>Road</name><LineString><coordinates>32,30 33,31</coordinates></LineString></Placemark>' +
          point('bad', 'abc,def') +
          point('far', '200,30'),
      ),
    );
    expect(result).toEqual({
      ok: true,
      placemarks: [
        { id: 'p0', name: 'Cab 1-7', lat: 30.9845069, lon: 32.783249 },
        { id: 'p1', name: '04B', lat: 30.99, lon: 32.79 },
      ],
    });
  });

  it('takes the placemark name, not a nested name', () => {
    const result = parseKml(
      doc(
        '<Placemark><name>1-7</name><ExtendedData><Data name="x"><value>v</value></Data></ExtendedData>' +
          '<Point><coordinates>31,30</coordinates></Point></Placemark>',
      ),
    );
    expect(result.ok && result.placemarks[0]?.name).toBe('1-7');
  });

  it('says when the file is not KML or has no points', () => {
    expect(parseKml('not xml <')).toEqual({ ok: false, error: 'unreadable' });
    expect(parseKml(doc(''))).toEqual({ ok: false, error: 'noPoints' });
  });
});

describe('readKmlBytes', () => {
  it('reads a KMZ (zip) and prefers doc.kml', () => {
    const zip = zipSync({
      'files/other.kml': strToU8(doc(point('other', '31,30'))),
      'doc.kml': strToU8(doc(point('Cab 1-7', '32.78,30.98'))),
      'files/icon.png': new Uint8Array([1, 2, 3]),
    });
    const result = readKmlBytes(zip);
    expect(result.ok && result.placemarks.map((p) => p.name)).toEqual(['Cab 1-7']);
  });

  it('reads a plain KML whatever its name, and rejects a zip without KML', () => {
    expect(readKmlBytes(strToU8(doc(point('A', '31,30')))).ok).toBe(true);
    expect(readKmlBytes(zipSync({ 'a.txt': strToU8('x') }))).toEqual({
      ok: false,
      error: 'unreadable',
    });
  });
});
