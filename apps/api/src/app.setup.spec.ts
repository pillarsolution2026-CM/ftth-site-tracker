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
  const set = vi.fn();
  configureApp(
    { enableCors, set } as unknown as INestApplication,
    {
      NODE_ENV: nodeEnv,
      CORS_ORIGINS: ['http://localhost:3000'],
    } as ApiEnv,
  );
  return Object.assign(enableCors, { set });
}

describe('configureApp', () => {
  it('disables CORS credentials', () => {
    expect(run('development')).toHaveBeenCalledWith(
      expect.objectContaining({ credentials: false }),
    );
  });

  it('trusts only the loopback proxy for client IPs', () => {
    expect(run('production').set).toHaveBeenCalledWith('trust proxy', 'loopback');
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
