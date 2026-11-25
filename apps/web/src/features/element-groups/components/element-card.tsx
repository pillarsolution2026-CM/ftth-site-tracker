'use client';

import { GROUP_NAME_MAX, type ElementKey } from '@ftth/shared';
import type { MessageKey } from '@ftth/i18n';
import { Button } from '@/shared/ui/button';
import { Card } from '@/shared/ui/card';
import { Notice } from '@/shared/ui/notice';
import { useI18n } from '@/shared/i18n/locale-provider';
import { useAddGroup } from '../hooks/use-add-group';

export interface ElementCardProps {
  element: ElementKey;
  version: number;
  mains: readonly string[];
  knownMains: readonly string[];
  dirty: boolean;
  pending: boolean;
  errorKey: MessageKey | null;
  stale: boolean;
  justSaved: boolean;
  onAdd: (name: string) => void;
  onRemove: (index: number) => void;
  onMove: (index: number, delta: -1 | 1) => void;
  onUndo: () => void;
  onSave: () => void;
  onReload: () => void;
}

const ICON_BUTTON = 'border-transparent px-2';

/** Presentational: the ordered main groups of one element, with add / remove / reorder / save. */
export function ElementCard(props: ElementCardProps) {
  const { t } = useI18n();
  const { element, mains, knownMains, dirty, pending } = props;
  const label = t(`elementGroups.element.${element}`);
  const add = useAddGroup(props.onAdd);
  const options = knownMains.filter((name) => !mains.includes(name));
  const headingId = `element-${element}`;
  return (
    <Card role="group" aria-labelledby={headingId} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id={headingId} className="text-lg font-semibold">
          {label}
        </h2>
        <span className="text-sm">{t('elementGroups.version', { version: props.version })}</span>
      </div>
      {props.errorKey ? (
        <Notice kind="error">
          {t(props.errorKey)}
          {props.stale ? (
            <Button variant="outline" className="ms-3" onClick={props.onReload}>
              {t('elementGroups.reload')}
            </Button>
          ) : null}
        </Notice>
      ) : null}
      {props.justSaved ? <Notice kind="success">{t('elementGroups.saved')}</Notice> : null}
      {mains.length === 0 ? (
        <p className="text-sm">{t('elementGroups.none')}</p>
      ) : (
        <ol
          aria-label={t('elementGroups.groupsOf', { element: label })}
          className="m-0 flex list-none flex-wrap gap-2 p-0"
        >
          {mains.map((name, index) => (
            <li
              key={name}
              className="flex items-center gap-1 rounded-md border border-(--color-border) ps-3"
            >
              <span>{name}</span>
              <Button
                variant="outline"
                className={ICON_BUTTON}
                disabled={index === 0 || pending}
                aria-label={t('elementGroups.moveUp', { name })}
                onClick={() => props.onMove(index, -1)}
              >
                <span aria-hidden="true">▲</span>
              </Button>
              <Button
                variant="outline"
                className={ICON_BUTTON}
                disabled={index === mains.length - 1 || pending}
                aria-label={t('elementGroups.moveDown', { name })}
                onClick={() => props.onMove(index, 1)}
              >
                <span aria-hidden="true">▼</span>
              </Button>
              <Button
                variant="outline"
                className={ICON_BUTTON}
                disabled={pending}
                aria-label={t('elementGroups.remove', { name })}
                onClick={() => props.onRemove(index)}
              >
                <span aria-hidden="true">✕</span>
              </Button>
            </li>
          ))}
        </ol>
      )}
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          add.submit();
        }}
      >
        <label className="flex min-w-56 flex-1 flex-col gap-1 text-sm">
          {`${t('elementGroups.add')} (${label})`}
          <input
            list={`${headingId}-options`}
            maxLength={GROUP_NAME_MAX}
            value={add.value}
            placeholder={t('elementGroups.addPlaceholder')}
            onChange={(event) => add.setValue(event.target.value)}
            className="min-h-11 rounded-md border border-(--color-border) bg-transparent px-3"
          />
        </label>
        <datalist id={`${headingId}-options`}>
          {options.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
        <Button type="submit" variant="outline" disabled={pending}>
          {t('elementGroups.addButton')}
        </Button>
      </form>
      <div className="flex flex-wrap gap-2">
        <Button disabled={!dirty || pending} onClick={props.onSave}>
          {pending ? t('common.saving') : t('elementGroups.save')}
        </Button>
        <Button variant="outline" disabled={!dirty || pending} onClick={props.onUndo}>
          {t('elementGroups.reset')}
        </Button>
      </div>
    </Card>
  );
}
