'use client';

import { LOCALES } from '@ftth/i18n';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@ftth/shared';
import { Button } from '@/shared/ui/button';
import { Card } from '@/shared/ui/card';
import { Select } from '@/shared/ui/form-controls';
import { Input } from '@/shared/ui/input';
import { Ltr } from '@/shared/ui/ltr';
import { Notice } from '@/shared/ui/notice';
import { Table, Td, Th } from '@/shared/ui/table';
import { useI18n } from '@/shared/i18n/locale-provider';
import {
  useContractorAccountsSection,
  type ContractorAccountsModel,
} from '../hooks/use-contractor-accounts';

interface ViewProps {
  model: ContractorAccountsModel;
  registrationId: string;
  contractorName: string;
}

/** Presentational: the login accounts of a contractor, and the form that adds one. */
export function ContractorAccountsView({ model, registrationId, contractorName }: ViewProps) {
  const { t } = useI18n();
  const err = (field: keyof ContractorAccountsModel['errors']) =>
    model.errors[field] ? t(model.errors[field]) : undefined;
  const id = (name: string) => `account-${name}-${registrationId}`;
  const titleId = id('title');

  return (
    <Card>
      <section aria-labelledby={titleId} className="flex flex-col gap-4">
        <div>
          <h4 id={titleId} className="text-base font-semibold">
            {t('contractorAccounts.title')}
          </h4>
          <p className="text-sm opacity-80">
            {t('contractorAccounts.intro', { name: contractorName })}
          </p>
        </div>
        {model.listError ? <Notice kind="error">{t(model.listError)}</Notice> : null}
        {model.toggleError ? <Notice kind="error">{t(model.toggleError)}</Notice> : null}
        {model.loading ? (
          <p role="status">{t('common.loading')}</p>
        ) : model.listError ? null : model.items.length === 0 ? (
          <p>{t('contractorAccounts.none')}</p>
        ) : (
          <Table aria-label={t('contractorAccounts.list', { name: contractorName })}>
            <thead>
              <tr>
                <Th>{t('contractorAccounts.email')}</Th>
                <Th>{t('contractorAccounts.displayName')}</Th>
                <Th>{t('contractorAccounts.locale')}</Th>
                <Th>{t('contractorAccounts.status')}</Th>
                <Th>{t('contractorAccounts.createdAt')}</Th>
                <Th>{t('common.actions')}</Th>
              </tr>
            </thead>
            <tbody>
              {model.items.map((account) => (
                <tr key={account.userId}>
                  <Td>
                    <Ltr>{account.email}</Ltr>
                  </Td>
                  <Td>{account.displayName}</Td>
                  <Td>{t(`admin.locales.${account.locale}`)}</Td>
                  <Td>
                    <span aria-hidden="true">{account.isActive ? '✓ ' : '⊘ '}</span>
                    {account.isActive
                      ? t('contractorAccounts.active')
                      : t('contractorAccounts.stopped')}
                  </Td>
                  <Td>
                    <Ltr>{account.createdAt.slice(0, 10)}</Ltr>
                  </Td>
                  <Td>
                    <Button
                      variant="outline"
                      disabled={model.toggling}
                      aria-label={`${
                        account.isActive
                          ? t('contractorAccounts.stop')
                          : t('contractorAccounts.restart')
                      } ${account.email}`}
                      onClick={() =>
                        model.onToggleActive(
                          account,
                          window.confirm(
                            account.isActive
                              ? t('contractorAccounts.confirmStop', { name: account.displayName })
                              : t('contractorAccounts.confirmRestart', {
                                  name: account.displayName,
                                }),
                          ),
                        )
                      }
                    >
                      {account.isActive
                        ? t('contractorAccounts.stop')
                        : t('contractorAccounts.restart')}
                    </Button>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}

        <form noValidate onSubmit={model.onSubmit} className="grid gap-4 sm:grid-cols-2">
          <h5 className="text-base font-semibold sm:col-span-2">{t('contractorAccounts.new')}</h5>
          <Input
            id={id('email')}
            type="email"
            dir="ltr"
            autoComplete="off"
            label={t('contractorAccounts.email')}
            value={model.values.email}
            maxLength={254}
            error={err('email')}
            onChange={(event) => model.onChange('email', event.target.value)}
          />
          <Input
            id={id('name')}
            label={t('contractorAccounts.displayName')}
            value={model.values.displayName}
            maxLength={100}
            error={err('displayName')}
            onChange={(event) => model.onChange('displayName', event.target.value)}
          />
          <div className="flex flex-col gap-1">
            <Input
              id={id('password')}
              type="password"
              dir="ltr"
              autoComplete="new-password"
              label={t('contractorAccounts.password')}
              value={model.values.password}
              minLength={PASSWORD_MIN_LENGTH}
              maxLength={PASSWORD_MAX_LENGTH}
              error={err('password')}
              onChange={(event) => model.onChange('password', event.target.value)}
            />
            {err('password') ? null : (
              <p className="text-sm opacity-80">{t('contractorAccounts.passwordRule')}</p>
            )}
          </div>
          <Select
            id={id('locale')}
            label={t('contractorAccounts.locale')}
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
              {t('contractorAccounts.created')}
            </Notice>
          ) : null}
          <div className="sm:col-span-2">
            <Button type="submit" disabled={model.pending}>
              {model.pending ? t('contractorAccounts.creating') : t('contractorAccounts.submit')}
            </Button>
          </div>
        </form>
      </section>
    </Card>
  );
}

interface Props {
  projectId: string;
  registrationId: string;
  contractorName: string;
}

/** Container; shown only to users with `contractor_accounts:manage` (the caller decides). */
export function ContractorAccounts({ projectId, registrationId, contractorName }: Props) {
  const model = useContractorAccountsSection(projectId, registrationId);
  return (
    <ContractorAccountsView
      model={model}
      registrationId={registrationId}
      contractorName={contractorName}
    />
  );
}
