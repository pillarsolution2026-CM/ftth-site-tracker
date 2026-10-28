'use client';

import {
  POINT_FEATURE_TYPES,
  MAPPING_TARGETS,
  MAPPING_TEXT_ROWS_LIMIT,
  type CadMappingView,
  type MappingTarget,
} from '@ftth/shared';
import { Ltr } from '@/shared/ui/ltr';
import { Table, Td, Th } from '@/shared/ui/table';
import { useI18n } from '@/shared/i18n/locale-provider';
import { LayerSwatch } from '@/features/cad-files/components/layers-table';
import {
  BLOCK_TARGETS,
  isSuggestedLayer,
  targetLabelKey,
  type BlockChoice,
  type MappingFormState,
  type TextChoice,
  type TextRuleRow,
} from '../model/mapping-form';
import { RuleSelect } from './rule-select';

interface CommonProps {
  view: CadMappingView;
  state: MappingFormState;
  disabled: boolean;
}

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <h2 id={id} className="text-lg font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

export function LayerRulesTable({
  view,
  state,
  disabled,
  onChange,
}: CommonProps & { onChange: (layer: string, target: MappingTarget) => void }) {
  const { t } = useI18n();
  const options = MAPPING_TARGETS.map((target) => ({
    value: target,
    label: t(targetLabelKey(target)),
  }));
  return (
    <Section id="mapping-layers" title={t('mapping.layers.title')}>
      {view.layers.length === 0 ? (
        <p>{t('mapping.layers.none')}</p>
      ) : (
        <Table aria-label={t('mapping.layers.title')}>
          <thead>
            <tr>
              <Th>{t('mapping.layers.color')}</Th>
              <Th>{t('mapping.layers.name')}</Th>
              <Th>{t('mapping.layers.entities')}</Th>
              <Th>{t('mapping.layers.target')}</Th>
            </tr>
          </thead>
          <tbody>
            {view.layers.map((layer, index) => {
              const current = state.layers[layer.name] ?? layer.suggestedTarget;
              return (
                <tr key={layer.name}>
                  <Td>
                    <LayerSwatch layer={layer} />
                  </Td>
                  <Td>
                    <Ltr className="break-all">{layer.name}</Ltr>
                  </Td>
                  <Td>
                    <ul className="m-0 flex list-none flex-wrap gap-x-3 gap-y-1 p-0">
                      {Object.entries(layer.entityCounts).map(([type, count]) => (
                        <li key={type}>
                          <Ltr>
                            {type} {count}
                          </Ltr>
                        </li>
                      ))}
                      <li>
                        <Ltr>Σ {layer.entityTotal}</Ltr>
                      </li>
                    </ul>
                  </Td>
                  <Td>
                    <div className="flex flex-wrap items-center gap-2">
                      <RuleSelect
                        id={`layer-target-${index}`}
                        label={`${t('mapping.layers.target')}: ${layer.name}`}
                        value={current}
                        options={options}
                        disabled={disabled}
                        onChange={(target) => onChange(layer.name, target)}
                      />
                      {isSuggestedLayer(view, layer.name, current) ? (
                        <span
                          title={t('mapping.layers.suggestedHint')}
                          className="inline-flex min-h-8 items-center gap-1 rounded-md border-2 border-(--status-executed) px-2 text-sm"
                        >
                          <span aria-hidden="true">✦</span>
                          {t('mapping.layers.suggested')}
                        </span>
                      ) : null}
                    </div>
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
    </Section>
  );
}

export function BlockRulesTable({
  view,
  state,
  disabled,
  onChange,
}: CommonProps & { onChange: (block: string, choice: BlockChoice) => void }) {
  const { t } = useI18n();
  const options: { value: BlockChoice; label: string }[] = [
    { value: 'follow', label: t('mapping.blocks.follow') },
    ...BLOCK_TARGETS.map((target) => ({ value: target, label: t(targetLabelKey(target)) })),
  ];
  return (
    <Section id="mapping-blocks" title={t('mapping.blocks.title')}>
      {view.blocks.length === 0 ? (
        <p>{t('mapping.blocks.none')}</p>
      ) : (
        <Table aria-label={t('mapping.blocks.title')}>
          <thead>
            <tr>
              <Th>{t('mapping.blocks.name')}</Th>
              <Th>{t('mapping.blocks.count')}</Th>
              <Th>{t('mapping.blocks.layers')}</Th>
              <Th>{t('mapping.blocks.target')}</Th>
            </tr>
          </thead>
          <tbody>
            {view.blocks.map((block, index) => (
              <tr key={block.name}>
                <Td>
                  <Ltr className="break-all">{block.name}</Ltr>
                </Td>
                <Td>
                  <Ltr>{block.count}</Ltr>
                </Td>
                <Td>
                  <Ltr className="break-all">{block.layers.join(', ')}</Ltr>
                </Td>
                <Td>
                  <RuleSelect
                    id={`block-target-${index}`}
                    label={`${t('mapping.blocks.target')}: ${block.name}`}
                    value={state.blocks[block.name] ?? 'follow'}
                    options={options}
                    disabled={disabled}
                    onChange={(choice) => onChange(block.name, choice)}
                  />
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Section>
  );
}

export function TextRulesTable({
  rows,
  state,
  disabled,
  truncated,
  onChange,
}: {
  rows: readonly TextRuleRow[];
  state: MappingFormState;
  disabled: boolean;
  truncated: boolean;
  onChange: (key: string, choice: TextChoice) => void;
}) {
  const { t } = useI18n();
  const options: { value: TextChoice; label: string }[] = [
    { value: 'none', label: t('mapping.texts.noRule') },
    ...POINT_FEATURE_TYPES.map((type) => ({ value: type, label: t(`featureType.${type}`) })),
  ];
  return (
    <Section id="mapping-texts" title={t('mapping.texts.title')}>
      <p className="text-sm opacity-80">{t('mapping.texts.hint')}</p>
      {truncated ? (
        <p className="text-sm">{t('mapping.texts.limited', { limit: MAPPING_TEXT_ROWS_LIMIT })}</p>
      ) : null}
      {rows.length === 0 ? (
        <p>{t('mapping.texts.none')}</p>
      ) : (
        <Table aria-label={t('mapping.texts.title')}>
          <thead>
            <tr>
              <Th>{t('mapping.texts.text')}</Th>
              <Th>{t('mapping.texts.layer')}</Th>
              <Th>{t('mapping.texts.count')}</Th>
              <Th>{t('mapping.texts.target')}</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={row.key}>
                <Td>
                  <Ltr className="break-all">{row.text}</Ltr>
                </Td>
                <Td>
                  <Ltr className="break-all">{row.layer}</Ltr>
                </Td>
                <Td>
                  <Ltr>{row.count ?? '—'}</Ltr>
                </Td>
                <Td>
                  <RuleSelect
                    id={`text-target-${index}`}
                    label={`${t('mapping.texts.target')}: ${row.text}`}
                    value={state.texts[row.key] ?? 'none'}
                    options={options}
                    disabled={disabled}
                    onChange={(choice) => onChange(row.key, choice)}
                  />
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Section>
  );
}
