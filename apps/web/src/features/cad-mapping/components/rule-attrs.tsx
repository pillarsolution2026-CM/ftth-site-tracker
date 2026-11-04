'use client';

import { CABINET_ROLES, ITEM_STATUSES, type CabinetRole, type ItemStatus } from '@ftth/shared';
import { useI18n } from '@/shared/i18n/locale-provider';
import { EMPTY_ATTRS, isFeatureTarget, type RuleAttrsForm } from '../model/mapping-form';
import { RuleSelect } from './rule-select';

/**
 * Extra choices of a rule to a feature type (ADR-033/034): role for cabinets (required, no
 * default), new / existing, and a free kind such as "4 way" or "144". Nothing for other targets.
 */
export function RuleAttrsEditor({
  id,
  rowLabel,
  target,
  value,
  disabled,
  onChange,
}: {
  id: string;
  rowLabel: string;
  target: string;
  value: RuleAttrsForm | undefined;
  disabled: boolean;
  onChange: (patch: Partial<RuleAttrsForm>) => void;
}) {
  const { t } = useI18n();
  if (!isFeatureTarget(target)) return null;
  const attrs = value ?? EMPTY_ATTRS;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {target === 'cabinet' ? (
        <RuleSelect<CabinetRole | ''>
          id={`${id}-role`}
          label={`${t('mapping.role.label')}: ${rowLabel}`}
          value={attrs.role}
          options={[
            { value: '', label: t('mapping.role.choose') },
            ...CABINET_ROLES.map((role) => ({ value: role, label: t(`mapping.role.${role}`) })),
          ]}
          disabled={disabled}
          onChange={(role) => onChange({ role })}
        />
      ) : null}
      <RuleSelect<ItemStatus>
        id={`${id}-status`}
        label={`${t('mapping.status.label')}: ${rowLabel}`}
        value={attrs.status}
        options={ITEM_STATUSES.map((status) => ({
          value: status,
          label: t(`mapping.status.${status}`),
        }))}
        disabled={disabled}
        onChange={(status) => onChange({ status })}
      />
      <input
        id={`${id}-kind`}
        aria-label={`${t('mapping.kind.label')}: ${rowLabel}`}
        placeholder={t('mapping.kind.placeholder')}
        value={attrs.kind}
        maxLength={64}
        dir="ltr"
        disabled={disabled}
        onChange={(event) => onChange({ kind: event.target.value })}
        className="min-h-11 w-32 rounded-md border border-(--color-border) bg-transparent px-2 text-base focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-focus)"
      />
    </div>
  );
}
