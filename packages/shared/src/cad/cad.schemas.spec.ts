import { describe, expect, it } from 'vitest';
import { CadTextListQuerySchema, CadTextSchema } from './cad-extraction.schemas.js';
import {
  CAD_FILE_STATUSES,
  CAD_FILE_TRANSITIONS,
  CadFileSummarySchema,
  canTransition,
} from './cad-file.schemas.js';
import { CAD_JOB_MAX_ATTEMPTS, CadImportJobSchema, CadJobSchema } from './cad-job.schemas.js';

const FILE_ID = '0b8f6a4e-3c1d-4a8e-9f7b-2d5c6e7f8a90';
const PROJECT_ID = '1c9f7b5e-4d2e-4b9f-8a6c-3e6d7f8a9b01';
const JOB_ID = '2d0a8c6f-5e3f-4c0a-9b7d-4f7e8a9b0c12';

describe('CAD file status machine', () => {
  it('has a transition entry for every status', () => {
    expect(Object.keys(CAD_FILE_TRANSITIONS).sort()).toEqual([...CAD_FILE_STATUSES].sort());
  });

  it('follows uploaded → queued → processing → processed | failed', () => {
    expect(canTransition('uploaded', 'queued')).toBe(true);
    expect(canTransition('queued', 'processing')).toBe(true);
    expect(canTransition('processing', 'processed')).toBe(true);
    expect(canTransition('processing', 'failed')).toBe(true);
  });

  it('allows reprocessing from final states (and stale ones, gated by the use case)', () => {
    expect(canTransition('processed', 'queued')).toBe(true);
    expect(canTransition('failed', 'queued')).toBe(true);
    expect(canTransition('processing', 'queued')).toBe(true);
  });

  it('never leaves a final state except by reprocessing', () => {
    expect(canTransition('processed', 'processing')).toBe(false);
    expect(canTransition('failed', 'processed')).toBe(false);
    expect(canTransition('processed', 'failed')).toBe(false);
  });

  it('never jumps straight to processed', () => {
    expect(canTransition('uploaded', 'processed')).toBe(false);
    expect(canTransition('queued', 'processed')).toBe(false);
  });
});

describe('CadFileSummarySchema', () => {
  it('accepts a queued file with no counts yet', () => {
    const summary = {
      id: FILE_ID,
      projectId: PROJECT_ID,
      originalName: 'قليوب.dwg',
      format: 'dwg',
      sizeBytes: 5_242_880,
      sha256: 'f'.repeat(64),
      status: 'queued',
      uploadedById: null,
      counts: null,
      warningCount: 0,
      errorCode: null,
      createdAt: '2026-10-27T10:00:00.000Z',
      updatedAt: '2026-10-27T10:00:00.000Z',
      processedAt: null,
    };
    expect(CadFileSummarySchema.safeParse(summary).success).toBe(true);
    expect(CadFileSummarySchema.safeParse({ ...summary, status: 'done' }).success).toBe(false);
  });
});

describe('CAD job message', () => {
  const job = {
    id: JOB_ID,
    type: 'cad.import',
    cadFileId: FILE_ID,
    projectId: PROJECT_ID,
    storageKey: `projects/${PROJECT_ID}/cad/${FILE_ID}/original.dwg`,
    format: 'dwg',
    attempt: 1,
    enqueuedAt: '2026-10-27T10:00:00.000Z',
  };

  it('accepts a valid import job', () => {
    expect(CadImportJobSchema.safeParse(job).success).toBe(true);
    expect(CadJobSchema.parse(job).type).toBe('cad.import');
  });

  it('still accepts the Phase 0 health job', () => {
    expect(CadJobSchema.parse({ id: 'h1', type: 'health' }).type).toBe('health');
  });

  it('rejects unknown types, bad formats and attempts beyond the maximum', () => {
    expect(CadJobSchema.safeParse({ ...job, type: 'cad.export' }).success).toBe(false);
    expect(CadImportJobSchema.safeParse({ ...job, format: 'dwf' }).success).toBe(false);
    const tooMany = { ...job, attempt: CAD_JOB_MAX_ATTEMPTS + 1 };
    expect(CadImportJobSchema.safeParse(tooMany).success).toBe(false);
    expect(CadImportJobSchema.safeParse({ ...job, attempt: 0 }).success).toBe(false);
  });
});

describe('CAD extraction read models', () => {
  it('parses the readable filter from the query string', () => {
    const query = CadTextListQuerySchema.parse({ readable: 'false', page: '2' });
    expect(query.readable).toBe(false);
    expect(query.page).toBe(2);
    expect(query.pageSize).toBe(100);
    expect(CadTextListQuerySchema.safeParse({ readable: 'no' }).success).toBe(false);
  });

  it('keeps raw and decoded text side by side', () => {
    const text = {
      id: FILE_ID,
      handle: '2F1',
      kind: 'mtext',
      layer: 'TEXT',
      position: { x: 312000.5, y: 3340000.25, z: 0 },
      height: 2.5,
      rotation: 0,
      rawText: '\\fArial|b0;C-12',
      text: 'C-12',
      readable: true,
      style: 'Standard',
      font: 'arial.ttf',
      aciColor: 256,
    };
    expect(CadTextSchema.safeParse(text).success).toBe(true);
    expect(CadTextSchema.safeParse({ ...text, aciColor: 300 }).success).toBe(false);
  });
});
