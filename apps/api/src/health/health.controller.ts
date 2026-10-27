import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { ApiEnv } from '@ftth/shared';
import { APP_ENV } from '../config/config.module.js';
import { PG_POOL } from '../db/db.module.js';
import type pg from 'pg';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    @Inject(APP_ENV) private readonly env: ApiEnv,
  ) {}

  @Get()
  async check(): Promise<{ status: 'ok'; db: 'ok'; version: string }> {
    try {
      await this.pool.query('SELECT 1');
    } catch {
      throw new ServiceUnavailableException();
    }
    return { status: 'ok', db: 'ok', version: this.env.APP_VERSION };
  }
}
