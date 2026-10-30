'use client';

import { LOCALES } from '@ftth/i18n';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@ftth/shared';
import { Button } from '@/shared/ui/button';
import { Card } from '@/shared/ui/card';
import { Select } from '@/shared/ui/form-controls';
import { Input } from '@/shared/ui/input';
import { Ltr } from '@/shared/ui/ltr';
import { Notice } from '@/shared/ui/notice';
import { PageHeader, Table, Td, Th } from '@/shared/ui/table';
import { useI18n } from '@/shared/i18n/locale-provider';
import { useUsersAdmin, type UsersAdminModel } from '../hooks/use-users-admin';

/** Presentational: users with their status, and the form that creates a non-admin user. */
export function UsersAdminView({ model }: { model: UsersAdminModel }) {
  const { t } = useI18n();
  const err = (field: keyof UsersAdminModel['errors']) =>
    model.errors[field] ? t(model.errors[field]) : undefined;

  return (
    <div className="flex max-w-4xl flex-col gap-6">
      <section>
        <PageHeader>
          <h1 className="text-xl font-semibold">{t('admin.users.title')}</h1>
        </PageHeader>
        {model.listError ? <Notice kind="error">{t(model.listError)}</Notice> : null}
        {model.toggleError ? <Notice kind="error">{t(model.toggleError)}</Notice> : null}
        {model.loading ? (
          <p role="status">{t('common.loading')}</p>
        ) : model.items.length === 0 ? (
          <p>{t('admin.users.none')}</p>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>{t('admin.users.displayName')}</Th>
                <Th>{t('admin.users.email')}</Th>
                <Th>{t('admin.users.status')}</Th>
                <Th>{t('common.actions')}</Th>
              </tr>
            </thead>
            <tbody>
              {model.items.map((user) => (
                <tr key={user.id}>
                  <Td>
                    {user.displayName}
                    {user.isAdmin ? (
                      <span className="ms-2 rounded-md border border-(--color-border) px-2 py-0.5 text-sm">
                        {t('admin.users.adminBadge')}
                      </span>
                    ) : null}
                  </Td>
                  <Td>
                    <Ltr>{user.email}</Ltr>
                  </Td>
                  <Td>
                    <span aria-hidden="true">{user.isActive ? '✓ ' : '⊘ '}</span>
                    {user.isActive ? t('admin.users.active') : t('admin.users.inactive')}
                  </Td>
                  <Td>
                    {user.isAdmin ? null : (
                      <Button
                        variant="outline"
                        disabled={model.toggling}
                        onClick={() =>
                          model.onToggleActive(
                            user,
                            user.isActive
                              ? window.confirm(
                                  t('admin.users.confirmDeactivate', { name: user.displayName }),
                                )
                              : true,
                          )
                        }
                      >
                        {user.isActive ? t('admin.users.deactivate') : t('admin.users.reactivate')}
                      </Button>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <p className="mt-2 text-sm opacity-80">{t('admin.users.adminsByCli')}</p>
      </section>

      <Card>
        <h2 className="mb-4 text-lg font-semibold">{t('admin.users.new')}</h2>
        <form noValidate onSubmit={model.onSubmit} className="grid gap-4 sm:grid-cols-2">
          <Input
            id="user-email"
            type="email"
            dir="ltr"
            autoComplete="off"
            label={t('admin.users.email')}
            value={model.values.email}
            maxLength={254}
            error={err('email')}
            onChange={(event) => model.onChange('email', event.target.value)}
          />
          <Input
            id="user-name"
            label={t('admin.users.displayName')}
            value={model.values.displayName}
            maxLength={100}
            error={err('displayName')}
            onChange={(event) => model.onChange('displayName', event.target.value)}
          />
          <div className="flex flex-col gap-1">
            <Input
              id="user-password"
              type="password"
              dir="ltr"
              autoComplete="new-password"
              label={t('admin.users.password')}
              value={model.values.password}
              minLength={PASSWORD_MIN_LENGTH}
              maxLength={PASSWORD_MAX_LENGTH}
              error={err('password')}
              onChange={(event) => model.onChange('password', event.target.value)}
            />
            {err('password') ? null : (
              <p className="text-sm opacity-80">{t('admin.users.passwordRule')}</p>
            )}
          </div>
          <Select
            id="user-locale"
            label={t('admin.users.locale')}
            value={model.values.locale}
            onChange={(event) => model.onChange('locale', event.target.value)}
          >
            {LOCALES.map((value) => (
              <option key={value} value={value}>
                {t(`admin.locales.${value}`)}
              </option>
            ))}
          </Select>
          {model.submitError ? (
            <Notice kind="error" className="sm:col-span-2">
              {t(model.submitError)}
            </Notice>
          ) : null}
          {model.created ? (
            <Notice kind="success" className="sm:col-span-2">
              {t('admin.users.created')}
            </Notice>
          ) : null}
          <div className="sm:col-span-2">
            <Button type="submit" disabled={model.pending}>
              {model.pending ? t('common.saving') : t('admin.users.create')}
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}

export function UsersAdmin() {
  return <UsersAdminView model={useUsersAdmin()} />;
}
