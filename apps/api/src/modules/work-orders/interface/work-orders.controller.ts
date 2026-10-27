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
  AddWorkOrderItemRequestSchema,
  CreateWorkOrderRequestSchema,
  UpdateWorkOrderItemRequestSchema,
  UpdateWorkOrderRequestSchema,
  WorkOrderDetailSchema,
  WorkOrderItemSchema,
  WorkOrderListResponseSchema,
  type AddWorkOrderItemRequest,
  type CreateWorkOrderRequest,
  type UpdateWorkOrderItemRequest,
  type UpdateWorkOrderRequest,
  type WorkOrderDetail,
  type WorkOrderItem,
  type WorkOrderListResponse,
} from '@ftth/shared';
import { actorIdOf } from '../../../common/http/request-actor.js';
import { ProjectIdParam } from '../../../common/http/params.js';
import { UuidParamPipe } from '../../../common/http/uuid-param.pipe.js';
import { openApiSchema } from '../../../common/openapi.js';
import { PermissionGuard, RequirePermission } from '../../../common/permission.guard.js';
import { ZodValidationPipe } from '../../../common/zod-validation.pipe.js';
import { JwtAuthGuard } from '../../identity/interface/jwt-auth.guard.js';
import type { AuthenticatedRequest } from '../../identity/interface/auth-request.js';
import { ProjectScopeGuard } from '../../identity/interface/project-scope.guard.js';
import { CreateWorkOrderUseCase } from '../application/create-work-order.use-case.js';
import { DeleteWorkOrderUseCase } from '../application/delete-work-order.use-case.js';
import { UpdateWorkOrderUseCase } from '../application/update-work-order.use-case.js';
import {
  AddWorkOrderItemUseCase,
  RemoveWorkOrderItemUseCase,
  UpdateWorkOrderItemUseCase,
} from '../application/work-order-item.use-cases.js';
import { GetWorkOrderUseCase, ListWorkOrdersUseCase } from '../application/work-order-queries.js';
import { toDetailDto, toItemDto, toSummaryDto } from './work-order.presenter.js';

@ApiTags('work-orders')
@ApiBearerAuth()
@Controller('projects/:projectId/work-orders')
@UseGuards(JwtAuthGuard, ProjectScopeGuard, PermissionGuard)
export class WorkOrdersController {
  constructor(
    @Inject(ListWorkOrdersUseCase) private readonly list: ListWorkOrdersUseCase,
    @Inject(GetWorkOrderUseCase) private readonly get: GetWorkOrderUseCase,
    @Inject(CreateWorkOrderUseCase) private readonly create: CreateWorkOrderUseCase,
    @Inject(UpdateWorkOrderUseCase) private readonly update: UpdateWorkOrderUseCase,
    @Inject(DeleteWorkOrderUseCase) private readonly remove: DeleteWorkOrderUseCase,
    @Inject(AddWorkOrderItemUseCase) private readonly addItem: AddWorkOrderItemUseCase,
    @Inject(UpdateWorkOrderItemUseCase) private readonly updateItem: UpdateWorkOrderItemUseCase,
    @Inject(RemoveWorkOrderItemUseCase) private readonly removeItem: RemoveWorkOrderItemUseCase,
  ) {}

  @Get()
  @RequirePermission('work_orders:read')
  @ApiOkResponse({ schema: openApiSchema(WorkOrderListResponseSchema) })
  async listAll(@ProjectIdParam() project: string): Promise<WorkOrderListResponse> {
    return { items: (await this.list.execute(project)).map(toSummaryDto) };
  }

  @Post()
  @RequirePermission('work_orders:write')
  @ApiCreatedResponse({ schema: openApiSchema(WorkOrderDetailSchema) })
  async createOne(
    @ProjectIdParam() project: string,
    @Body(new ZodValidationPipe(CreateWorkOrderRequestSchema)) body: CreateWorkOrderRequest,
    @Req() request: AuthenticatedRequest,
  ): Promise<WorkOrderDetail> {
    const view = await this.create.execute({
      projectId: project,
      actorId: actorIdOf(request),
      request: body,
    });
    return toDetailDto(view);
  }

  @Get(':workOrderId')
  @RequirePermission('work_orders:read')
  @ApiOkResponse({ schema: openApiSchema(WorkOrderDetailSchema) })
  async getOne(
    @ProjectIdParam() project: string,
    @Param('workOrderId', UuidParamPipe) workOrderId: string,
  ): Promise<WorkOrderDetail> {
    return toDetailDto(await this.get.execute(project, workOrderId));
  }

  @Patch(':workOrderId')
  @RequirePermission('work_orders:write')
  @ApiOkResponse({ schema: openApiSchema(WorkOrderDetailSchema) })
  async updateOne(
    @ProjectIdParam() project: string,
    @Param('workOrderId', UuidParamPipe) workOrderId: string,
    @Body(new ZodValidationPipe(UpdateWorkOrderRequestSchema)) body: UpdateWorkOrderRequest,
    @Req() request: AuthenticatedRequest,
  ): Promise<WorkOrderDetail> {
    const view = await this.update.execute({
      projectId: project,
      workOrderId,
      actorId: actorIdOf(request),
      request: body,
    });
    return toDetailDto(view);
  }

  @Delete(':workOrderId')
  @HttpCode(204)
  @RequirePermission('work_orders:write')
  async deleteOne(
    @ProjectIdParam() project: string,
    @Param('workOrderId', UuidParamPipe) workOrderId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    await this.remove.execute({ projectId: project, workOrderId, actorId: actorIdOf(request) });
  }

  @Post(':workOrderId/items')
  @RequirePermission('work_orders:write')
  @ApiCreatedResponse({ schema: openApiSchema(WorkOrderItemSchema) })
  async addOneItem(
    @ProjectIdParam() project: string,
    @Param('workOrderId', UuidParamPipe) workOrderId: string,
    @Body(new ZodValidationPipe(AddWorkOrderItemRequestSchema)) body: AddWorkOrderItemRequest,
    @Req() request: AuthenticatedRequest,
  ): Promise<WorkOrderItem> {
    const item = await this.addItem.execute({
      projectId: project,
      workOrderId,
      actorId: actorIdOf(request),
      request: body,
    });
    return toItemDto(item, workOrderId);
  }

  @Patch(':workOrderId/items/:itemId')
  @RequirePermission('work_orders:write')
  @ApiOkResponse({ schema: openApiSchema(WorkOrderItemSchema) })
  async updateOneItem(
    @ProjectIdParam() project: string,
    @Param('workOrderId', UuidParamPipe) workOrderId: string,
    @Param('itemId', UuidParamPipe) itemId: string,
    @Body(new ZodValidationPipe(UpdateWorkOrderItemRequestSchema)) body: UpdateWorkOrderItemRequest,
    @Req() request: AuthenticatedRequest,
  ): Promise<WorkOrderItem> {
    const item = await this.updateItem.execute({
      projectId: project,
      workOrderId,
      itemId,
      actorId: actorIdOf(request),
      request: body,
    });
    return toItemDto(item, workOrderId);
  }

  @Delete(':workOrderId/items/:itemId')
  @HttpCode(204)
  @RequirePermission('work_orders:write')
  async removeOneItem(
    @ProjectIdParam() project: string,
    @Param('workOrderId', UuidParamPipe) workOrderId: string,
    @Param('itemId', UuidParamPipe) itemId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    await this.removeItem.execute({
      projectId: project,
      workOrderId,
      itemId,
      actorId: actorIdOf(request),
    });
  }
}
