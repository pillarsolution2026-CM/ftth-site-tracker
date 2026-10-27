import type { ApiResponseSchemaHost } from '@nestjs/swagger';
import { z, type ZodType } from 'zod';

type OpenApiSchema = ApiResponseSchemaHost['schema'];

/** OpenAPI schema generated from a shared Zod contract (single source of truth). */
export function openApiSchema(schema: ZodType): OpenApiSchema {
  const json = z.toJSONSchema(schema, { io: 'output', unrepresentable: 'any' });
  delete json.$schema;
  return json as OpenApiSchema;
}
