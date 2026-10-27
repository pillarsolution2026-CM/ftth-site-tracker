export interface Project {
  id: string;
  name: string;
  client: string;
  /** Project CRS (metric). All project geometry is stored in it. */
  crsEpsg: number;
  /** ISO 4217 code. */
  currency: string;
  locale: 'ar' | 'en' | 'fr';
}

export interface ProjectRepository {
  findById(projectId: string): Promise<Project | null>;
}
