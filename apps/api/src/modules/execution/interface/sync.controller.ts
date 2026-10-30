import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import {
  EXECUTION_LIMITS,
  OfflineBundleSchema,
  PhotoUploadStatusSchema,
  SyncChangesQuerySchema,
  SyncChangesResponseSchema,
  SyncPushRequestSchema,
  SyncPushResponseSchema,
  UPLOAD_OFFSET_HEADER,
  type OfflineBundle,
  type Permission,
  type PhotoUploadStatus,
  type SyncChangesQuery,
  type SyncChangesResponse,
  type SyncPushRequest,
  type SyncPushResponse,
} from '@ftth/shared';
import { AppError } from '../../../common/app-error.js';
import type { Clock } from '../../../common/clock.js';
import { ProjectIdParam } from '../../../common/http/params.js';
import { actorIdOf } from '../../../common/http/request-actor.js';
import { UuidParamPipe } from '../../../common/http/uuid-param.pipe.js';
import { openApiSchema } from '../../../common/openapi.js';
import { PermissionGuard, RequirePermission } from '../../../common/permission.guard.js';
import { ZodValidationPipe } from '../../../common/zod-validation.pipe.js';
import { scopeForPermission } from '../../identity/domain/membership.js';
import type { AuthenticatedRequest } from '../../identity/interface/auth-request.js';
import { JwtAuthGuard } from '../../identity/interface/jwt-auth.guard.js';
import { ProjectScopeGuard } from '../../identity/interface/project-scope.guard.js';
import type { ExecutionScope } from '../application/ports.js';
import {
  GetPhotoUploadStatusUseCase,
  PutPhotoChunkUseCase,
} from '../application/photo-upload.use-cases.js';
import { PushSyncUseCase } from '../application/push-sync.use-case.js';
import {
  GetOfflineBundleUseCase,
  GetSyncChangesUseCase,
} from '../application/sync-queries.use-cases.js';
import { EXECUTION_CLOCK } from '../execution.tokens.js';
import { SyncRateLimit, SyncRateLimitGuard } from './sync-rate-limit.guard.js';

/** The caller's reach for `permission` (per assignment: a read-only role never widens writes). */
function scopeOf(request: AuthenticatedRequest, permission: Permission): ExecutionScope {
  const access = request.projectAccess;
  if (!access) throw new AppError('FORBIDDEN', 'No access to this project');
  const scope = scopeForPermission(access, permission, request.auth?.isAdmin === true);
  if (!scope) throw new AppError('FORBIDDEN', 'Your role does not allow this action');
  return scope.kind === 'project' ? { kind: 'project' } : { kind: 'zones', zoneIds: scope.zoneIds };
}

/** UUIDs are compared as text in places (stored results, storage keys): one canonical case. */
const canonical = (uuid: string): string => uuid.toLowerCase();

/** Reads a raw chunk, refusing more than `max` bytes without buffering them. */
async function readChunk(request: AuthenticatedRequest, max: number): Promise<Buffer> {
  const declared = Number(request.headers['content-length'] ?? NaN);
  if (Number.isFinite(declared) && declared > max) {
    throw new AppError('FILE_TOO_LARGE', `A chunk may carry at most ${max} bytes`);
  }
  const parts: Buffer[] = [];
  let total = 0;
  for await (const part of request) {
    const buffer = part as Buffer;
    total += buffer.length;
    if (total > max) throw new AppError('FILE_TOO_LARGE', `A chunk may carry at most ${max} bytes`);
    parts.push(buffer);
  }
  return Buffer.concat(parts);
}

const OFFSET_PATTERN = /^(0|[1-9]\d{0,9})$/;

@ApiTags('sync')
@ApiBearerAuth()
@Controller('projects/:projectId/sync')
@UseGuards(JwtAuthGuard, SyncRateLimitGuard, ProjectScopeGuard, PermissionGuard)
export class SyncController {
  constructor(
    @Inject(PushSyncUseCase) private readonly push: PushSyncUseCase,
    @Inject(GetOfflineBundleUseCase) private readonly bundle: GetOfflineBundleUseCase,
    @Inject(GetSyncChangesUseCase) private readonly changes: GetSyncChangesUseCase,
    @Inject(GetPhotoUploadStatusUseCase) private readonly photoStatus: GetPhotoUploadStatusUseCase,
    @Inject(PutPhotoChunkUseCase) private readonly photoChunk: PutPhotoChunkUseCase,
    @Inject(EXECUTION_CLOCK) private readonly clock: Clock,
  ) {}

  @Post('push')
  @SyncRateLimit('sync')
  @HttpCode(200)
  @RequirePermission('execution:write')
  @ApiOkResponse({ schema: openApiSchema(SyncPushResponseSchema) })
  async pushOps(
    @ProjectIdParam() projectId: string,
    @Body(new ZodValidationPipe(SyncPushRequestSchema)) body: SyncPushRequest,
    @Req() request: AuthenticatedRequest,
  ): Promise<SyncPushResponse> {
    const results = await this.push.execute({
      projectId: canonical(projectId),
      userId: actorIdOf(request),
      deviceId: canonical(body.deviceId),
      scope: scopeOf(request, 'execution:write'),
      ops: body.ops,
    });
    return { serverTime: this.clock.now().toISOString(), results };
  }

  @Get('bootstrap')
  @SyncRateLimit('sync')
  @RequirePermission('execution:read')
  @ApiOkResponse({ schema: openApiSchema(OfflineBundleSchema) })
  getBundle(
    @ProjectIdParam() projectId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<OfflineBundle> {
    return this.bundle.execute({
      projectId: canonical(projectId),
      scope: scopeOf(request, 'execution:read'),
    });
  }

  @Get('changes')
  @SyncRateLimit('sync')
  @RequirePermission('execution:read')
  @ApiOkResponse({ schema: openApiSchema(SyncChangesResponseSchema) })
  getChanges(
    @ProjectIdParam() projectId: string,
    @Query(new ZodValidationPipe(SyncChangesQuerySchema)) query: SyncChangesQuery,
    @Req() request: AuthenticatedRequest,
  ): Promise<SyncChangesResponse> {
    return this.changes.execute({
      projectId: canonical(projectId),
      scope: scopeOf(request, 'execution:read'),
      ...query,
    });
  }

  @Get('photos/:photoId')
  @SyncRateLimit('upload')
  @RequirePermission('execution:write')
  @ApiOkResponse({ schema: openApiSchema(PhotoUploadStatusSchema) })
  getPhoto(
    @ProjectIdParam() projectId: string,
    @Param('photoId', UuidParamPipe) photoId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<PhotoUploadStatus> {
    return this.photoStatus.execute({
      projectId: canonical(projectId),
      userId: actorIdOf(request),
      photoId: canonical(photoId),
    });
  }

  @Put('photos/:photoId/content')
  @SyncRateLimit('upload')
  @RequirePermission('execution:write')
  @ApiOkResponse({ schema: openApiSchema(PhotoUploadStatusSchema) })
  async putPhotoChunk(
    @ProjectIdParam() projectId: string,
    @Param('photoId', UuidParamPipe) photoId: string,
    @Headers(UPLOAD_OFFSET_HEADER) offsetHeader: string | undefined,
    @Headers('content-type') contentType: string | undefined,
    @Req() request: AuthenticatedRequest,
  ): Promise<PhotoUploadStatus> {
    if (contentType?.split(';')[0]?.trim().toLowerCase() !== 'application/octet-stream') {
      throw new AppError('UNSUPPORTED_FILE', 'Chunks must be application/octet-stream');
    }
    if (!offsetHeader || !OFFSET_PATTERN.test(offsetHeader)) {
      throw new AppError('VALIDATION_FAILED', 'Upload-Offset header is required');
    }
    const userId = actorIdOf(request);
    const data = await readChunk(request, EXECUTION_LIMITS.maxChunkBytes);
    return this.photoChunk.execute({
      projectId: canonical(projectId),
      userId,
      photoId: canonical(photoId),
      offset: Number(offsetHeader),
      data,
    });
  }
}
