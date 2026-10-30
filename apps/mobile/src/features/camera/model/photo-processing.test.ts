import { base64ToBytes, targetSize, toHex, watermarkLines } from './photo-processing';

describe('photo processing', () => {
  it('scales the long side down to 1600 px and never upscales', () => {
    expect(targetSize(4000, 3000)).toEqual({ width: 1600, height: 1200 });
    expect(targetSize(3000, 4000)).toEqual({ width: 1200, height: 1600 });
    expect(targetSize(1200, 900)).toEqual({ width: 1200, height: 900 });
  });

  it('writes feature, time, GPS and author on the watermark with Latin digits', () => {
    const lines = watermarkLines({
      featureCode: '1-1',
      featureType: 'box',
      takenAt: new Date(2026, 9, 30, 9, 5, 7),
      gps: { lon: 31.2054321, lat: 30.1801234, accuracyM: 4.4, at: '2026-10-30T07:05:07Z' },
      author: 'مشرف',
    });
    expect(lines).toEqual(['BOX 1-1', '2026-10-30 09:05:07', '30.180123, 31.205432 ±4 m', 'مشرف']);
    expect(
      watermarkLines({
        featureCode: null,
        featureType: 'route',
        takenAt: new Date(2026, 0, 1),
        gps: null,
        author: 'x',
      })[2],
    ).toBe('GPS —');
  });

  it('decodes base64 and hex-encodes digests like Node does', () => {
    const bytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 1, 2, 250, 0xff, 0xd9]);
    expect(Array.from(base64ToBytes('/9j/4AABAvr/2Q=='))).toEqual(Array.from(bytes));
    expect(toHex(Uint8Array.from([0, 15, 16, 255]))).toBe('000f10ff');
    expect(toHex(Uint8Array.from([0xab]).buffer)).toBe('ab');
  });
});
