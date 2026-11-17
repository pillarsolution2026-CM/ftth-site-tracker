'use client';

import { TEXT_ROLES, type DrawingKind, type TextRole } from '@ftth/shared';
import { Button } from '@/shared/ui/button';
import { Checkbox } from '@/shared/ui/form-controls';
import { useI18n } from '@/shared/i18n/locale-provider';
import {
  EMPTY_MEANING,
  parseWays,
  roleNotForKind,
  roleOptionsFor,
  sortedAliases,
  type LayerMeaningForm,
} from '../model/layer-meaning';

/**
 * What a layer's texts mean and, on a route layer, its bundle type (ADR-041). The roles offered
 * are those of the file's drawing kind that fit the layer's target; they are suggestions until the
 * PM saves. A role the kind does not read stays visible, marked, so it can be unticked.
 */
export function RuleMeaningEditor({
  id,
  rowLabel,
  target,
  kind,
  value,
  disabled,
  onRolesChange,
  onWaysChange,
  onAliasRemove,
}: {
  id: string;
  rowLabel: string;
  target: string;
  kind: DrawingKind | null;
  value: LayerMeaningForm | undefined;
  disabled: boolean;
  onRolesChange: (roles: TextRole[]) => void;
  onWaysChange: (ways: string) => void;
  onAliasRemove: (found: string) => void;
}) {
  const { t } = useI18n();
  const meaning = value ?? EMPTY_MEANING;
  const options = roleOptionsFor(kind, target, meaning.roles);
  const isRoute = target === 'route';
  const aliases = meaning.roles.includes('handhole_type') ? sortedAliases(meaning.aliases) : [];
  if (options.length === 0 && !isRoute) return null;
  const waysText = meaning.ways.trim();
  const waysBad = waysText !== '' && parseWays(waysText) === null;
  const toggle = (role: TextRole, checked: boolean) => {
    const next = checked ? [...meaning.roles, role] : meaning.roles.filter((r) => r !== role);
    onRolesChange(TEXT_ROLES.filter((r) => next.includes(r)));
  };
  return (
    <div className="flex flex-col gap-2">
      {options.length > 0 ? (
        <fieldset className="m-0 flex min-w-0 flex-col gap-1 border-0 p-0">
          <legend className="text-sm font-medium">
            {t('mapping.meaning.label')}: <bdi>{rowLabel}</bdi>
          </legend>
          <div className="flex flex-wrap gap-x-4">
            {options.map((role) => (
              <span key={role} className="inline-flex flex-wrap items-center gap-1">
                <Checkbox
                  id={`${id}-role-${role}`}
                  label={t(`mapping.meaning.role.${role}`)}
                  checked={meaning.roles.includes(role)}
                  disabled={disabled}
                  onChange={(event) => toggle(role, event.target.checked)}
                />
                {roleNotForKind(kind, role) ? (
                  <span className="text-sm font-semibold">
                    <span aria-hidden="true">⚠ </span>
                    {t('mapping.meaning.notForKind')}
                  </span>
                ) : null}
              </span>
            ))}
          </div>
        </fieldset>
      ) : null}
      {aliases.length > 0 ? (
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium">
            {t('mapping.meaning.aliases')}: <bdi>{rowLabel}</bdi>
          </p>
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {aliases.map(([found, type]) => (
              <li key={found} className="flex flex-wrap items-center gap-2 text-sm">
                <bdi dir="ltr">
                  {found} → {type}
                </bdi>
                <Button
                  variant="outline"
                  disabled={disabled}
                  aria-label={t('mapping.meaning.aliasRemoveOne', { found })}
                  onClick={() => onAliasRemove(found)}
                >
                  {t('mapping.meaning.aliasRemove')}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {isRoute ? (
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-ways`} className="text-sm font-medium">
            {t('mapping.meaning.ways')}: <bdi>{rowLabel}</bdi>
          </label>
          <input
            id={`${id}-ways`}
            inputMode="numeric"
            dir="ltr"
            value={meaning.ways}
            maxLength={3}
            placeholder={t('mapping.meaning.waysPlaceholder')}
            disabled={disabled}
            aria-invalid={waysBad ? true : undefined}
            aria-describedby={waysBad ? `${id}-ways-error` : undefined}
            onChange={(event) => onWaysChange(event.target.value)}
            className="min-h-11 w-24 rounded-md border border-(--color-border) bg-transparent px-2 text-base focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-focus)"
          />
          {waysBad ? (
            <p id={`${id}-ways-error`} className="flex items-center gap-1 text-sm">
              <span aria-hidden="true">⚠</span>
              {t('mapping.meaning.waysInvalid')}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
