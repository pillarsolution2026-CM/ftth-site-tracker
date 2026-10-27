import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { TestProject } from 'vitest/node';
import { migrate } from '../../src/db/migrate.js';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

const POSTGIS_IMAGE = 'postgis/postgis:16-3.4';

/**
 * Real PostGIS for every integration run (never mocked). Uses TEST_DATABASE_URL when CI provides a
 * service container; otherwise starts a throw-away Testcontainers instance.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  let container: StartedPostgreSqlContainer | undefined;
  let databaseUrl = process.env.TEST_DATABASE_URL;

  if (!databaseUrl) {
    // Ryuk (the reaper sidecar) is an extra image to pull; we stop the container ourselves in teardown.
    process.env.TESTCONTAINERS_RYUK_DISABLED ??= 'true';
    container = await new PostgreSqlContainer(POSTGIS_IMAGE)
      .withDatabase('ftth_test')
      .withUsername('ftth')
      .withPassword('ftth')
      .start();
    databaseUrl = container.getConnectionUri();
  }

  await migrate(databaseUrl);
  project.provide('databaseUrl', databaseUrl);

  return async () => {
    await container?.stop();
  };
}
