import { AppError } from '../../../common/app-error.js';
import type { Project, ProjectRepository } from '../domain/project.js';

export class GetProjectUseCase {
  constructor(private readonly projects: ProjectRepository) {}

  /** Authorization (membership) is enforced by ProjectScopeGuard before this runs. */
  async execute(projectId: string): Promise<Project> {
    const project = await this.projects.findById(projectId);
    if (!project) throw new AppError('NOT_FOUND', 'Project not found');
    return project;
  }
}
