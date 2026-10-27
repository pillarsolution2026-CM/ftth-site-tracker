import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  // Trace workspace packages (../../packages/*) into the standalone bundle.
  outputFileTracingRoot: path.join(here, '../../'),
  poweredByHeader: false,
};

export default nextConfig;
