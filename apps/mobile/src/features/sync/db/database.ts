import { Database, type DatabaseAdapter } from '@nozbe/watermelondb';
import { modelClasses } from './models';

export function createLocalDatabase(adapter: DatabaseAdapter): Database {
  return new Database({ adapter, modelClasses });
}
