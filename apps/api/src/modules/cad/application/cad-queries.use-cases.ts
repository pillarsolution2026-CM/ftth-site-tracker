import type { Readable } from 'node:stream';
import {
  type CadCurveListQuery,
  type CadCurvePage,
  type CadInsertListQuery,
  type CadInsertPage,
  type CadLayer,
  type CadTextListQuery,
  type CadTextPage,
} from '@ftth/shared';
import { AppError } from '../../../common/app-error.js';
import type { ObjectStorage } from '../../../common/object-storage.port.js';
import type { CadFile } from '../domain/cad-file.js';
import type { CadExtractionQueries, CadFileRepository } from '../domain/cad-file.repository.js';

async function requireFile(
  files: CadFileRepository,
  projectId: string,
  cadFileId: string,
): Promise<CadFile> {
  const file = await files.find(projectId, cadFileId);
  if (!file) throw new AppError('NOT_FOUND', 'CAD file not found');
  return file;
}

export class ListCadFilesUseCase {
  constructor(private readonly files: CadFileRepository) {}

  execute(projectId: string): Promise<CadFile[]> {
    return this.files.list(projectId);
  }
}

export class GetCadFileUseCase {
  constructor(private readonly files: CadFileRepository) {}

  execute(projectId: string, cadFileId: string): Promise<CadFile> {
    return requireFile(this.files, projectId, cadFileId);
  }
}

export class GetCadFileContentUseCase {
  constructor(
    private readonly files: CadFileRepository,
    private readonly storage: ObjectStorage,
  ) {}

  async execute(
    projectId: string,
    cadFileId: string,
  ): Promise<{ file: CadFile; stream: Readable }> {
    const file = await requireFile(this.files, projectId, cadFileId);
    return { file, stream: await this.storage.get(file.storageKey) };
  }
}

export class GetCadFileLogUseCase {
  constructor(private readonly files: CadFileRepository) {}

  async execute(projectId: string, cadFileId: string): Promise<string> {
    await requireFile(this.files, projectId, cadFileId);
    return (await this.files.findLog(projectId, cadFileId)) ?? '';
  }
}

const emptyPage = <T>(query: { page: number; pageSize: number }) => ({
  items: [] as T[],
  page: query.page,
  pageSize: query.pageSize,
  total: 0,
});

/**
 * Extraction lists of a file that is not `processed` are empty: while a (re)run is in flight the
 * rows of an earlier run may still exist, but they are about to be replaced and must not be shown.
 */
export class CadExtractionUseCases {
  constructor(
    private readonly files: CadFileRepository,
    private readonly queries: CadExtractionQueries,
  ) {}

  async layers(projectId: string, cadFileId: string): Promise<CadLayer[]> {
    const file = await requireFile(this.files, projectId, cadFileId);
    return file.status === 'processed' ? this.queries.layers(projectId, cadFileId) : [];
  }

  async inserts(
    projectId: string,
    cadFileId: string,
    query: CadInsertListQuery,
  ): Promise<CadInsertPage> {
    const file = await requireFile(this.files, projectId, cadFileId);
    return file.status === 'processed'
      ? this.queries.inserts(projectId, cadFileId, query)
      : emptyPage(query);
  }

  async texts(projectId: string, cadFileId: string, query: CadTextListQuery): Promise<CadTextPage> {
    const file = await requireFile(this.files, projectId, cadFileId);
    return file.status === 'processed'
      ? this.queries.texts(projectId, cadFileId, query)
      : emptyPage(query);
  }

  async curves(
    projectId: string,
    cadFileId: string,
    query: CadCurveListQuery,
  ): Promise<CadCurvePage> {
    const file = await requireFile(this.files, projectId, cadFileId);
    return file.status === 'processed'
      ? this.queries.curves(projectId, cadFileId, query)
      : emptyPage(query);
  }
}
