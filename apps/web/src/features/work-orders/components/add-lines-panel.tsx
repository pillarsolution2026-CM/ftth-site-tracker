'use client';

import type { ContractItemAvailability } from '@ftth/shared';
import { Button } from '@/shared/ui/button';
import { useI18n } from '@/shared/i18n/locale-provider';
import { useAddLines } from '../hooks/use-add-lines';
import { ContractItemPicker } from './contract-item-picker';
import { WorkOrderErrorNotice } from './work-order-error';

interface AddLinesPanelProps {
  projectId: string;
  workOrderId: string;
  items: readonly ContractItemAvailability[];
  /** Contract items already lines of this work order: shown but not selectable. */
  disabledIds: ReadonlySet<string>;
  onDone: () => void;
}

/** "Add line": the same contract-item picker as the create screen (ADR-028). */
export function AddLinesPanel({
  projectId,
  workOrderId,
  items,
  disabledIds,
  onDone,
}: AddLinesPanelProps) {
  const { t } = useI18n();
  const { picker, submit, saving, error } = useAddLines(projectId, workOrderId, items, onDone);
  return (
    <section
      aria-label={t('items.add')}
      className="flex flex-col gap-3 rounded-lg border border-(--color-border) p-4"
    >
      <h3 className="text-lg font-semibold">{t('items.add')}</h3>
      {error ? <WorkOrderErrorNotice error={error} /> : null}
      <ContractItemPicker
        idPrefix="wo-add-picker"
        total={items.length}
        rows={picker.rows}
        search={picker.search}
        onSearch={picker.setSearch}
        disabledIds={disabledIds}
        checkOf={picker.checkOf}
        onToggle={picker.toggle}
        onQuantity={picker.setQuantity}
      />
      <p role="status" className="text-sm">
        {t('items.picker.selected', { count: picker.selection.length })}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          onClick={() => void submit()}
          disabled={saving || picker.selection.length === 0 || picker.payload === null}
        >
          {saving ? t('common.saving') : t('items.picker.addSelected')}
        </Button>
        <Button variant="outline" onClick={onDone}>
          {t('common.cancel')}
        </Button>
      </div>
    </section>
  );
}
