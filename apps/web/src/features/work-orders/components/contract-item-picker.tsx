'use client';

import type { ContractItemAvailability } from '@ftth/shared';
import { Ltr } from '@/shared/ui/ltr';
import { Input } from '@/shared/ui/input';
import { Table, Td, Th } from '@/shared/ui/table';
import { useI18n } from '@/shared/i18n/locale-provider';
import { formatDecimal } from '@/shared/lib/decimal';
import type { LineCheck } from '../model/line-picker';

export interface ContractItemPickerProps {
  /** Every item of the contract (for the empty message); `rows` is the searched subset. */
  total: number;
  rows: readonly ContractItemAvailability[];
  search: string;
  onSearch: (value: string) => void;
  /** Items already lines of the work order: shown, not selectable. */
  disabledIds?: ReadonlySet<string>;
  checkOf: (contractItemId: string) => LineCheck | undefined;
  onToggle: (contractItemId: string) => void;
  onQuantity: (contractItemId: string, quantity: string) => void;
  idPrefix?: string;
}

/**
 * Searchable table of the contract's priced items: code, description, unit, work type, price and
 * the quantities (contract, reserved by every work order, available). Tick an item and type its
 * quantity. Warnings use text and an icon, never colour alone.
 */
export function ContractItemPicker({
  total,
  rows,
  search,
  onSearch,
  disabledIds,
  checkOf,
  onToggle,
  onQuantity,
  idPrefix = 'picker',
}: ContractItemPickerProps) {
  const { t, locale } = useI18n();
  const num = (value: string, min = 0) => formatDecimal(value, locale, { minFractionDigits: min });
  return (
    <div className="flex flex-col gap-3">
      <Input
        id={`${idPrefix}-search`}
        type="search"
        label={t('items.picker.search')}
        placeholder={t('items.picker.searchPlaceholder')}
        value={search}
        onChange={(event) => onSearch(event.target.value)}
        className="max-w-md"
      />
      {total === 0 ? <p>{t('items.picker.empty')}</p> : null}
      {total > 0 && rows.length === 0 ? <p role="status">{t('items.picker.noMatch')}</p> : null}
      {rows.length > 0 ? (
        <Table aria-label={t('items.picker.title')}>
          <thead>
            <tr>
              <Th>{t('items.picker.choose')}</Th>
              <Th>{t('items.code')}</Th>
              <Th>{t('items.description')}</Th>
              <Th>{t('items.unit')}</Th>
              <Th>{t('items.workType')}</Th>
              <Th>{t('items.unitPrice')}</Th>
              <Th>{t('items.contractQuantity')}</Th>
              <Th>{t('items.picker.reserved')}</Th>
              <Th>{t('items.picker.available')}</Th>
              <Th>{t('items.picker.quantity')}</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((item) => {
              const disabled = disabledIds?.has(item.contractItemId) ?? false;
              const check = checkOf(item.contractItemId);
              const chosen = check !== undefined;
              const inputId = `${idPrefix}-qty-${item.contractItemId}`;
              return (
                <tr key={item.contractItemId} aria-disabled={disabled || undefined}>
                  <Td>
                    <input
                      type="checkbox"
                      className="size-6 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-focus)"
                      aria-label={t('items.picker.chooseFor', { code: item.code })}
                      checked={chosen}
                      disabled={disabled}
                      onChange={() => onToggle(item.contractItemId)}
                    />
                  </Td>
                  <Td>
                    <Ltr>{item.code}</Ltr>
                    {disabled ? (
                      <span className="ms-2 rounded border border-(--color-border) px-1 text-xs">
                        {t('items.picker.inOrder')}
                      </span>
                    ) : null}
                  </Td>
                  <Td>{item.description}</Td>
                  <Td className="max-w-48 min-w-24 wrap-break-word">{item.unit}</Td>
                  <Td>{t(`items.workTypes.${item.workType}`)}</Td>
                  <Td>
                    <Ltr>{num(item.unitPrice, 2)}</Ltr>
                  </Td>
                  <Td>
                    <Ltr>{num(item.contractQuantity)}</Ltr>
                  </Td>
                  <Td>
                    <Ltr>{num(item.reservedQuantity)}</Ltr>
                  </Td>
                  <Td>
                    <Ltr data-testid={`available-${item.code}`}>{num(item.availableQuantity)}</Ltr>
                  </Td>
                  <Td>
                    {chosen ? (
                      <div className="flex flex-col gap-1">
                        <input
                          id={inputId}
                          dir="ltr"
                          inputMode="decimal"
                          aria-label={t('items.picker.quantityFor', { code: item.code })}
                          aria-invalid={check.issues.length > 0 ? true : undefined}
                          aria-describedby={check.issues.length > 0 ? `${inputId}-msg` : undefined}
                          value={check.raw}
                          onChange={(event) => onQuantity(item.contractItemId, event.target.value)}
                          className="min-h-11 w-32 rounded-md border border-(--color-border) bg-transparent px-3 text-base focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-focus)"
                        />
                        {check.issues.length > 0 ? (
                          <ul id={`${inputId}-msg`} className="text-sm">
                            {check.issues.map((issue) => (
                              <li key={issue} className="flex items-start gap-1">
                                <span aria-hidden="true">{issue === 'exceeds' ? '▲' : '⚠'}</span>
                                <span>
                                  {issue === 'invalidQuantity'
                                    ? t('items.picker.invalidQuantity')
                                    : issue === 'repeated'
                                      ? t('items.picker.repeated')
                                      : t('items.picker.exceeds', {
                                          available: num(item.availableQuantity),
                                        })}
                                </span>
                              </li>
                            ))}
                          </ul>
                        ) : null}
                      </div>
                    ) : null}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      ) : null}
    </div>
  );
}
