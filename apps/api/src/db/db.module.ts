import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import type { ApiEnv } from '@ftth/shared';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { EVENT_LOG } from '../common/event-log.port.js';
import { APP_ENV } from '../config/config.module.js';
import { DrizzleEventLog } from './drizzle-event-log.js';
import { schema } from './schema.js';

export const PG_POOL = 'PG_POOL';
export const DB = 'DB';
export type Database = NodePgDatabase<typeof schema>;

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [APP_ENV],
      useFactory: (env: ApiEnv) => new pg.Pool({ connectionString: env.DATABASE_URL }),
    },
    {
      provide: DB,
      inject: [PG_POOL],
      useFactory: (pool: pg.Pool): Database => drizzle(pool, { schema }),
    },
    {
      provide: EVENT_LOG,
      inject: [DB],
      useFactory: (db: Database) => new DrizzleEventLog(db),
    },
  ],
  exports: [PG_POOL, DB, EVENT_LOG],
})
export class DbModule implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
