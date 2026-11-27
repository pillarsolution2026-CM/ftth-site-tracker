'use client';

import { useState } from 'react';
import type { MessageKey } from '@ftth/i18n';
import { useI18n } from '@/shared/i18n/locale-provider';
import type { DrawingViewer } from '../hooks/use-drawing-viewer';
import { MATCH_UNSUPPORTED, type MatchProperty, type MatchSettings } from '../hooks/match-commands';
import { BUTTON, Dialog } from './workspace-dialogs';

/** AutoCAD's names in the Property Settings dialog (kept in English as AutoCAD's own). */
const LABEL: Readonly<Record<MatchProperty, string>> = {
  color: 'Color',
  layer: 'Layer',
  linetype: 'Linetype',
  ltscale: 'Linetype Scale',
  lineweight: 'Lineweight',
  transparency: 'Transparency',
  thickness: 'Thickness',
  plotstyle: 'Plot Style',
  dim: 'Dimension',
  text: 'Text',
  hatch: 'Hatch',
  polyline: 'Polyline',
  viewport: 'Viewport',
  table: 'Table',
  material: 'Material',
  multileader: 'Multileader',
  center: 'Center object',
};

const BASIC: readonly MatchProperty[] = [
  'color',
  'layer',
  'linetype',
  'ltscale',
  'lineweight',
  'transparency',
  'thickness',
  'plotstyle',
];
const SPECIAL: readonly MatchProperty[] = [
  'dim',
  'text',
  'hatch',
  'polyline',
  'viewport',
  'table',
  'material',
  'multileader',
  'center',
];

/**
 * MATCHPROP's Settings (owner 2026-11-26, item 34): AutoCAD's Property Settings dialog, Basic and
 * Special Properties with a check box each. What this screen cannot copy is greyed with the reason.
 * OK keeps the settings for the next destinations (and the next MATCHPROP), Cancel drops them.
 */
export function MatchSettingsDialog({ viewer }: { viewer: DrawingViewer }) {
  const { t } = useI18n();
  const { edit } = viewer;
  const [draft, setDraft] = useState<MatchSettings>(edit.matchSettings);
  const close = () => viewer.setDialog(null);
  const box = (p: MatchProperty) => {
    const why = MATCH_UNSUPPORTED[p];
    const reason = why ? t(`design.cad.match.why.${why}` as MessageKey) : undefined;
    return (
      <label
        key={p}
        title={reason}
        className={`flex min-h-7 items-center gap-2 text-xs ${why ? 'opacity-50' : ''}`}
      >
        <input
          type="checkbox"
          checked={draft[p]}
          disabled={why !== undefined}
          onChange={(event) => setDraft({ ...draft, [p]: event.target.checked })}
        />
        <span>{LABEL[p]}</span>
      </label>
    );
  };
  return (
    <Dialog title={t('design.cad.match.title')} onClose={close}>
      <div className="grid grid-cols-2 gap-3">
        <fieldset className="rounded border border-[#4a505a] p-2">
          <legend className="px-1 text-xs font-semibold">{t('design.cad.match.basic')}</legend>
          {BASIC.map(box)}
        </fieldset>
        <fieldset className="rounded border border-[#4a505a] p-2">
          <legend className="px-1 text-xs font-semibold">{t('design.cad.match.special')}</legend>
          {SPECIAL.map(box)}
        </fieldset>
      </div>
      <div className="flex justify-end gap-1">
        <button
          type="button"
          className={BUTTON}
          onClick={() => {
            edit.setMatchSettings(draft);
            close();
          }}
        >
          {t('design.cad.match.ok')}
        </button>
        <button type="button" className={BUTTON} onClick={close}>
          {t('design.cad.match.cancel')}
        </button>
      </div>
    </Dialog>
  );
}
