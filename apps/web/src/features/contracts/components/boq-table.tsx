'use client';

import type { ContractDetail, ContractItem } from '@ftth/shared';
import { Button } from '@/shared/ui/button';
import { Ltr } from '@/shared/ui/ltr';
import { Table, Td, Th } from '@/shared/ui/table';
import { useI18n } from '@/shared/i18n/locale-provider';
import { formatDecimal, formatMoney } from '@/shared/lib/decimal';
import { boqDepths } from '../model/contract-forms';

export interface BoqEditing {
  confirmItemId: string | null;
  deleting: boolean;
  onEdit: (item: ContractItem) => void;
  onAskDelete: (itemId: string | null) => void;
  onDelete: (item: ContractItem) => void;
}

interface BoqTableProps {
  contract: Pick<ContractDetail, 'items' | 'currency' | 'total' | 'duplicateCodes'>;
  /** Present only while the contract is a draft and the user is a platform admin. */
  editing?: BoqEditing | undefined;
}

/** Indentation by depth (from `parentCode`); logical padding, so it mirrors in RTL. */
const indent = (depth: number) => ({ paddingInlineStart: `${0.75 + depth * 1.25}rem` });

function LineActions({ item, editing }: { item: ContractItem; editing: BoqEditing }) {
  const { t } = useI18n();
  if (editing.confirmItemId === item.id) {
    return (
      <div
        className="flex flex-wrap items-center gap-2"
        role="group"
        aria-label={t('admin.contracts.boq.confirmDelete')}
      >
        <span>{t('admin.contracts.boq.confirmDelete')}</span>
        <Button disabled={editing.deleting} onClick={() => editing.onDelete(item)}>
          {t('common.delete')}
        </Button>
        <Button variant="outline" onClick={() => editing.onAskDelete(null)}>
          {t('common.cancel')}
        </Button>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap gap-2">
      <Button
        variant="outline"
        aria-label={`${t('common.edit')} ${item.code}`}
        onClick={() => editing.onEdit(item)}
      >
        {t('common.edit')}
      </Button>
      <Button
        variant="outline"
        aria-label={`${t('common.delete')} ${item.code}`}
        onClick={() => editing.onAskDelete(item.id)}
      >
        {t('common.delete')}
      </Button>
    </div>
  );
}

/**
 * Presentational BOQ: priced items as rows, headings as bold section rows spanning the data
 * columns (no price cells). The total counts items only.
 */
export function BoqTable({ contract, editing }: BoqTableProps) {
  const { t, locale } = useI18n();
  const depths = boqDepths(contract.items);
  const duplicates = new Set(contract.duplicateCodes.map((entry) => entry.code));
  return (
    <Table aria-label={t('admin.contracts.boq.title')}>
      <thead>
        <tr>
          <Th>{t('items.lineNo')}</Th>
          <Th>{t('items.code')}</Th>
          <Th>{t('items.workType')}</Th>
          <Th>{t('items.description')}</Th>
          <Th>{t('items.unit')}</Th>
          <Th>{t('admin.contracts.boq.quantity')}</Th>
          <Th>{t('items.unitPrice')}</Th>
          <Th>{t('items.amount')}</Th>
          {editing ? <Th>{t('common.actions')}</Th> : null}
        </tr>
      </thead>
      <tbody>
        {contract.items.map((item) => {
          const depth = depths.get(item.id) ?? 0;
          const codeCell = (
            <Td style={indent(depth)}>
              <Ltr>{item.code}</Ltr>
              {duplicates.has(item.code) ? (
                <span className="ms-2 rounded border border-(--status-inProgress) px-1 text-xs">
                  <span aria-hidden="true">▲ </span>
                  {t('items.duplicateBadge')}
                </span>
              ) : null}
            </Td>
          );
          if (item.kind === 'heading') {
            return (
              <tr key={item.id} data-kind="heading" className="bg-(--color-border)/30 font-bold">
                <Td>
                  <Ltr className="font-normal">{item.lineNo}</Ltr>
                </Td>
                {codeCell}
                <Td colSpan={6}>
                  <span className="me-2 rounded border border-(--color-border) px-1 text-xs font-normal">
                    {t('admin.contracts.boq.headingBadge')}
                  </span>
                  {item.description ?? (
                    <span className="font-normal opacity-80">
                      {t('admin.contracts.boq.noTitle')}
                    </span>
                  )}
                </Td>
                {editing ? (
                  <Td className="font-normal">
                    <LineActions item={item} editing={editing} />
                  </Td>
                ) : null}
              </tr>
            );
          }
          return (
            <tr key={item.id} data-kind="item">
              <Td>
                <Ltr>{item.lineNo}</Ltr>
              </Td>
              {codeCell}
              <Td>
                {item.workType ? (
                  t(`items.workTypes.${item.workType}`)
                ) : (
                  <span className="text-(--status-rejected)">{t('items.workTypeNone')}</span>
                )}
              </Td>
              <Td>{item.description}</Td>
              {/* Units can be up to 64 characters: wrap inside a bounded column (ADR-016). */}
              <Td className="max-w-48 min-w-24 wrap-break-word">{item.unit}</Td>
              <Td>
                <Ltr>{formatDecimal(item.quantity ?? '0', locale)}</Ltr>
              </Td>
              <Td>
                <Ltr>{formatDecimal(item.unitPrice ?? '0', locale, { minFractionDigits: 2 })}</Ltr>
              </Td>
              <Td>
                <Ltr>{formatDecimal(item.amount ?? '0', locale, { minFractionDigits: 2 })}</Ltr>
              </Td>
              {editing ? (
                <Td>
                  <LineActions item={item} editing={editing} />
                </Td>
              ) : null}
            </tr>
          );
        })}
      </tbody>
      <tfoot>
        <tr className="font-semibold">
          <Td colSpan={7}>{t('admin.contracts.boq.totalLabel')}</Td>
          <Td data-testid="boq-total">
            <Ltr>{formatMoney(contract.total, contract.currency, locale)}</Ltr>
          </Td>
          {editing ? <Td /> : null}
        </tr>
      </tfoot>
    </Table>
  );
}
