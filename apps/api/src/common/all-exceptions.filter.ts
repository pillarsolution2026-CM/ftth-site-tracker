import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { ApiError, ErrorCode } from '@ftth/shared';
import type { Response } from 'express';
import { AppError, httpStatusFor } from './app-error.js';

function codeForHttpStatus(status: number): ErrorCode {
  if (status === 400 || status === 413 || status === 415 || status === 422) {
    return 'VALIDATION_FAILED';
  }
  if (status === 401) return 'TOKEN_INVALID';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 409) return 'CONFLICT';
  if (status === 429) return 'RATE_LIMITED';
  return 'INTERNAL';
}

/** Maps every thrown error to the `ApiError` contract {code, message, details}. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    let status: number;
    let body: ApiError;

    if (exception instanceof AppError) {
      status = exception.httpStatus;
      body = { code: exception.code, message: exception.message, details: exception.details };
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const code = codeForHttpStatus(status);
      body = { code, message: status < 500 ? exception.message : 'Internal server error' };
    } else {
      this.logger.error(
        exception instanceof Error ? (exception.stack ?? exception.message) : String(exception),
      );
      status = httpStatusFor('INTERNAL');
      body = { code: 'INTERNAL', message: 'Internal server error' };
    }
    response.status(status).json(body);
  }
}
