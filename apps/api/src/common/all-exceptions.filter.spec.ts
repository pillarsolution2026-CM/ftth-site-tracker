import { BadRequestException, type ArgumentsHost, HttpException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { AllExceptionsFilter } from './all-exceptions.filter.js';
import { AppError } from './app-error.js';

function run(exception: unknown): { status: number; body: unknown } {
  const json = vi.fn<(body: unknown) => void>();
  const status = vi.fn<(code: number) => { json: typeof json }>(() => ({ json }));
  const host = { switchToHttp: () => ({ getResponse: () => ({ status }) }) } as ArgumentsHost;
  new AllExceptionsFilter().catch(exception, host);
  return { status: status.mock.calls[0]?.[0] ?? 0, body: json.mock.calls[0]?.[0] };
}

describe('AllExceptionsFilter', () => {
  it('maps HTTP 413 and 415 to FILE_TOO_LARGE and UNSUPPORTED_FILE', () => {
    expect(run(new HttpException('Payload Too Large', 413))).toMatchObject({
      status: 413,
      body: { code: 'FILE_TOO_LARGE' },
    });
    expect(run(new HttpException('Unsupported Media Type', 415))).toMatchObject({
      status: 415,
      body: { code: 'UNSUPPORTED_FILE' },
    });
  });

  it('maps body-parser style errors (plain Error with a 4xx status) the same way', () => {
    const tooLarge = Object.assign(new Error('request entity too large'), { status: 413 });
    expect(run(tooLarge)).toMatchObject({ status: 413, body: { code: 'FILE_TOO_LARGE' } });
    const malformed = Object.assign(new Error('Unexpected token'), { status: 400 });
    expect(run(malformed)).toMatchObject({ status: 400, body: { code: 'VALIDATION_FAILED' } });
  });

  it('keeps the existing mappings', () => {
    expect(run(new BadRequestException('x')).body).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(run(new AppError('IMPORT_INVALID', 'm', { reason: 'FILE_CHANGED' }))).toEqual({
      status: 422,
      body: { code: 'IMPORT_INVALID', message: 'm', details: { reason: 'FILE_CHANGED' } },
    });
    expect(run(new Error('boom'))).toMatchObject({ status: 500, body: { code: 'INTERNAL' } });
  });
});
