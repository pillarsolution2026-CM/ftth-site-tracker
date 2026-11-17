'use client';

import { INSTALLATION_ANSWERS, type InstallationAnswer } from '@ftth/shared';
import { Button } from '@/shared/ui/button';
import { Card } from '@/shared/ui/card';
import { ErrorNotice } from '@/shared/ui/error-notice';
import { Notice } from '@/shared/ui/notice';
import { useI18n } from '@/shared/i18n/locale-provider';
import { useInstallationCard } from '../hooks/use-installation-card';

type CardState = ReturnType<typeof useInstallationCard>;

/**
 * The General's installation question (ADR-040 G14, ADR-042 part D) with its two answers. The
 * state hook runs inside, so the card can sit on any page; it renders nothing for a Secondary.
 */
export function InstallationQuestionCard(props: Parameters<typeof useInstallationCard>[0]) {
  const state = useInstallationCard(props);
  return <InstallationQuestion state={state} />;
}

export function InstallationQuestion({ state }: { state: CardState }) {
  const { t } = useI18n();
  if (state.loadErrorCode) return <ErrorNotice code={state.loadErrorCode} />;
  if (state.loading) return <p role="status">{t('common.loading')}</p>;
  if (!state.asked) return null;
  return (
    <Card aria-labelledby="installation-title" role="region" className="flex flex-col gap-3">
      <h2 id="installation-title" className="text-lg font-semibold">
        {t('design.installation.title')}
      </h2>
      <p id="installation-question" className="font-medium">
        {t('design.installation.question')}
      </p>
      <div
        role="group"
        aria-labelledby="installation-question"
        className="flex flex-col gap-2 sm:flex-row"
      >
        {INSTALLATION_ANSWERS.map((answer: InstallationAnswer) => {
          const current = state.answer === answer;
          return (
            <Button
              key={answer}
              type="button"
              variant={current ? 'primary' : 'outline'}
              aria-pressed={current}
              disabled={!state.canAnswer || state.saving}
              onClick={() => state.choose(answer)}
            >
              {current ? <span aria-hidden="true">✓ </span> : null}
              {t(`design.installation.answer.${answer}`)}
            </Button>
          );
        })}
      </div>
      {state.saving ? <p role="status">{t('design.installation.saving')}</p> : null}
      {state.answer === null ? (
        <Notice kind="warning">{t('design.installation.unanswered')}</Notice>
      ) : (
        <p>
          {t('design.installation.current', {
            answer: t(`design.installation.answer.${state.answer}`),
          })}
        </p>
      )}
      {state.answer === 'has_trench' ? (
        <p className="text-sm">{t('design.installation.hasTrenchHint')}</p>
      ) : null}
      {!state.canAnswer ? (
        <p className="text-sm opacity-80">{t('design.installation.readOnly')}</p>
      ) : null}
      {state.error ? <Notice kind="error">{t(state.error.key, state.error.params)}</Notice> : null}
      {state.rebuildNeeded ? (
        <Notice kind="warning">{t('design.installation.rebuildNeeded')}</Notice>
      ) : null}
    </Card>
  );
}
