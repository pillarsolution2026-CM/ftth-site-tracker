'use client';

import Link from 'next/link';
import { ASSIGNABLE_ROLES, type AssignableRole } from '@ftth/shared';
import { Button } from '@/shared/ui/button';
import { Card } from '@/shared/ui/card';
import { Select } from '@/shared/ui/form-controls';
import { Ltr } from '@/shared/ui/ltr';
import { Notice } from '@/shared/ui/notice';
import { PageHeader, Table, Td, Th } from '@/shared/ui/table';
import { useI18n } from '@/shared/i18n/locale-provider';
import { useContract } from '@/features/contracts/api/queries';
import { ProjectContractorsSection } from '@/features/contractors/components/project-contractors-section';
import { useProjectAdmin, type ProjectAdminModel } from '../hooks/use-project-admin';
import { SupervisorSitesPanel } from '@/features/supervisor-sites/components/supervisor-sites-panel';
import { ProjectFields } from './project-fields';

const LINK =
  'inline-flex min-h-11 items-center text-(--color-brand) underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-focus)';
const NO_SUGGESTIONS = { crsEpsg: [] };
const NO_CONTRACTS: never[] = [];

function ContractCard({ project }: { project: ProjectAdminModel['project'] }) {
  const { t, locale } = useI18n();
  const contract = useContract(project?.contractId ?? null);
  if (!project) return null;
  return (
    <Card>
      <h2 className="mb-4 text-lg font-semibold">{t('admin.project.contract')}</h2>
      {project.contractId === null ? (
        <p>{t('admin.project.noContract')}</p>
      ) : (
        <dl className="grid gap-4 sm:grid-cols-3">
          <div>
            <dt className="text-sm opacity-80">{t('admin.project.contractNumber')}</dt>
            <dd className="font-medium">
              {contract.data ? (
                <Link
                  className={LINK}
                  href={`/${locale}/admin/contracts/${contract.data.id}`}
                  aria-label={t('admin.project.openContract')}
                >
                  <Ltr>{contract.data.number}</Ltr>
                </Link>
              ) : (
                '…'
              )}
            </dd>
          </div>
          <div>
            <dt className="text-sm opacity-80">{t('admin.project.client')}</dt>
            <dd className="font-medium">{project.client}</dd>
          </div>
          <div>
            <dt className="text-sm opacity-80">{t('admin.project.currency')}</dt>
            <dd className="font-medium">
              <Ltr>{project.currency}</Ltr>
            </dd>
          </div>
        </dl>
      )}
      <p className="mt-3 text-sm opacity-80">{t('admin.project.contractFixed')}</p>
    </Card>
  );
}

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
          contracts={NO_CONTRACTS}
          editing
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

export function AssignmentsCard({
  assignments,
}: {
  assignments: ProjectAdminModel['assignments'];
}) {
  const { t } = useI18n();
  // Zones are retired (ADR-054): an old zone name is shown only when a row still has one.
  const hasOldZone = assignments.items.some((assignment) => assignment.zoneName !== null);
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
              {hasOldZone ? <Th>{t('admin.assignments.zone')}</Th> : null}
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
                {hasOldZone ? <Td>{assignment.zoneName ?? '—'}</Td> : null}
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

      <form noValidate onSubmit={assignments.onSubmit} className="grid gap-4 sm:grid-cols-2">
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
        {assignments.error ? (
          <Notice kind="error" className="sm:col-span-2">
            {t(assignments.error)}
          </Notice>
        ) : null}
        <div className="sm:col-span-2">
          <Button type="submit" disabled={assignments.pending}>
            {t('admin.assignments.add')}
          </Button>
        </div>
      </form>
    </Card>
  );
}

/** Presentational: one project's settings, team and the supervisors' sites. */
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
      <ContractCard project={model.project} />
      <EditProjectCard edit={model.edit} />
      <ProjectContractorsSection projectId={model.project.id} />
      <AssignmentsCard assignments={model.assignments} />
      <SupervisorSitesPanel projectId={model.project.id} />
    </div>
  );
}

export function ProjectAdmin({ projectId }: { projectId: string }) {
  return <ProjectAdminView model={useProjectAdmin(projectId)} />;
}
