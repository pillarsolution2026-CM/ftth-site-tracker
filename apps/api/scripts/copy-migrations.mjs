// tsc does not emit .sql files; the migration runner reads them next to its compiled location.
import { cpSync, mkdirSync } from 'node:fs';

mkdirSync('dist/db', { recursive: true });
cpSync('src/db/migrations', 'dist/db/migrations', { recursive: true });
