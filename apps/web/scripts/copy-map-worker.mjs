// Copies MapLibre's web worker next to the app's static files (ADR-035 placement map). Bundled,
// MapLibre looks for it beside its own chunk, which Next.js does not emit; the map points at
// `/maplibre-gl-worker.mjs` instead (`setWorkerUrl`). Runs before `dev` and `build`.
import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const source = join(
  dirname(require.resolve('maplibre-gl/package.json')),
  'dist',
  'maplibre-gl-worker.mjs',
);
const target = join(here, '..', 'public', 'maplibre-gl-worker.mjs');
mkdirSync(dirname(target), { recursive: true });
copyFileSync(source, target);
