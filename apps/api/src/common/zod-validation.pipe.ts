import { Injectable, type PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';
import { AppError } from './app-error.js';

@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new AppError(
        'VALIDATION_FAILED',
        'Request validation failed',
        result.error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
      );
    }
    return result.data;
  }
}
