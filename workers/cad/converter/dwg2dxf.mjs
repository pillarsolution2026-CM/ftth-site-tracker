// Usage: node dwg2dxf.mjs <input.dwg> <output.dxf>
// Exit codes: 0 ok (a LibreDWG read warning is not fatal when output was produced),
// 2 bad usage, 3 unreadable input, 4 conversion produced no output.
import { readFile, writeFile } from 'node:fs/promises';
import { LibreDwg } from '@mlightcad/libredwg-web';

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error('usage: dwg2dxf.mjs <input.dwg> <output.dxf>');
  process.exit(2);
}

let bytes;
try {
  bytes = await readFile(input);
} catch (err) {
  console.error(`cannot read ${input}: ${err.message}`);
  process.exit(3);
}

try {
  const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const lib = await LibreDwg.create();
  const dxf = lib.dwg_write_dxf(arrayBuffer);
  if (!dxf || dxf.length === 0) {
    console.error('libredwg produced no DXF output');
    process.exit(4);
  }
  await writeFile(output, dxf);
  console.log(`wrote ${dxf.length} bytes to ${output}`);
} catch (err) {
  console.error(`conversion failed: ${err?.message ?? err}`);
  process.exit(4);
}
