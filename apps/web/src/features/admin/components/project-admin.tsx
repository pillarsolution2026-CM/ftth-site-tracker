'use client';

import Link from 'next/link';
import { ASSIGNABLE_ROLES, type AssignableRole } from '@ftth/shared';
import { Button } from '@/shared/ui/button';
import { Card } from '@/shared/ui/card';
import { Select } from '@/shared/ui/form-controls';
import { Input } from '@/shared/ui/input';
import { Ltr } from '@/shared/ui/ltr';
import { Notice } from '@/shared/ui/notice';
import { PageHeader, Table, Td, Th } from '@/shared/ui/table';
import { useI18n } from '@/shared/i18n/locale-provider';
import { useProjectAdmin, type ProjectAdminModel } from '../hooks/use-project-admin';
import { needsZone } from '../model/admin-forms';
import { ProjectFields } from './project-fields';

const LINK =
  'inline-flex min-h-11 items-center text-(--color-brand) underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-focus)';
const NO_SUGGESTIONS = { crsEpsg: [], currency: [], clients: [] };

function EditProjectCard({ edit }: { edit: ProjectAdminModel['edit'] }) {
  const { t } = useI18n();
  if (!edit.values) return null;
  return (
    <Card>
      <h2 className="mb-4 text-lg font-semibold">{t('admin.project.edit')}</h2>
      <form noValidate onSubmit={edit.onSubmit} className="flex flex-col gap-4">
        <ProjectFields
          idPrefix="project-edit"
          values={edit.values}
          errors={edit.errors}
          suggestions={NO_SUGGESTIONS}
          fixedCrsAndCurrency
          onChange={edit.onChange}
        />
        <Notice kind="info" live={false}>
          {t('admin.project.fixed')}
        </Notice>
        {edit.error ? <Notice kind="error">{t(edit.error)}</Notice> : null}
        {edit.saved ? <Notice kind="success">{t('admin.project.saved')}</Notice> : null}
        <div>
          <Button type="submit" disabled={edit.pending}>
            {edit.pending ? t('common.saving') : t('common.save')}
          </Button>
        </div>
      </form>
    </Card>
  );
}

function ZonesCard({ zones }: { zones: ProjectAdminModel['zones'] }) {
  const { t } = useI18n();
  return (
    <Card>
      <h2 className="mb-4 text-lg font-semibold">{t('admin.zones.title')}</h2>
      {zones.loading ? (
        <p role="status">{t('common.loading')}</p>
      ) : zones.items.length === 0 ? (
        <p className="mb-4">{t('admin.zones.none')}</p>
      ) : (
        <ul className="mb-4 divide-y divide-(--color-border)">
          {zones.items.map((zone) => (
            <li key={zone.id} className="flex min-h-11 flex-wrap items-center gap-3 py-2">
              <span className="font-medium">{zone.name}</span>
              {zone.hasBoundary ? null : (
                <span className="text-sm opacity-80">{t('admin.zones.noBoundary')}</span>
              )}
            </li>
          ))}
        </ul>
      )}
      <form noValidate onSubmit={zones.onSubmit} className="flex flex-wrap items-end gap-3">
        <div className="min-w-60 flex-1">
          <Input
            id="zone-name"
            label={t('admin.zones.name')}
            value={zones.name}
            maxLength={100}
            error={zones.error ? t(zones.error) : undefined}
            onChange={(event) => zones.onNameChange(event.target.value)}
          />
        </div>
        <Button type="submit" variant="outline" disabled={zones.pending}>
          {t('admin.zones.add')}
        </Button>
      </form>
    </Card>
  );
}

function AssignmentsCard({
  assignments,
  zones,
}: {
  assignments: ProjectAdminModel['assignments'];
  zones: ProjectAdminModel['zones'];
}) {
  const { t } = useI18n();
  const zoneNeeded = needsZone(assignments.values.role);
  return (
    <Card>
      <h2 className="mb-4 text-lg font-semibold">{t('admin.assignments.title')}</h2>
      {assignments.loading ? (
        <p role="status">{t('common.loading')}</p>
      ) : assignments.items.length === 0 ? (
        <p className="mb-4">{t('admin.assignments.none')}</p>
      ) : (
        <Table className="mb-4">
          <thead>
            <tr>
              <Th>{t('admin.assignments.user')}</Th>
              <Th>{t('admin.assignments.role')}</Th>
              <Th>{t('admin.assignments.zone')}</Th>
              <Th>{t('common.actions')}</Th>
            </tr>
          </thead>
          <tbody>
            {assignments.items.map((assignment) => (
              <tr key={assignment.id}>
                <Td>
                  <div>{assignment.userDisplayName}</div>
                  <Ltr className="text-sm opacity-80">{assignment.userEmail}</Ltr>
                  {assignment.userIsActive ? null : (
                    <div className="text-sm">
                      <span aria-hidden="true">⊘ </span>
                      {t('admin.users.inactive')}
                    </div>
                  )}
                </Td>
                <Td>{t(`roles.${assignment.role}`)}</Td>
                <Td>{assignment.zoneName ?? t('admin.assignments.projectWide')}</Td>
                <Td>
                  <Button
                    variant="outline"
                    disabled={assignments.removing}
                    onClick={() =>
                      assignments.onRemove(
                        assignment,
                        window.confirm(
                          t('admin.assignments.confirmRemove', {
                            name: assignment.userDisplayName,
                            role: t(`roles.${assignment.role}`),
                          }),
                        ),
                      )
                    }
                  >
                    {t('admin.assignments.remove')}
                  </Button>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      <form noValidate onSubmit={assignments.onSubmit} className="grid gap-4 sm:grid-cols-3">
        <Select
          id="assignment-user"
          label={t('admin.assignments.user')}
          value={assignments.values.userId}
          error={assignments.errors.userId ? t(assignments.errors.userId) : undefined}
          onChange={(event) => assignments.onChange('userId', event.target.value)}
        >
          <option value="">{t('admin.assignments.chooseUser')}</option>
          {assignments.users.map((user) => (
            <option key={user.id} value={user.id}>
              {user.displayName} — {user.email}
            </option>
          ))}
        </Select>
        <Select
          id="assignment-role"
          label={t('admin.assignments.role')}
          value={assignments.values.role}
          onChange={(event) => assignments.onChange('role', event.target.value as AssignableRole)}
        >
          {ASSIGNABLE_ROLES.map((role) => (
            <option key={role} value={role}>
              {t(`roles.${role}`)}
            </option>
          ))}
        </Select>
        {zoneNeeded ? (
          <Select
            id="assignment-zone"
            label={t('admin.assignments.zone')}
            value={assignments.values.zoneId}
            disabled={zones.items.length === 0}
            hint={zones.items.length === 0 ? t('admin.assignments.needZoneFirst') : undefined}
            error={assignments.errors.zoneId ? t(assignments.errors.zoneId) : undefined}
            onChange={(event) => assignments.onChange('zoneId', event.target.value)}
          >
            <option value="">{t('admin.assignments.chooseZone')}</option>
            {zones.items.map((zone) => (
              <option key={zone.id} value={zone.id}>
                {zone.name}
              </option>
            ))}
          </Select>
        ) : (
          <div className="flex flex-col justify-end pb-2 text-sm opacity-80">
            {t('admin.assignments.projectWide')}
          </div>
        )}
        {assignments.error ? (
          <Notice kind="error" className="sm:col-span-3">
            {t(assignments.error)}
          </Notice>
        ) : null}
        <div className="sm:col-span-3">
          <Button type="submit" disabled={assignments.pending}>
            {t('admin.assignments.add')}
          </Button>
        </div>
      </form>
    </Card>
  );
}

/** Presentational: one project's settings, zone names and team. */
export function ProjectAdminView({ model }: { model: ProjectAdminModel }) {
  const { t, locale } = useI18n();
  if (model.state === 'loading') return <p role="status">{t('common.loading')}</p>;
  if (model.state === 'error') {
    return <Notice kind="error">{t(model.loadError ?? 'errors.INTERNAL')}</Notice>;
  }
  if (model.state === 'notFound' || !model.project) {
    return <Notice kind="error">{t('errors.NOT_FOUND')}</Notice>;
  }
  return (
    <div className="flex max-w-4xl flex-col gap-6">
      <PageHeader>
        <h1 className="text-xl font-semibold">{model.project.name}</h1>
        <div className="flex flex-wrap gap-3">
          <Link className={LINK} href={`/${locale}/admin/projects`}>
            {t('admin.project.back')}
          </Link>
          <Link className={LINK} href={`/${locale}/projects/${model.project.id}`}>
            {t('admin.project.open')}
          </Link>
        </div>
      </PageHeader>
      <EditProjectCard edit={model.edit} />
      <ZonesCard zones={model.zones} />
      <AssignmentsCard assignments={model.assignments} zones={model.zones} />
    </div>
  );
}

export function ProjectAdmin({ projectId }: { projectId: string }) {
  return <ProjectAdminView model={useProjectAdmin(projectId)} />;
}
