'use client';

import Link from 'next/link';
import type { FormEvent } from 'react';
import type { MessageKey } from '@ftth/i18n';
import type { ContractSummary, Project } from '@ftth/shared';
import { Button } from '@/shared/ui/button';
import { Card } from '@/shared/ui/card';
import { Ltr } from '@/shared/ui/ltr';
import { Notice } from '@/shared/ui/notice';
import { PageHeader, Table, Td, Th } from '@/shared/ui/table';
import { useI18n } from '@/shared/i18n/locale-provider';
import { useProjectsAdmin } from '../hooks/use-projects-admin';
import type { ProjectField, ProjectFormValues } from '../model/admin-forms';
import { ProjectFields } from './project-fields';

const LINK =
  'inline-flex min-h-11 items-center text-(--color-brand) underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-focus)';

export interface ProjectsAdminViewProps {
  loading: boolean;
  listError: MessageKey | null;
  items: Project[];
  contracts: ContractSummary[];
  suggestions: { crsEpsg: string[] };
  values: ProjectFormValues;
  errors: Partial<Record<ProjectField, MessageKey>>;
  pending: boolean;
  submitError: MessageKey | null;
  onChange: (field: ProjectField, value: string) => void;
  onSubmit: (event: FormEvent) => void;
}

/** Presentational: every project, and the form that creates one. */
export function ProjectsAdminView(props: ProjectsAdminViewProps) {
  const { t, locale } = useI18n();
  const contractNumber = (project: Project) =>
    props.contracts.find((contract) => contract.id === project.contractId)?.number ?? null;
  return (
    <div className="flex flex-col gap-6">
      <section>
        <PageHeader>
          <h1 className="text-xl font-semibold">{t('admin.allProjects')}</h1>
        </PageHeader>
        {props.listError ? <Notice kind="error">{t(props.listError)}</Notice> : null}
        {props.loading ? (
          <p role="status">{t('common.loading')}</p>
        ) : props.items.length === 0 ? (
          <Notice kind="info">{t('admin.noProjects')}</Notice>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>{t('admin.project.name')}</Th>
                <Th>{t('admin.project.contract')}</Th>
                <Th>{t('admin.project.client')}</Th>
                <Th>EPSG</Th>
                <Th>{t('admin.project.currency')}</Th>
                <Th>{t('common.actions')}</Th>
              </tr>
            </thead>
            <tbody>
              {props.items.map((project) => (
                <tr key={project.id}>
                  <Td>{project.name}</Td>
                  <Td>
                    {contractNumber(project) ? (
                      <Ltr>{contractNumber(project)}</Ltr>
                    ) : (
                      <span className="opacity-80">{t('admin.project.noContract')}</span>
                    )}
                  </Td>
                  <Td>{project.client}</Td>
                  <Td>
                    <Ltr>{project.crsEpsg}</Ltr>
                  </Td>
                  <Td>
                    <Ltr>{project.currency}</Ltr>
                  </Td>
                  <Td className="flex flex-wrap gap-3">
                    <Link className={LINK} href={`/${locale}/admin/projects/${project.id}`}>
                      {t('admin.manage')}
                    </Link>
                    <Link className={LINK} href={`/${locale}/projects/${project.id}`}>
                      {t('admin.project.open')}
                    </Link>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>

      <Card className="max-w-3xl">
        <h2 className="mb-4 text-lg font-semibold">{t('admin.project.new')}</h2>
        <form noValidate onSubmit={props.onSubmit} className="flex flex-col gap-4">
          <ProjectFields
            idPrefix="project-new"
            values={props.values}
            errors={props.errors}
            suggestions={props.suggestions}
            contracts={props.contracts}
            editing={false}
            onChange={props.onChange}
          />
          {props.submitError ? <Notice kind="error">{t(props.submitError)}</Notice> : null}
          <div>
            <Button type="submit" disabled={props.pending || props.loading}>
              {props.pending ? t('common.saving') : t('admin.project.create')}
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}

export function ProjectsAdmin() {
  return <ProjectsAdminView {...useProjectsAdmin()} />;
}
