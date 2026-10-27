import type { GetProjectUseCase } from '../../projects/application/get-project.use-case.js';
import type { ProjectCurrencyLookup } from '../application/ports.js';

/** Reads the currency through the projects module's exported application service. */
export class ProjectsServiceCurrencyLookup implements ProjectCurrencyLookup {
  constructor(private readonly getProject: GetProjectUseCase) {}

  async currencyOf(projectId: string): Promise<string> {
    return (await this.getProject.execute(projectId)).currency;
  }
}
