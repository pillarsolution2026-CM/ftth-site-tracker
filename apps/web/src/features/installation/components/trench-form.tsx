'use client';

import { useState, type FormEvent } from 'react';
import { Button } from '@/shared/ui/button';
import { Input } from '@/shared/ui/input';
import { Ltr } from '@/shared/ui/ltr';
import { Notice } from '@/shared/ui/notice';
import { useI18n } from '@/shared/i18n/locale-provider';
import type { TrenchTool } from '../hooks/use-trench-tool';

/**
 * The length form of «حفر جديد» for the route piece picked on the canvas (ADR-042 part D): the
 * length is typed in metres (decimal, LTR) and saved as a trench mark of that route.
 */
export function TrenchForm({
  tool,
  routeHandle,
  onSaved,
}: {
  tool: TrenchTool;
  routeHandle: string;
  onSaved?: () => void;
}) {
  const { t } = useI18n();
  const [length, setLength] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (tool.saving) return;
    if (await tool.save(routeHandle, length)) {
      setLength('');
      onSaved?.();
    }
  };
  return (
    <form className="flex flex-col gap-2" onSubmit={(event) => void submit(event)}>
      <h4 className="font-semibold">{t('design.installation.tool.title')}</h4>
      <p>
        {t('design.installation.tool.route')}: <Ltr>{routeHandle}</Ltr>
      </p>
      <Input
        id="trench-length"
        dir="ltr"
        inputMode="decimal"
        autoComplete="off"
        label={t('design.installation.tool.length')}
        placeholder={t('design.installation.tool.lengthHint')}
        value={length}
        error={tool.lengthError ? t('design.installation.tool.lengthInvalid') : undefined}
        onChange={(event) => {
          setLength(event.target.value);
          tool.clearFormError();
        }}
      />
      {tool.saveError ? (
        <Notice kind="error">{t(tool.saveError.key, tool.saveError.params)}</Notice>
      ) : null}
      <div>
        <Button type="submit" disabled={tool.saving || length.trim() === ''}>
          {tool.saving ? t('design.installation.tool.saving') : t('design.installation.tool.save')}
        </Button>
      </div>
    </form>
  );
}
