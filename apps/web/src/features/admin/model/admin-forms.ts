import {
  CreateAssignmentRequestSchema,
  CreateProjectRequestSchema,
  CreateUserRequestSchema,
  isZoneScopedRole,
  type AssignableRole,
  type CreateAssignmentInput,
  type CreateProjectRequest,
  type CreateUserInput,
  type Locale,
  type Project,
} from '@ftth/shared';
import type { MessageKey } from '@ftth/i18n';

/** Result of validating a form against its shared request schema. */
export type FormResult<T, F extends string> =
  { ok: true; payload: T } | { ok: false; errors: Partial<Record<F, MessageKey>> };

// ---------------------------------------------------------------------------------------------
// Project
// ---------------------------------------------------------------------------------------------

export type ProjectField = 'name' | 'client' | 'crsEpsg' | 'currency' | 'locale';
export type ProjectFormValues = Record<ProjectField, string>;

/** Used only when no project exists yet: the values the first (seed) project uses. */
const FIRST_PROJECT_DEFAULTS = { crsEpsg: '32636', currency: 'EGP', locale: 'ar' } as const;

function mostCommon(values: readonly string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

/**
 * Values the existing projects use, offered as suggestions; the admin may type others. The most
 * common one pre-fills the field. The client is never pre-filled.
 */
export function projectSuggestions(projects: readonly Project[]) {
  const epsg = projects.map((project) => String(project.crsEpsg));
  const currencies = projects.map((project) => project.currency);
  const locales = projects.map((project) => project.locale);
  return {
    crsEpsg: [...new Set(epsg)],
    currency: [...new Set(currencies)],
    clients: [...new Set(projects.map((project) => project.client))],
    initial: {
      name: '',
      client: '',
      crsEpsg: mostCommon(epsg) ?? FIRST_PROJECT_DEFAULTS.crsEpsg,
      currency: mostCommon(currencies) ?? FIRST_PROJECT_DEFAULTS.currency,
      locale: mostCommon(locales) ?? FIRST_PROJECT_DEFAULTS.locale,
    } satisfies ProjectFormValues,
  };
}

const PROJECT_MESSAGES: Record<ProjectField, MessageKey> = {
  name: 'validation.required',
  client: 'validation.required',
  crsEpsg: 'admin.validation.crs',
  currency: 'admin.validation.currency',
  locale: 'admin.validation.invalid',
};

function fieldErrors<F extends string>(
  issues: readonly { path: readonly PropertyKey[] }[],
  messages: Record<F, MessageKey>,
): Partial<Record<F, MessageKey>> {
  const errors: Partial<Record<F, MessageKey>> = {};
  for (const issue of issues) {
    const field = issue.path[0];
    if (typeof field === 'string' && field in messages) {
      errors[field as F] ??= messages[field as F];
    }
  }
  return errors;
}

export function validateProjectForm(
  values: ProjectFormValues,
): FormResult<CreateProjectRequest, ProjectField> {
  const epsg = values.crsEpsg.trim();
  const parsed = CreateProjectRequestSchema.safeParse({
    ...values,
    crsEpsg: /^\d{1,6}$/.test(epsg) ? Number(epsg) : NaN,
    currency: values.currency.trim().toUpperCase(),
  });
  return parsed.success
    ? { ok: true, payload: parsed.data }
    : { ok: false, errors: fieldErrors(parsed.error.issues, PROJECT_MESSAGES) };
}

// ---------------------------------------------------------------------------------------------
// User
// ---------------------------------------------------------------------------------------------

export type UserField = 'email' | 'displayName' | 'password' | 'locale';
export type UserFormValues = Record<UserField, string>;

export const EMPTY_USER_FORM: UserFormValues = {
  email: '',
  displayName: '',
  password: '',
  locale: 'ar',
};

const USER_MESSAGES: Record<UserField, MessageKey> = {
  email: 'admin.validation.email',
  displayName: 'validation.required',
  password: 'admin.validation.password',
  locale: 'admin.validation.invalid',
};

export function validateUserForm(values: UserFormValues): FormResult<CreateUserInput, UserField> {
  const input = { ...values, email: values.email.trim(), locale: values.locale as Locale };
  const parsed = CreateUserRequestSchema.safeParse(input);
  // Send the input (not the transformed output) so the API applies the same transforms.
  return parsed.success
    ? { ok: true, payload: input }
    : { ok: false, errors: fieldErrors(parsed.error.issues, USER_MESSAGES) };
}

// ---------------------------------------------------------------------------------------------
// Assignment
// ---------------------------------------------------------------------------------------------

export type AssignmentField = 'userId' | 'role' | 'zoneId';
export interface AssignmentFormValues {
  userId: string;
  role: AssignableRole;
  zoneId: string;
}

export const EMPTY_ASSIGNMENT_FORM: AssignmentFormValues = { userId: '', role: 'pm', zoneId: '' };

export const needsZone = (role: AssignableRole): boolean => isZoneScopedRole(role);

const ASSIGNMENT_MESSAGES: Record<AssignmentField, MessageKey> = {
  userId: 'validation.required',
  role: 'admin.validation.invalid',
  zoneId: 'admin.assignments.zoneRequired',
};

export function validateAssignmentForm(
  values: AssignmentFormValues,
): FormResult<CreateAssignmentInput, AssignmentField> {
  const input: CreateAssignmentInput = {
    userId: values.userId,
    role: values.role,
    // A project-wide role never sends a zone, even if one was picked before the role changed.
    zoneId: needsZone(values.role) && values.zoneId ? values.zoneId : null,
  };
  const parsed = CreateAssignmentRequestSchema.safeParse(input);
  return parsed.success
    ? { ok: true, payload: input }
    : { ok: false, errors: fieldErrors(parsed.error.issues, ASSIGNMENT_MESSAGES) };
}

/** API `details.reason` → message, for the 400/409 answers of the admin routes. */
export const REASON_MESSAGES: Readonly<Record<string, MessageKey>> = {
  EMAIL_TAKEN: 'admin.users.emailTaken',
  ZONE_NAME_TAKEN: 'admin.zones.nameTaken',
  ALREADY_ASSIGNED: 'admin.assignments.alreadyAssigned',
  USER_INACTIVE: 'admin.assignments.userInactive',
  USER_IS_ADMIN: 'admin.assignments.userIsAdmin',
  ZONE_NOT_IN_PROJECT: 'admin.assignments.zoneNotInProject',
};
