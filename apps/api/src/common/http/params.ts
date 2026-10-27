import { Param } from '@nestjs/common';

/** `:projectId` of the route; ProjectScopeGuard has already validated it as a UUID. */
export const ProjectIdParam = () => Param('projectId');
