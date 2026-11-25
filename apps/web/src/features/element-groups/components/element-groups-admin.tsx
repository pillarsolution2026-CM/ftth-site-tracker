'use client';

import { Button } from '@/shared/ui/button';
import { Notice } from '@/shared/ui/notice';
import { useI18n } from '@/shared/i18n/locale-provider';
import { useElementGroups, type ElementGroupsModel } from '../hooks/use-element-groups';
import { ElementCard } from './element-card';
import { UnlinkedGroups } from './unlinked-groups';

/** Presentational: the element → main groups map and the unlinked warning. */
export function ElementGroupsView({ model }: { model: ElementGroupsModel }) {
  const { t } = useI18n();
  if (model.loadErrorKey) {
    return (
      <Notice kind="error">
        {t(model.loadErrorKey)}
        <Button variant="outline" className="ms-3" onClick={model.reload}>
          {t('elementGroups.reload')}
        </Button>
      </Notice>
    );
  }
  if (model.loading) return <p role="status">{t('common.loading')}</p>;
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold">{t('elementGroups.title')}</h1>
      <p className="text-sm">{t('elementGroups.intro')}</p>
      <UnlinkedGroups unlinked={model.unlinked} />
      {model.entries.map((entry) => (
        <ElementCard
          key={entry.element}
          element={entry.element}
          version={entry.version}
          mains={entry.mains}
          knownMains={model.knownMains}
          dirty={entry.dirty}
          pending={entry.pending}
          errorKey={entry.errorKey}
          stale={entry.stale}
          justSaved={entry.justSaved}
          onAdd={(name) => model.add(entry.element, name)}
          onRemove={(index) => model.remove(entry.element, index)}
          onMove={(index, delta) => model.move(entry.element, index, delta)}
          onUndo={() => model.undo(entry.element)}
          onSave={() => model.save(entry.element)}
          onReload={model.reload}
        />
      ))}
    </div>
  );
}

export function ElementGroupsAdmin() {
  return <ElementGroupsView model={useElementGroups()} />;
}
