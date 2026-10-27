import { Logger } from '@nestjs/common';
import type { ObjectStorage } from '../object-storage.port.js';

const logger = new Logger('ObjectStorage');

/**
 * Best-effort delete of an object no database row needs (any more). A failure leaves an orphan
 * file, which is harmless, so it is logged and never rethrown over the real outcome.
 */
export async function discardObject(storage: ObjectStorage, key: string): Promise<void> {
  await storage.delete(key).catch((error: unknown) => {
    logger.warn(`Could not delete stored object ${key}: ${String(error)}`);
  });
}
