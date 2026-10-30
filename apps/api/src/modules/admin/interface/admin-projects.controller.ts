import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import {
  AssignmentListResponseSchema,
  AssignmentSchema,
  CreateAssignmentRequestSchema,
  CreateProjectRequestSchema,
  CreateZoneRequestSchema,
  ProjectListResponseSchema,
  ProjectSchema,
  UpdateProjectRequestSchema,
  ZoneListResponseSchema,
  ZoneSchema,
  type Assignment,
  type AssignmentListResponse,
  type CreateAssignmentRequest,
  type CreateProjectRequest,
  type CreateZoneRequest,
  type Project,
  type ProjectListResponse,
  type UpdateProjectRequest,
  type Zone,
  type ZoneListResponse,
} from '@ftth/shared';
import { actorIdOf } from '../../../common/http/request-actor.js';
import { UuidParamPipe } from '../../../common/http/uuid-param.pipe.js';
import { openApiSchema } from '../../../common/openapi.js';
import { ZodValidationPipe } from '../../../common/zod-validation.pipe.js';
import {
  CreateAssignmentUseCase,
  ListAssignmentsUseCase,
  RemoveAssignmentUseCase,
} from '../../identity/application/admin-assignments.use-cases.js';
import type { AuthenticatedRequest } from '../../identity/interface/auth-request.js';
import { JwtAuthGuard } from '../../identity/interface/jwt-auth.guard.js';
import { PlatformAdminGuard } from '../../identity/interface/platform-admin.guard.js';
import {
  CreateProjectUseCase,
  CreateZoneUseCase,
  ListProjectsUseCase,
  ListZonesUseCase,
  UpdateProjectUseCase,
} from '../../projects/application/admin-projects.use-cases.js';
import { toAssignmentDto } from './admin.presenter.js';

/** Platform-admin only (ADR-025): projects, zone names and assignments. */
@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin/projects')
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
export class AdminProjectsController {
  constructor(
    @Inject(ListProjectsUseCase) private readonly listProjects: ListProjectsUseCase,
    @Inject(CreateProjectUseCase) private readonly createProject: CreateProjectUseCase,
    @Inject(UpdateProjectUseCase) private readonly updateProject: UpdateProjectUseCase,
    @Inject(ListZonesUseCase) private readonly listZones: ListZonesUseCase,
    @Inject(CreateZoneUseCase) private readonly createZone: CreateZoneUseCase,
    @Inject(ListAssignmentsUseCase) private readonly listAssignments: ListAssignmentsUseCase,
    @Inject(CreateAssignmentUseCase) private readonly createAssignment: CreateAssignmentUseCase,
    @Inject(RemoveAssignmentUseCase) private readonly removeAssignment: RemoveAssignmentUseCase,
  ) {}

  @Get()
  @ApiOkResponse({ schema: openApiSchema(ProjectListResponseSchema) })
  async list(): Promise<ProjectListResponse> {
    return { items: await this.listProjects.execute() };
  }

  @Post()
  @ApiCreatedResponse({ schema: openApiSchema(ProjectSchema) })
  create(
    @Body(new ZodValidationPipe(CreateProjectRequestSchema)) body: CreateProjectRequest,
    @Req() request: AuthenticatedRequest,
  ): Promise<Project> {
    return this.createProject.execute(body, actorIdOf(request));
  }

  @Patch(':projectId')
  @ApiOkResponse({ schema: openApiSchema(ProjectSchema) })
  update(
    @Param('projectId', UuidParamPipe) projectId: string,
    @Body(new ZodValidationPipe(UpdateProjectRequestSchema)) body: UpdateProjectRequest,
    @Req() request: AuthenticatedRequest,
  ): Promise<Project> {
    return this.updateProject.execute({ ...body, projectId }, actorIdOf(request));
  }

  @Get(':projectId/zones')
  @ApiOkResponse({ schema: openApiSchema(ZoneListResponseSchema) })
  async zones(@Param('projectId', UuidParamPipe) projectId: string): Promise<ZoneListResponse> {
    return { items: await this.listZones.execute(projectId) };
  }

  @Post(':projectId/zones')
  @ApiCreatedResponse({ schema: openApiSchema(ZoneSchema) })
  addZone(
    @Param('projectId', UuidParamPipe) projectId: string,
    @Body(new ZodValidationPipe(CreateZoneRequestSchema)) body: CreateZoneRequest,
    @Req() request: AuthenticatedRequest,
  ): Promise<Zone> {
    return this.createZone.execute({ ...body, projectId }, actorIdOf(request));
  }

  @Get(':projectId/assignments')
  @ApiOkResponse({ schema: openApiSchema(AssignmentListResponseSchema) })
  async assignments(
    @Param('projectId', UuidParamPipe) projectId: string,
  ): Promise<AssignmentListResponse> {
    // Listing zones checks that the project exists (404 otherwise).
    await this.listZones.execute(projectId);
    return { items: (await this.listAssignments.execute(projectId)).map(toAssignmentDto) };
  }

  @Post(':projectId/assignments')
  @ApiCreatedResponse({ schema: openApiSchema(AssignmentSchema) })
  async assign(
    @Param('projectId', UuidParamPipe) projectId: string,
    @Body(new ZodValidationPipe(CreateAssignmentRequestSchema)) body: CreateAssignmentRequest,
    @Req() request: AuthenticatedRequest,
  ): Promise<Assignment> {
    return toAssignmentDto(
      await this.createAssignment.execute({ ...body, projectId }, actorIdOf(request)),
    );
  }

  @Delete(':projectId/assignments/:assignmentId')
  @HttpCode(204)
  unassign(
    @Param('projectId', UuidParamPipe) projectId: string,
    @Param('assignmentId', UuidParamPipe) assignmentId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    return this.removeAssignment.execute({ projectId, assignmentId }, actorIdOf(request));
  }
}
