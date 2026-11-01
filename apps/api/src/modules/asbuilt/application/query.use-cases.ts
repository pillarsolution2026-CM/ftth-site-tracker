import type {
  AsBuiltEditDetail,
  AsBuiltEditListQuery,
  AsBuiltEditListResponse,
  AsBuiltLengthsResponse,
  AsBuiltStateResponse,
} from '@ftth/shared';
import { AppError } from '../../../common/app-error.js';
import type { AsBuiltLengthsPort, AsBuiltReadQueries, AsBuiltScope } from './ports.js';

export class ListAsBuiltEditsUseCase {
  constructor(private readonly queries: AsBuiltReadQueries) {}

  execute(input: {
    projectId: string;
    scope: AsBuiltScope;
    query: AsBuiltEditListQuery;
  }): Promise<AsBuiltEditListResponse> {
    return this.queries.listEdits(input.projectId, input.scope, input.query);
  }
}

export class GetAsBuiltEditUseCase {
  constructor(private readonly queries: AsBuiltReadQueries) {}

  async execute(input: {
    projectId: string;
    scope: AsBuiltScope;
    editId: string;
  }): Promise<AsBuiltEditDetail> {
    const detail = await this.queries.detail(input.projectId, input.scope, input.editId);
    if (!detail) throw new AppError('NOT_FOUND', 'As-Built edit not found');
    return detail;
  }
}

export class GetAsBuiltStateUseCase {
  constructor(private readonly queries: AsBuiltReadQueries) {}

  async execute(input: { projectId: string; scope: AsBuiltScope }): Promise<AsBuiltStateResponse> {
    const state = await this.queries.state(input.projectId, input.scope);
    if (!state) throw new AppError('NOT_FOUND', 'Project not found');
    return state;
  }
}

export class GetAsBuiltLengthsUseCase {
  constructor(private readonly lengths: AsBuiltLengthsPort) {}

  execute(input: { projectId: string; scope: AsBuiltScope }): Promise<AsBuiltLengthsResponse> {
    return this.lengths.routeLengths(input.projectId, input.scope);
  }
}
