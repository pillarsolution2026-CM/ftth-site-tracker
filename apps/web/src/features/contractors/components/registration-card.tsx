'use client';

import type {
  ContractorLine,
  ContractorLineAvailability,
  ContractorRegistration,
} from '@ftth/shared';
import { Button } from '@/shared/ui/button';
import { Card } from '@/shared/ui/card';
import { Input } from '@/shared/ui/input';
import { Ltr } from '@/shared/ui/ltr';
import { Notice } from '@/shared/ui/notice';
import { Table, Td, Th } from '@/shared/ui/table';
import { useI18n } from '@/shared/i18n/locale-provider';
import { formatDecimal, formatMoney } from '@/shared/lib/decimal';
import { AddLineForm } from './add-line-form';
import type { LineActionsModel } from '../hooks/use-line-actions';
import { latestPrice, registrationTotal, translateMsg } from '../model/contractor-errors';

interface RegistrationCardProps {
  registration: ContractorRegistration;
  currency: string;
  /** Present for the admin; absent for the read-only PM page. */
  actions?: LineActionsModel | undefined;
  /** What is left of each work-order line; the admin's «add line» picker needs it. */
  availability?: readonly ContractorLineAvailability[] | undefined;
}

function LineEditor({ line, actions }: { line: ContractorLine; actions: LineActionsModel }) {
  const { t, locale } = useI18n();
  const editor = actions.editor;
  if (!editor || editor.lineId !== line.id) return null;
  const id = `${editor.kind}-${line.id}`;
  return (
    <tr>
      <Td colSpan={9}>
        {editor.kind === 'quantity' ? (
          <form
            noValidate
            onSubmit={(event) => actions.submitQuantity(event, line)}
            className="flex flex-wrap items-end gap-3"
          >
            <Input
              id={id}
              label={t('contractors.line.newQuantity', { code: line.code })}
              dir="ltr"
              inputMode="decimal"
              value={actions.quantity}
              error={
                actions.quantityError ? translateMsg(t, locale, actions.quantityError) : undefined
              }
              onChange={(event) => actions.onQuantityChange(event.target.value)}
            />
            <Button type="submit" disabled={actions.pending}>
              {actions.pending ? t('common.saving') : t('common.save')}
            </Button>
            <Button variant="outline" onClick={actions.close}>
              {t('common.cancel')}
            </Button>
          </form>
        ) : (
          <form
            noValidate
            onSubmit={(event) => actions.submitPrice(event, line)}
            className="flex flex-wrap items-end gap-3"
          >
            <Input
              id={`${id}-date`}
              type="date"
              dir="ltr"
              label={t('contractors.line.effectiveFrom', { code: line.code })}
              value={actions.price.effectiveFrom}
              error={
                actions.priceErrors.effectiveFrom
                  ? translateMsg(t, locale, actions.priceErrors.effectiveFrom)
                  : undefined
              }
              onChange={(event) => actions.onPriceChange('effectiveFrom', event.target.value)}
            />
            <Input
              id={`${id}-price`}
              dir="ltr"
              inputMode="decimal"
              label={t('contractors.line.newPrice', { code: line.code })}
              value={actions.price.unitPrice}
              error={
                actions.priceErrors.unitPrice
                  ? translateMsg(t, locale, actions.priceErrors.unitPrice)
                  : undefined
              }
              onChange={(event) => actions.onPriceChange('unitPrice', event.target.value)}
            />
            <Button type="submit" disabled={actions.pending}>
              {actions.pending ? t('common.saving') : t('common.save')}
            </Button>
            <Button variant="outline" onClick={actions.close}>
              {t('common.cancel')}
            </Button>
          </form>
        )}
        {actions.actionError ? (
          <Notice kind="error" className="mt-3">
            {translateMsg(t, locale, actions.actionError)}
          </Notice>
        ) : null}
      </Td>
    </tr>
  );
}

/** One contractor on the work order: its lines, prices and exact total. Read-only without `actions`. */
export function RegistrationCard({
  registration,
  currency,
  actions,
  availability = [],
}: RegistrationCardProps) {
  const { t, locale } = useI18n();
  const { contractor } = registration;
  const total = registrationTotal(registration.lines);
  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold">{contractor.name}</h3>
          <p className="text-sm opacity-80">
            {contractor.contactName} · <Ltr>{contractor.contactPhone}</Ltr>
          </p>
          <p className="text-sm">
            {t('contractors.section.registeredOn')}: <Ltr>{registration.registeredOn}</Ltr>
          </p>
        </div>
        {actions ? (
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={actions.pending}
              aria-label={`${t('contractors.line.add')} ${contractor.name}`}
              onClick={() => actions.openAddLine(registration)}
            >
              {t('contractors.line.add')}
            </Button>
            <Button
              variant="outline"
              disabled={actions.pending}
              aria-label={`${t('contractors.section.removeRegistration')} ${contractor.name}`}
              onClick={() => actions.onRemoveRegistration(registration)}
            >
              {t('contractors.section.removeRegistration')}
            </Button>
          </div>
        ) : null}
      </div>
      {registration.lines.length === 0 ? (
        <p>{t('contractors.section.noLines')}</p>
      ) : (
        <Table aria-label={t('contractors.section.lines', { name: contractor.name })}>
          <thead>
            <tr>
              <Th>{t('contractors.line.code')}</Th>
              <Th>{t('contractors.line.description')}</Th>
              <Th>{t('contractors.line.unit')}</Th>
              <Th>{t('contractors.line.contractPrice')}</Th>
              <Th>{t('contractors.line.quantity')}</Th>
              <Th>{t('contractors.line.currentPrice')}</Th>
              <Th>{t('contractors.line.history')}</Th>
              {actions ? <Th>{t('contractors.line.actions')}</Th> : null}
            </tr>
          </thead>
          <tbody>
            {registration.lines.map((line) => {
              const current = latestPrice(line);
              return [
                <tr key={line.id}>
                  <Td>
                    <Ltr>{line.code}</Ltr>
                  </Td>
                  <Td>{line.description}</Td>
                  <Td>{line.unit}</Td>
                  <Td>
                    <Ltr>{formatDecimal(line.contractPrice, locale, { minFractionDigits: 2 })}</Ltr>
                  </Td>
                  <Td>
                    <Ltr>{formatDecimal(line.quantity, locale)}</Ltr>
                  </Td>
                  <Td>
                    {current ? (
                      <>
                        <Ltr>
                          {formatDecimal(current.unitPrice, locale, { minFractionDigits: 2 })}
                        </Ltr>
                        <div className="text-xs opacity-80">
                          {t('contractors.line.since')} <Ltr>{current.effectiveFrom}</Ltr>
                        </div>
                      </>
                    ) : null}
                  </Td>
                  <Td>
                    <ul className="m-0 list-none p-0">
                      {line.prices.map((entry) => (
                        <li key={entry.id}>
                          <Ltr>{entry.effectiveFrom}</Ltr>
                          {': '}
                          <Ltr>
                            {formatDecimal(entry.unitPrice, locale, { minFractionDigits: 2 })}
                          </Ltr>
                        </li>
                      ))}
                    </ul>
                  </Td>
                  {actions ? (
                    <Td>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          variant="outline"
                          disabled={actions.pending}
                          aria-label={`${t('contractors.line.editQuantity')} ${line.code}`}
                          onClick={() => actions.openQuantity(registration, line)}
                        >
                          {t('contractors.line.editQuantity')}
                        </Button>
                        <Button
                          variant="outline"
                          disabled={actions.pending}
                          aria-label={`${t('contractors.line.addPrice')} ${line.code}`}
                          onClick={() => actions.openPrice(registration, line)}
                        >
                          {t('contractors.line.addPrice')}
                        </Button>
                        <Button
                          variant="outline"
                          disabled={actions.pending || registration.lines.length === 1}
                          aria-label={`${t('contractors.line.remove')} ${line.code}`}
                          onClick={() => actions.onRemoveLine(registration, line)}
                        >
                          {t('contractors.line.remove')}
                        </Button>
                        {registration.lines.length === 1 ? (
                          <p className="w-full text-xs">{t('contractors.line.lastLine')}</p>
                        ) : null}
                      </div>
                    </Td>
                  ) : null}
                </tr>,
                actions ? (
                  <LineEditor key={`${line.id}-editor`} line={line} actions={actions} />
                ) : null,
              ];
            })}
          </tbody>
        </Table>
      )}
      {actions &&
      actions.editor?.kind === 'addLine' &&
      actions.editor.registrationId === registration.id ? (
        <AddLineForm registration={registration} availability={availability} actions={actions} />
      ) : null}
      <p className="mt-3 font-semibold" title={t('contractors.section.totalHint')}>
        {t('contractors.section.total')}: <Ltr>{formatMoney(total, currency, locale)}</Ltr>
      </p>
    </Card>
  );
}
