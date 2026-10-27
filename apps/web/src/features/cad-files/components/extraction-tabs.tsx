'use client';

import type { ReactNode } from 'react';
import { CAD_CURVE_ENTITY_TYPES, type CadCurveEntityType } from '@ftth/shared';
import { Button } from '@/shared/ui/button';
import { ErrorNotice } from '@/shared/ui/error-notice';
import { Checkbox, Select } from '@/shared/ui/form-controls';
import { Input } from '@/shared/ui/input';
import { Ltr } from '@/shared/ui/ltr';
import { Pagination } from '@/shared/ui/pagination';
import { Table, Td, Th } from '@/shared/ui/table';
import { useI18n } from '@/shared/i18n/locale-provider';
import { formatNumber } from '@/shared/lib/format';
import { errorCodeOf } from '@/shared/api/bff-client';
import {
  EXTRACTION_PAGE_SIZE,
  useCurvesTab,
  useInsertsTab,
  useTextsTab,
} from '../hooks/use-extraction-tabs';

interface TabProps {
  projectId: string;
  cadFileId: string;
  layerNames: string[];
}

function LayerFilterSelect({
  id,
  value,
  layerNames,
  onChange,
}: {
  id: string;
  value: string;
  layerNames: string[];
  onChange: (layer: string) => void;
}) {
  const { t } = useI18n();
  return (
    <Select
      id={id}
      label={t('cad.filters.layer')}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    >
      <option value="">{t('cad.filters.allLayers')}</option>
      {layerNames.map((name) => (
        <option key={name} value={name}>
          {name}
        </option>
      ))}
    </Select>
  );
}

function PagedBody({
  state,
  children,
  page,
  total,
  onPage,
}: {
  state: { isPending: boolean; error: unknown; isFetching: boolean };
  children: ReactNode;
  page: number;
  total: number;
  onPage: (page: number) => void;
}) {
  const { t } = useI18n();
  if (state.error) return <ErrorNotice code={errorCodeOf(state.error)} />;
  if (state.isPending) return <p role="status">{t('common.loading')}</p>;
  return (
    <div aria-busy={state.isFetching}>
      {total === 0 ? <p>{t('cad.noRows')}</p> : children}
      {total > EXTRACTION_PAGE_SIZE ? (
        <Pagination
          page={page}
          pageSize={EXTRACTION_PAGE_SIZE}
          total={total}
          onPageChange={onPage}
        />
      ) : null}
    </div>
  );
}

export function InsertsTab({ projectId, cadFileId, layerNames }: TabProps) {
  const { t } = useI18n();
  const tab = useInsertsTab(projectId, cadFileId, true);
  const data = tab.query.data;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-4">
        <LayerFilterSelect
          id="ins-layer"
          value={tab.layer}
          layerNames={layerNames}
          onChange={tab.setLayer}
        />
        <form onSubmit={tab.onSubmitBlock} className="flex items-end gap-2">
          <Input
            id="ins-block"
            dir="ltr"
            label={t('cad.filters.blockName')}
            value={tab.blockDraft}
            onChange={(event) => tab.setBlockDraft(event.target.value)}
          />
          <Button type="submit" variant="outline">
            {t('cad.filters.apply')}
          </Button>
        </form>
      </div>
      <PagedBody state={tab.query} page={tab.page} total={data?.total ?? 0} onPage={tab.setPage}>
        <Table aria-label={t('cad.tabs.inserts')}>
          <thead>
            <tr>
              <Th>{t('cad.inserts.block')}</Th>
              <Th>{t('cad.filters.layer')}</Th>
              <Th>{t('cad.inserts.position')}</Th>
              <Th>{t('cad.inserts.rotation')}</Th>
              <Th>{t('cad.inserts.attributes')}</Th>
            </tr>
          </thead>
          <tbody>
            {data?.items.map((insert) => (
              <tr key={insert.id}>
                <Td>
                  <Ltr>{insert.blockName}</Ltr>
                  <div className="text-xs opacity-80">
                    {t('cad.handle')} <Ltr>{insert.handle}</Ltr>
                  </div>
                </Td>
                <Td>
                  <Ltr>{insert.layer}</Ltr>
                </Td>
                <Td>
                  <Ltr>
                    {formatNumber(insert.position.x, 'en', 3)},{' '}
                    {formatNumber(insert.position.y, 'en', 3)}
                  </Ltr>
                </Td>
                <Td>
                  <Ltr>{formatNumber(insert.rotation, 'en', 2)}°</Ltr>
                </Td>
                <Td>
                  {insert.attributes.length === 0 ? (
                    '—'
                  ) : (
                    <details>
                      <summary className="min-h-11 cursor-pointer py-2 focus-visible:outline-2 focus-visible:outline-(--color-focus)">
                        {t('cad.inserts.attributeCount', { count: insert.attributes.length })}
                      </summary>
                      <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                        {insert.attributes.map((attribute) => (
                          <div key={attribute.tag} className="contents">
                            <dt>
                              <Ltr>{attribute.tag}</Ltr>
                            </dt>
                            <dd dir="auto">
                              {attribute.value}
                              {!attribute.readable ? (
                                <span className="ms-2 text-xs">
                                  <span aria-hidden="true">▲ </span>
                                  {t('cad.texts.unreadable')}
                                </span>
                              ) : null}
                              {attribute.rawValue !== attribute.value ? (
                                <span className="block text-xs opacity-80">
                                  {t('cad.texts.raw')}: <Ltr>{attribute.rawValue}</Ltr>
                                </span>
                              ) : null}
                            </dd>
                          </div>
                        ))}
                      </dl>
                    </details>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </PagedBody>
    </div>
  );
}

export function TextsTab({ projectId, cadFileId, layerNames }: TabProps) {
  const { t } = useI18n();
  const tab = useTextsTab(projectId, cadFileId, true);
  const data = tab.query.data;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-4">
        <LayerFilterSelect
          id="txt-layer"
          value={tab.layer}
          layerNames={layerNames}
          onChange={tab.setLayer}
        />
        <form onSubmit={tab.onSubmitSearch} className="flex items-end gap-2">
          <Input
            id="txt-search"
            type="search"
            label={t('cad.filters.search')}
            value={tab.searchDraft}
            onChange={(event) => tab.setSearchDraft(event.target.value)}
          />
          <Button type="submit" variant="outline">
            {t('cad.filters.apply')}
          </Button>
        </form>
        <Checkbox
          id="txt-unreadable"
          label={t('cad.texts.unreadableOnly')}
          checked={tab.unreadableOnly}
          onChange={(event) => tab.setUnreadableOnly(event.target.checked)}
        />
        <Checkbox
          id="txt-raw"
          label={t('cad.texts.showRaw')}
          checked={tab.showRaw}
          onChange={(event) => tab.setShowRaw(event.target.checked)}
        />
      </div>
      <PagedBody state={tab.query} page={tab.page} total={data?.total ?? 0} onPage={tab.setPage}>
        <Table aria-label={t('cad.tabs.texts')}>
          <thead>
            <tr>
              <Th>{t('cad.texts.decoded')}</Th>
              {tab.showRaw ? <Th>{t('cad.texts.raw')}</Th> : null}
              <Th>{t('cad.filters.layer')}</Th>
              <Th>{t('cad.texts.kind')}</Th>
              <Th>{t('cad.inserts.position')}</Th>
              <Th>{t('cad.texts.font')}</Th>
              <Th>{t('cad.texts.readability')}</Th>
            </tr>
          </thead>
          <tbody>
            {data?.items.map((text) => (
              <tr key={text.id}>
                <Td>
                  <span dir="auto" className="whitespace-pre-wrap">
                    {text.text}
                  </span>
                  <div className="text-xs opacity-80">
                    {t('cad.handle')} <Ltr>{text.handle}</Ltr>
                  </div>
                </Td>
                {tab.showRaw ? (
                  <Td>
                    <Ltr className="break-all whitespace-pre-wrap">{text.rawText}</Ltr>
                  </Td>
                ) : null}
                <Td>
                  <Ltr>{text.layer}</Ltr>
                </Td>
                <Td>{t(`cad.texts.kinds.${text.kind}`)}</Td>
                <Td>
                  <Ltr>
                    {formatNumber(text.position.x, 'en', 3)},{' '}
                    {formatNumber(text.position.y, 'en', 3)}
                  </Ltr>
                </Td>
                <Td>
                  <Ltr>{text.font ?? text.style ?? '—'}</Ltr>
                </Td>
                <Td>
                  {text.readable ? (
                    <span>
                      <span aria-hidden="true">✓ </span>
                      {t('cad.texts.readable')}
                    </span>
                  ) : (
                    <span className="font-semibold">
                      <span aria-hidden="true">▲ </span>
                      {t('cad.texts.unreadable')}
                    </span>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </PagedBody>
    </div>
  );
}

export function CurvesTab({ projectId, cadFileId, layerNames }: TabProps) {
  const { t, locale } = useI18n();
  const tab = useCurvesTab(projectId, cadFileId, true);
  const data = tab.query.data;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-4">
        <LayerFilterSelect
          id="crv-layer"
          value={tab.layer}
          layerNames={layerNames}
          onChange={tab.setLayer}
        />
        <Select
          id="crv-type"
          label={t('cad.curves.type')}
          value={tab.entityType}
          onChange={(event) => tab.setEntityType(event.target.value as CadCurveEntityType | '')}
        >
          <option value="">{t('cad.curves.allTypes')}</option>
          {CAD_CURVE_ENTITY_TYPES.map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </Select>
      </div>
      <PagedBody state={tab.query} page={tab.page} total={data?.total ?? 0} onPage={tab.setPage}>
        <Table aria-label={t('cad.tabs.curves')}>
          <thead>
            <tr>
              <Th>{t('cad.curves.type')}</Th>
              <Th>{t('cad.filters.layer')}</Th>
              <Th>{t('cad.curves.length')}</Th>
              <Th>{t('cad.curves.vertices')}</Th>
              <Th>{t('cad.curves.closed')}</Th>
              <Th>{t('cad.curves.approximated')}</Th>
            </tr>
          </thead>
          <tbody>
            {data?.items.map((curve) => (
              <tr key={curve.id}>
                <Td>
                  <Ltr>{curve.entityType}</Ltr>
                  <div className="text-xs opacity-80">
                    {t('cad.handle')} <Ltr>{curve.handle}</Ltr>
                  </div>
                </Td>
                <Td>
                  <Ltr>{curve.layer}</Ltr>
                </Td>
                <Td>
                  <Ltr>{formatNumber(curve.length, locale, 3)}</Ltr>
                </Td>
                <Td>
                  <Ltr>{curve.vertexCount}</Ltr>
                </Td>
                <Td>{curve.isClosed ? t('common.yes') : t('common.no')}</Td>
                <Td>{curve.approximated ? t('common.yes') : t('common.no')}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </PagedBody>
    </div>
  );
}
