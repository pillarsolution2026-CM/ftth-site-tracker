import { Model } from '@nozbe/watermelondb';
import { TABLES } from './schema';

/**
 * Plain models without decorators (no Babel decorator plugin needed): fields are read and
 * written through `_getRaw` / `_setRaw`, which is what the decorators do underneath.
 */
export class OutboxOpRecord extends Model {
  static override table = TABLES.outbox;
}

export class LocalPhotoRecord extends Model {
  static override table = TABLES.photos;
}

export class RemoteUpdateRecord extends Model {
  static override table = TABLES.remoteUpdates;
}

export class RemoteAsBuiltEditRecord extends Model {
  static override table = TABLES.remoteAsBuilt;
}

export class KeyValueRecord extends Model {
  static override table = TABLES.keyValue;
}

export const modelClasses = [
  OutboxOpRecord,
  LocalPhotoRecord,
  RemoteUpdateRecord,
  RemoteAsBuiltEditRecord,
  KeyValueRecord,
];

export function str(record: Model, column: string): string {
  const value = record._getRaw(column);
  return typeof value === 'string' ? value : '';
}

export function optionalStr(record: Model, column: string): string | null {
  const value = record._getRaw(column);
  return typeof value === 'string' && value !== '' ? value : null;
}

export function num(record: Model, column: string): number {
  const value = record._getRaw(column);
  return typeof value === 'number' ? value : 0;
}
