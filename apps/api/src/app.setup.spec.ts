import type { INestApplication } from '@nestjs/common';
import type { ApiEnv } from '@ftth/shared';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@nestjs/swagger', () => ({
  DocumentBuilder: class {
    setTitle() {
      return this;
    }
    setVersion() {
      return this;
    }
    addBearerAuth() {
      return this;
    }
    build() {
      return {};
    }
  },
  SwaggerModule: { createDocument: vi.fn(() => ({})), setup: vi.fn() },
}));

import { SwaggerModule } from '@nestjs/swagger';
import { configureApp } from './app.setup.js';

function run(nodeEnv: ApiEnv['NODE_ENV']) {
  const enableCors = vi.fn();
  configureApp(
    { enableCors } as unknown as INestApplication,
    {
      NODE_ENV: nodeEnv,
      CORS_ORIGINS: ['http://localhost:3000'],
    } as ApiEnv,
  );
  return enableCors;
}

describe('configureApp', () => {
  it('disables CORS credentials', () => {
    expect(run('development')).toHaveBeenCalledWith(
      expect.objectContaining({ credentials: false }),
    );
  });

  it('serves /docs outside production only', () => {
    vi.mocked(SwaggerModule.setup).mockClear();
    run('development');
    expect(SwaggerModule.setup).toHaveBeenCalledTimes(1);
    vi.mocked(SwaggerModule.setup).mockClear();
    run('production');
    expect(SwaggerModule.setup).not.toHaveBeenCalled();
  });
});
