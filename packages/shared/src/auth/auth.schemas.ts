import { z } from 'zod';
import { RoleSchema } from './roles.js';

export const LoginRequestSchema = z.object({
  email: z.email().max(254),
  password: z.string().min(8).max(128),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const RefreshRequestSchema = z.object({
  refreshToken: z.string().min(32).max(512),
});
export type RefreshRequest = z.infer<typeof RefreshRequestSchema>;

export const TokenPairSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  /** Access token lifetime in seconds. */
  expiresIn: z.number().int().positive(),
});
export type TokenPair = z.infer<typeof TokenPairSchema>;

export const ProjectMembershipSchema = z.object({
  projectId: z.uuid(),
  projectName: z.string(),
  role: RoleSchema,
  /** Empty when the role is project-wide. */
  zoneIds: z.array(z.uuid()),
});
export type ProjectMembership = z.infer<typeof ProjectMembershipSchema>;

export const MeResponseSchema = z.object({
  id: z.uuid(),
  email: z.email(),
  displayName: z.string(),
  locale: z.enum(['ar', 'en', 'fr']),
  isAdmin: z.boolean(),
  memberships: z.array(ProjectMembershipSchema),
});
export type MeResponse = z.infer<typeof MeResponseSchema>;

/** Claims carried inside the access token. Kept minimal: memberships are resolved per request. */
export const AccessTokenClaimsSchema = z.object({
  sub: z.uuid(),
  isAdmin: z.boolean(),
});
export type AccessTokenClaims = z.infer<typeof AccessTokenClaimsSchema>;
