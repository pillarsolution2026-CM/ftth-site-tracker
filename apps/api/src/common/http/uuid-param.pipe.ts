import { Injectable, type PipeTransform } from '@nestjs/common';
import { z } from 'zod';
import { AppError } from '../app-error.js';

/** Route params that are ids: a malformed id is a client error, never a database error. */
@Injectable()
export class UuidParamPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    const parsed = z.uuid().safeParse(value);
    if (!parsed.success) throw new AppError('VALIDATION_FAILED', 'Identifier must be a UUID');
    return parsed.data;
  }
}
