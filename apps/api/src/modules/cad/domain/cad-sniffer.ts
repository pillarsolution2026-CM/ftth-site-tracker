import type { CadFormat } from '@ftth/shared';
import { AppError } from '../../../common/app-error.js';

/** Bytes needed to recognise every supported signature (ASCII DXF may start with comment groups). */
export const SNIFF_BYTES = 4096;

const BINARY_DXF = 'AutoCAD Binary DXF';
const DWG_SIGNATURE = /^AC10\d\d/;
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

const unsupported = (message: string): AppError => new AppError('UNSUPPORTED_FILE', message);

function isAsciiDxf(head: Buffer): boolean {
  const body = head.subarray(0, 3).equals(UTF8_BOM) ? head.subarray(3) : head;
  const lines = body.toString('latin1').split(/\r\n|\r|\n/);
  let index = 0;
  // Group 999 is a comment: skip its (code, value) pair.
  while (lines[index]?.trim() === '999') index += 2;
  return lines[index]?.trim() === '0' && lines[index + 1]?.trim() === 'SECTION';
}

/** The format the extension claims; anything else is refused. */
export function declaredFormat(fileName: string): CadFormat {
  const dot = fileName.lastIndexOf('.');
  const extension = dot < 0 ? '' : fileName.slice(dot + 1).toLowerCase();
  if (extension === 'dwg' || extension === 'dxf') return extension;
  throw unsupported('Only .dwg and .dxf files are accepted');
}

/**
 * Verifies that the content matches the extension: DWG starts with `AC10` + 2 digits; DXF is
 * binary (`AutoCAD Binary DXF`) or ASCII (first non-comment group is `0` / `SECTION`).
 */
export function verifyCadContent(format: CadFormat, head: Buffer): void {
  const text = head.subarray(0, 32).toString('latin1');
  const matches =
    format === 'dwg' ? DWG_SIGNATURE.test(text) : text.startsWith(BINARY_DXF) || isAsciiDxf(head);
  if (!matches) throw unsupported(`The content is not a valid .${format} file`);
}
