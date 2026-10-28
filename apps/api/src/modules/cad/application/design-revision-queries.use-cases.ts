import type {
  DesignFeatureListQuery,
  DesignFeaturePage,
  DiffListQuery,
  DiffPage,
  TextLinkListQuery,
  TextLinkPage,
} from '@ftth/shared';
import { AppError } from '../../../common/app-error.js';
import { hasBuiltContent, type DesignRevision } from '../domain/design-revision.js';
import type {
  DesignReadQueries,
  DesignRevisionRepository,
} from '../domain/design-revision.repository.js';

export async function requireRevision(
  revisions: DesignRevisionRepository,
  projectId: string,
  revisionId: string,
): Promise<DesignRevision> {
  const revision = await revisions.find(projectId, revisionId);
  if (!revision) throw new AppError('NOT_FOUND', 'Design revision not found');
  return revision;
}

const emptyPage = <T>(query: { page: number; pageSize: number }) => ({
  items: [] as T[],
  page: query.page,
  pageSize: query.pageSize,
  total: 0,
});

export class ListDesignRevisionsUseCase {
  constructor(private readonly revisions: DesignRevisionRepository) {}

  execute(projectId: string): Promise<DesignRevision[]> {
    return this.revisions.list(projectId);
  }
}

export class GetDesignRevisionUseCase {
  constructor(private readonly revisions: DesignRevisionRepository) {}

  execute(projectId: string, revisionId: string): Promise<DesignRevision> {
    return requireRevision(this.revisions, projectId, revisionId);
  }
}

/**
 * The lists below are empty until the worker has finished: while a build is queued, running or
 * failed, rows of an earlier attempt must not be shown.
 */
export class ListDesignFeaturesUseCase {
  constructor(
    private readonly revisions: DesignRevisionRepository,
    private readonly reads: DesignReadQueries,
  ) {}

  async execute(
    projectId: string,
    revisionId: string,
    query: DesignFeatureListQuery,
  ): Promise<DesignFeaturePage> {
    const revision = await requireRevision(this.revisions, projectId, revisionId);
    return hasBuiltContent(revision)
      ? this.reads.features(projectId, revisionId, query)
      : emptyPage(query);
  }
}

export class ListTextLinksUseCase {
  constructor(
    private readonly revisions: DesignRevisionRepository,
    private readonly reads: DesignReadQueries,
  ) {}

  async execute(
    projectId: string,
    revisionId: string,
    query: TextLinkListQuery,
  ): Promise<TextLinkPage> {
    const revision = await requireRevision(this.revisions, projectId, revisionId);
    return hasBuiltContent(revision)
      ? this.reads.textLinks(projectId, revisionId, query)
      : emptyPage(query);
  }
}

export class ListRevisionDiffUseCase {
  constructor(
    private readonly revisions: DesignRevisionRepository,
    private readonly reads: DesignReadQueries,
  ) {}

  async execute(projectId: string, revisionId: string, query: DiffListQuery): Promise<DiffPage> {
    const revision = await requireRevision(this.revisions, projectId, revisionId);
    return hasBuiltContent(revision)
      ? this.reads.diff(projectId, revisionId, query)
      : emptyPage(query);
  }
}
