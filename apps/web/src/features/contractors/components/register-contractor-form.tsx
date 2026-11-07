'use client';

import Link from 'next/link';
import type { Contractor, ContractorLineAvailability } from '@ftth/shared';
import { Button } from '@/shared/ui/button';
import { Card } from '@/shared/ui/card';
import { Checkbox, Select } from '@/shared/ui/form-controls';
import { Input } from '@/shared/ui/input';
import { Ltr } from '@/shared/ui/ltr';
import { Notice } from '@/shared/ui/notice';
import { Table, Td, Th } from '@/shared/ui/table';
import { useI18n } from '@/shared/i18n/locale-provider';
import { formatDecimal } from '@/shared/lib/decimal';
import type { RegisterContractorModel } from '../hooks/use-register-contractor';
import { translateMsg } from '../model/contractor-errors';
import { lineBlockReason } from '../model/contractor-forms';

const LINK =
  'inline-flex min-h-11 items-center text-(--color-brand) underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-focus)';

interface RegisterContractorFormProps {
  model: RegisterContractorModel;
  contractors: readonly Contractor[];
  /** Contractors already on the work order (cannot be registered twice). */
  registeredIds: ReadonlySet<string>;
  availability: readonly ContractorLineAvailability[];
}

/** Presentational: pick a contractor, a date and the lines (quantity and price for each). */
export function RegisterContractorForm({
  model,
  contractors,
  registeredIds,
  availability,
}: RegisterContractorFormProps) {
  const { t, locale } = useI18n();
  const text = (message: Parameters<typeof translateMsg>[2] | undefined) =>
    message ? translateMsg(t, locale, message) : undefined;
  return (
    <Card>
      <h3 className="mb-4 text-lg font-semibold">{t('contractors.register.title')}</h3>
      <form noValidate onSubmit={model.onSubmit} className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <Select
              id="register-contractor"
              label={t('contractors.register.contractor')}
              value={model.values.contractorId}
              required
              error={text(model.errors.contractorId)}
              onChange={(event) => model.onField('contractorId', event.target.value)}
            >
              <option value="">{t('contractors.register.chooseContractor')}</option>
              {contractors.map((contractor) => {
                const taken = registeredIds.has(contractor.id);
                return (
                  <option key={contractor.id} value={contractor.id} disabled={taken}>
                    {contractor.name}
                    {taken ? ` (${t('contractors.register.alreadyRegistered')})` : ''}
                  </option>
                );
              })}
            </Select>
            <Link className={LINK} href={`/${locale}/admin/contractors`}>
              {t('contractors.register.createContractor')}
            </Link>
          </div>
          <Input
            id="register-date"
            type="date"
            dir="ltr"
            label={t('contractors.register.date')}
            value={model.values.registeredOn}
            required
            error={text(model.errors.registeredOn)}
            onChange={(event) => model.onField('registeredOn', event.target.value)}
          />
        </div>

        <fieldset className="flex flex-col gap-2 border-0 p-0">
          <legend className="text-base font-semibold">
            {t('contractors.register.linesTitle')}
          </legend>
          <p className="text-sm opacity-80">{t('contractors.register.linesHint')}</p>
          {model.errors.lines ? <Notice kind="error">{text(model.errors.lines)}</Notice> : null}
          <Table aria-label={t('contractors.register.linesTitle')}>
            <thead>
              <tr>
                <Th>{t('contractors.line.code')}</Th>
                <Th>{t('contractors.line.description')}</Th>
                <Th>{t('contractors.line.unit')}</Th>
                <Th>{t('contractors.register.workOrderPrice')}</Th>
                <Th>{t('contractors.register.available')}</Th>
                <Th>{t('contractors.line.quantity')}</Th>
                <Th>{t('contractors.register.priceHeader')}</Th>
              </tr>
            </thead>
            <tbody>
              {availability.map((line) => {
                const id = line.workOrderItemId;
                const blocked = lineBlockReason(line);
                const draft = model.values.lines[id];
                const selected = Boolean(draft?.selected) && blocked === null;
                const errors = model.errors.line[id];
                return (
                  <tr key={id}>
                    <Td>
                      <Checkbox
                        id={`register-line-${id}`}
                        label={line.code}
                        aria-label={t('contractors.register.giveLine', { code: line.code })}
                        checked={selected}
                        disabled={blocked !== null}
                        onChange={(event) => model.onToggleLine(line, event.target.checked)}
                      />
                    </Td>
                    <Td>
                      {line.description}
                      {blocked ? (
                        <div className="text-sm">
                          <span aria-hidden="true">⊘ </span>
                          {t(blocked)}
                        </div>
                      ) : null}
                    </Td>
                    <Td>{line.unit}</Td>
                    <Td>
                      <Ltr>
                        {formatDecimal(line.contractPrice, locale, { minFractionDigits: 2 })}
                      </Ltr>
                    </Td>
                    <Td>
                      <Ltr>{formatDecimal(line.availableQuantity, locale)}</Ltr>
                    </Td>
                    <Td>
                      {selected ? (
                        <Input
                          id={`register-qty-${id}`}
                          dir="ltr"
                          inputMode="decimal"
                          label={t('contractors.register.quantity', { code: line.code })}
                          value={draft?.quantity ?? ''}
                          error={text(errors?.quantity)}
                          onChange={(event) =>
                            model.onLineChange(id, 'quantity', event.target.value)
                          }
                        />
                      ) : null}
                    </Td>
                    <Td>
                      {selected ? (
                        <Input
                          id={`register-price-${id}`}
                          dir="ltr"
                          inputMode="decimal"
                          label={t('contractors.register.price', { code: line.code })}
                          value={draft?.unitPrice ?? ''}
                          error={text(errors?.unitPrice)}
                          onChange={(event) =>
                            model.onLineChange(id, 'unitPrice', event.target.value)
                          }
                        />
                      ) : null}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </fieldset>

        {model.submitError ? (
          <Notice kind="error">{translateMsg(t, locale, model.submitError)}</Notice>
        ) : null}
        <div className="flex flex-wrap gap-3">
          <Button type="submit" disabled={model.pending}>
            {model.pending ? t('common.saving') : t('contractors.register.submit')}
          </Button>
          <Button variant="outline" onClick={model.onClose}>
            {t('common.cancel')}
          </Button>
        </div>
      </form>
    </Card>
  );
}
