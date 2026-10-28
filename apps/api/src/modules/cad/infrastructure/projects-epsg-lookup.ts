import type { GetProjectUseCase } from '../../projects/application/get-project.use-case.js';
import type { ProjectEpsgLookup } from '../application/ports.js';

/** Reads the project's CRS through the projects module's exported application service. */
export class ProjectsServiceEpsgLookup implements ProjectEpsgLookup {
  constructor(private readonly getProject: GetProjectUseCase) {}

  async epsgOf(projectId: string): Promise<number> {
    return (await this.getProject.execute(projectId)).crsEpsg;
  }
}
