import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import type { Locale } from '@ftth/i18n';
import { ProjectAccessProvider } from '@/features/projects/hooks/project-access-context';
import type { ProjectAccess } from '@/features/projects/model/project-access';
import { LocaleProvider } from '@/shared/i18n/locale-provider';

export const PROJECT_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

export const PM_ACCESS: ProjectAccess = {
  status: 'member',
  projectId: PROJECT_ID,
  projectName: 'Project',
  roles: ['pm'],
  isAdmin: false,
};

export const QC_ACCESS: ProjectAccess = { ...PM_ACCESS, roles: ['qc'] };

interface Options {
  locale?: Locale;
  access?: ProjectAccess;
}

/** Providers the screens expect: query client, locale and project access. */
export function renderScreen(
  ui: ReactElement,
  { locale = 'en', access = PM_ACCESS }: Options = {},
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <LocaleProvider locale={locale}>
        <ProjectAccessProvider projectId={PROJECT_ID} access={access}>
          {ui}
        </ProjectAccessProvider>
      </LocaleProvider>
    </QueryClientProvider>,
  );
}
