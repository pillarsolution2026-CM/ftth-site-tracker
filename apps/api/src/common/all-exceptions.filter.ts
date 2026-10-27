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
  if (status === 413) return 'FILE_TOO_LARGE';
  if (status === 415) return 'UNSUPPORTED_FILE';
  if (status === 400 || status === 422) {
    return 'VALIDATION_FAILED';
  }
  if (status === 401) return 'TOKEN_INVALID';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 409) return 'CONFLICT';
  if (status === 429) return 'RATE_LIMITED';
  return 'INTERNAL';
}

function isClientHttpError(error: unknown): error is Error & { status: number } {
  if (!(error instanceof Error)) return false;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' && status >= 400 && status < 500;
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
    } else if (isClientHttpError(exception)) {
      // body-parser / raw-body errors (e.g. JSON larger than the limit) are plain http-errors.
      status = exception.status;
      body = { code: codeForHttpStatus(status), message: exception.message };
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
