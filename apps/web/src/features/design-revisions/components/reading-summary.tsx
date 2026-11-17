'use client';

import type { ReadingTotals } from '@ftth/shared';
import { Ltr } from '@/shared/ui/ltr';
import { Table, Td, Th } from '@/shared/ui/table';
import { useI18n } from '@/shared/i18n/locale-provider';
import { formatDecimal } from '@/shared/lib/decimal';

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <h4 className="text-sm font-semibold">{title}</h4>
      {children}
    </div>
  );
}

/**
 * What the drawing reading counted (ADR-041, roles mode only): bundles by type with the WRITTEN
 * length, and per drawing kind — Secondary: connectors, spares and end caps; General: cables by
 * cores and handholes by type. Compact tables; numbers stay left-to-right.
 */
export function ReadingSummary({ reading }: { reading: ReadingTotals }) {
  const { t } = useI18n();
  const none = t('design.reading.none');
  const ways = (value: number | null) =>
    value === null ? none : t('design.reading.ways', { count: value });
  return (
    <section aria-label={t('design.reading.title')} className="flex flex-col gap-3">
      <h3 className="font-semibold">{t('design.reading.title')}</h3>
      <p className="text-sm opacity-80">{t('design.reading.hint')}</p>

      {reading.bundles.length > 0 ? (
        <Block title={t('design.reading.bundles')}>
          <Table aria-label={t('design.reading.bundles')}>
            <thead>
              <tr>
                <Th>{t('design.reading.type')}</Th>
                <Th>{t('design.reading.ductSize')}</Th>
                <Th>{t('design.reading.count')}</Th>
                <Th>{t('design.reading.writtenLength')}</Th>
                <Th>{t('design.reading.withoutLength')}</Th>
              </tr>
            </thead>
            <tbody>
              {reading.bundles.map((bundle) => (
                <tr key={`${bundle.ways ?? 'x'}|${bundle.ductSize ?? 'x'}`}>
                  <Td>{ways(bundle.ways)}</Td>
                  <Td>{bundle.ductSize ? <Ltr>{bundle.ductSize}</Ltr> : none}</Td>
                  <Td>
                    <Ltr>{bundle.count}</Ltr>
                  </Td>
                  <Td>
                    <Ltr>{formatDecimal(bundle.writtenLengthM, 'en')}</Ltr>
                  </Td>
                  <Td>
                    <Ltr>{bundle.withoutLength}</Ltr>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Block>
      ) : null}

      {reading.connectors.length > 0 || reading.spares.length > 0 ? (
        <Block title={t('design.reading.fittings')}>
          <Table aria-label={t('design.reading.fittings')}>
            <thead>
              <tr>
                <Th>{t('design.reading.item')}</Th>
                <Th>{t('design.reading.ductSize')}</Th>
                <Th>{t('design.reading.count')}</Th>
              </tr>
            </thead>
            <tbody>
              {reading.connectors.map((row) => (
                <tr key={`connector|${row.ductSize ?? 'x'}`}>
                  <Td>{t('design.reading.connectors')}</Td>
                  <Td>{row.ductSize ? <Ltr>{row.ductSize}</Ltr> : none}</Td>
                  <Td>
                    <Ltr>{row.count}</Ltr>
                  </Td>
                </tr>
              ))}
              {reading.spares.map((row) => (
                <tr key={`spare|${row.ductSize}`}>
                  <Td>{t('design.reading.spares')}</Td>
                  <Td>
                    <Ltr>{row.ductSize}</Ltr>
                  </Td>
                  <Td>
                    <Ltr>{row.singles}</Ltr>
                  </Td>
                </tr>
              ))}
              {reading.spares.map((row) => (
                <tr key={`caps|${row.ductSize}`}>
                  <Td>{t('design.reading.endCaps')}</Td>
                  <Td>
                    <Ltr>{row.ductSize}</Ltr>
                  </Td>
                  <Td>
                    <Ltr>{row.endCaps}</Ltr>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Block>
      ) : null}

      {reading.cables.length > 0 ? (
        <Block title={t('design.reading.cables')}>
          <Table aria-label={t('design.reading.cables')}>
            <thead>
              <tr>
                <Th>{t('design.reading.cores')}</Th>
                <Th>{t('design.reading.count')}</Th>
                <Th>{t('design.reading.writtenLength')}</Th>
              </tr>
            </thead>
            <tbody>
              {reading.cables.map((cable) => (
                <tr key={cable.cores}>
                  <Td>
                    <Ltr>{cable.cores}</Ltr>
                  </Td>
                  <Td>
                    <Ltr>{cable.count}</Ltr>
                  </Td>
                  <Td>
                    <Ltr>{formatDecimal(cable.writtenLengthM, 'en')}</Ltr>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Block>
      ) : null}

      {reading.handholes.length > 0 ? (
        <Block title={t('design.reading.handholes')}>
          <Table aria-label={t('design.reading.handholes')}>
            <thead>
              <tr>
                <Th>{t('design.reading.handholeType')}</Th>
                <Th>{t('design.reading.count')}</Th>
              </tr>
            </thead>
            <tbody>
              {reading.handholes.map((row) => (
                <tr key={row.type ?? 'untyped'}>
                  <Td>{row.type ? <Ltr>{row.type}</Ltr> : t('design.reading.untyped')}</Td>
                  <Td>
                    <Ltr>{row.count}</Ltr>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Block>
      ) : null}
    </section>
  );
}
