import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import {
  AdminUserSchema,
  CreateUserRequestSchema,
  UserListResponseSchema,
  type AdminUser,
  type CreateUserRequest,
  type UserListResponse,
} from '@ftth/shared';
import { actorIdOf } from '../../../common/http/request-actor.js';
import { UuidParamPipe } from '../../../common/http/uuid-param.pipe.js';
import { openApiSchema } from '../../../common/openapi.js';
import { ZodValidationPipe } from '../../../common/zod-validation.pipe.js';
import {
  CreateUserUseCase,
  ListUsersUseCase,
  SetUserActiveUseCase,
} from '../../identity/application/admin-users.use-cases.js';
import type { AuthenticatedRequest } from '../../identity/interface/auth-request.js';
import { JwtAuthGuard } from '../../identity/interface/jwt-auth.guard.js';
import { PlatformAdminGuard } from '../../identity/interface/platform-admin.guard.js';
import { toAdminUserDto } from './admin.presenter.js';

/** Platform-admin only (ADR-025). Creates non-admin users; admins come from the CLI only. */
@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin/users')
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
export class AdminUsersController {
  constructor(
    @Inject(ListUsersUseCase) private readonly list: ListUsersUseCase,
    @Inject(CreateUserUseCase) private readonly create: CreateUserUseCase,
    @Inject(SetUserActiveUseCase) private readonly setActive: SetUserActiveUseCase,
  ) {}

  @Get()
  @ApiOkResponse({ schema: openApiSchema(UserListResponseSchema) })
  async listAll(): Promise<UserListResponse> {
    return { items: (await this.list.execute()).map(toAdminUserDto) };
  }

  @Post()
  @ApiCreatedResponse({ schema: openApiSchema(AdminUserSchema) })
  async createOne(
    @Body(new ZodValidationPipe(CreateUserRequestSchema)) body: CreateUserRequest,
    @Req() request: AuthenticatedRequest,
  ): Promise<AdminUser> {
    return toAdminUserDto(await this.create.execute(body, actorIdOf(request)));
  }

  @Post(':userId/deactivate')
  @HttpCode(200)
  @ApiOkResponse({ schema: openApiSchema(AdminUserSchema) })
  async deactivate(
    @Param('userId', UuidParamPipe) userId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<AdminUser> {
    return toAdminUserDto(
      await this.setActive.execute({ userId, active: false }, actorIdOf(request)),
    );
  }

  @Post(':userId/reactivate')
  @HttpCode(200)
  @ApiOkResponse({ schema: openApiSchema(AdminUserSchema) })
  async reactivate(
    @Param('userId', UuidParamPipe) userId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<AdminUser> {
    return toAdminUserDto(
      await this.setActive.execute({ userId, active: true }, actorIdOf(request)),
    );
  }
}
