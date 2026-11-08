'use client';

import { useMemo, useState } from 'react';
import { ltr } from '@ftth/i18n';
import {
  PLACEMENT_SOURCE_CRS,
  type ControlPoint,
  type PlacementDrawing,
  type PlacementItem,
  type PlacementSourceCrs,
} from '@ftth/shared';
import { Button } from '@/shared/ui/button';
import { Card } from '@/shared/ui/card';
import { Checkbox, Select } from '@/shared/ui/form-controls';
import { Input } from '@/shared/ui/input';
import { Ltr } from '@/shared/ui/ltr';
import { Notice } from '@/shared/ui/notice';
import { Table, Td, Th } from '@/shared/ui/table';
import { useI18n } from '@/shared/i18n/locale-provider';
import { readKmlBytes, type KmlError, type Placemark } from '../model/kml';
import type { PlacementFormState, PlacementSolved } from '../model/placement-form';
import { itemLabel, itemOption, suggestMatches } from '../model/placement-match';

export interface PlacementPanelProps {
  drawing: PlacementDrawing | null;
  state: PlacementFormState;
  solved: PlacementSolved;
  /** Detection says the coordinates read as Red Belt. */
  suggestedRedBelt: boolean;
  disabled: boolean;
  onSourceCrsChange: (value: PlacementSourceCrs) => void;
  onAddPoints: (points: Omit<ControlPoint, 'id'>[]) => void;
  onUpdatePoint: (id: string, patch: Partial<Omit<ControlPoint, 'id'>>) => void;
  onRemovePoint: (id: string) => void;
  onFitScaleChange: (value: boolean) => void;
}

const MANUAL = '__manual__';

/** Control points from typed Lat/Lon or a KML / KMZ, with their errors (ADR-035). */
export function PlacementPanel(props: PlacementPanelProps) {
  const { t } = useI18n();
  const { state, solved, disabled } = props;
  const items = props.drawing?.items ?? [];
  const residuals = new Map(
    solved.ok ? solved.solution.residuals.map((residual) => [residual.id, residual]) : [],
  );
  const used = state.points.filter((point) => !point.excluded).length;

  return (
    <Card aria-labelledby="placement-title" role="region" className="flex flex-col gap-4">
      <h2 id="placement-title" className="text-lg font-semibold">
        {t('mapping.placement.title')}
      </h2>
      <p className="text-sm">{t('mapping.placement.intro')}</p>

      <div className="max-w-xl">
        <Select
          id="placement-source"
          label={t('mapping.placement.sourceCrs')}
          hint={props.suggestedRedBelt ? t('mapping.placement.suggestedRedBelt') : undefined}
          value={state.sourceCrs}
          disabled={disabled}
          onChange={(event) => props.onSourceCrsChange(event.target.value as PlacementSourceCrs)}
        >
          {PLACEMENT_SOURCE_CRS.map((value) => (
            <option key={value} value={value}>
              {t(`mapping.placement.source.${value}`)}
            </option>
          ))}
        </Select>
      </div>

      <section aria-labelledby="placement-points" className="flex flex-col gap-2">
        <h3 id="placement-points" className="font-semibold">
          {t('mapping.placement.points')}
        </h3>
        {state.points.length === 0 ? (
          <p className="text-sm">{t('mapping.placement.noPoints')}</p>
        ) : (
          <div className="overflow-x-auto">
            <Table aria-label={t('mapping.placement.points')}>
              <thead>
                <tr>
                  <Th>{t('mapping.placement.col.item')}</Th>
                  <Th>{t('mapping.placement.col.drawing')}</Th>
                  <Th>{t('mapping.placement.col.latlon')}</Th>
                  <Th>{t('mapping.placement.col.from')}</Th>
                  <Th>{t('mapping.placement.col.error')}</Th>
                  <Th>{t('mapping.placement.col.use')}</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {state.points.map((point) => {
                  const residual = residuals.get(point.id);
                  return (
                    <tr key={point.id}>
                      <Td>
                        <Ltr>{point.id}</Ltr> {point.label ? <bdi>{point.label}</bdi> : null}
                      </Td>
                      <Td>
                        <Ltr>
                          {fixed(point.drawing.x, 3)}, {fixed(point.drawing.y, 3)}
                        </Ltr>
                      </Td>
                      <Td>
                        <Ltr>
                          {fixed(point.lat, 7)}, {fixed(point.lon, 7)}
                        </Ltr>
                      </Td>
                      <Td>{t(`mapping.placement.from.${point.source}`)}</Td>
                      <Td>
                        {residual ? (
                          <span className="inline-flex items-center gap-1">
                            <Ltr>{fixed(residual.errorM, 2)}</Ltr>
                            {residual.outlier ? (
                              <span
                                className="text-(--status-rejected)"
                                title={t('mapping.placement.outlier')}
                              >
                                <span aria-hidden="true">▲</span>
                                <span className="sr-only">{t('mapping.placement.outlier')}</span>
                              </span>
                            ) : null}
                          </span>
                        ) : (
                          '—'
                        )}
                      </Td>
                      <Td>
                        <input
                          type="checkbox"
                          aria-label={t('mapping.placement.use', { id: point.id })}
                          className="size-5"
                          checked={!point.excluded}
                          disabled={disabled}
                          onChange={(event) =>
                            props.onUpdatePoint(point.id, { excluded: !event.target.checked })
                          }
                        />
                      </Td>
                      <Td>
                        <Button
                          variant="outline"
                          disabled={disabled}
                          aria-label={t('mapping.placement.remove', { id: point.id })}
                          onClick={() => props.onRemovePoint(point.id)}
                        >
                          ×
                        </Button>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          </div>
        )}
        {used === 2 ? (
          <Checkbox
            id="placement-fit-scale"
            label={t('mapping.placement.fitScale')}
            checked={state.fitScaleWithTwoPoints}
            disabled={disabled}
            onChange={(event) => props.onFitScaleChange(event.target.checked)}
          />
        ) : null}
        <PlacementSummary solved={solved} />
      </section>

      {disabled ? null : (
        <>
          <AddPointForm
            items={items}
            mappingSaved={props.drawing === null || props.drawing.mappingVersion !== null}
            onAdd={props.onAddPoints}
          />
          <KmlImport items={items} onAdd={props.onAddPoints} />
        </>
      )}
    </Card>
  );
}

function PlacementSummary({ solved }: { solved: PlacementSolved }) {
  const { t } = useI18n();
  if (!solved.ok) {
    return <Notice kind="error">{t(`mapping.placement.error.${solved.error}`)}</Notice>;
  }
  const { solution } = solved;
  return (
    <div className="flex flex-col gap-2">
      <dl className="grid grid-cols-3 gap-3 sm:max-w-xl">
        <div>
          <dt className="text-sm opacity-80">{t('mapping.placement.summary.used')}</dt>
          <dd className="font-semibold">
            <Ltr>{solution.pointsUsed}</Ltr>
          </dd>
        </div>
        <div>
          <dt className="text-sm opacity-80">{t('mapping.placement.summary.scale')}</dt>
          <dd className="font-semibold">
            <Ltr>{fixed(solution.scale, 6)}</Ltr>
          </dd>
        </div>
        <div>
          <dt className="text-sm opacity-80">{t('mapping.placement.summary.rotation')}</dt>
          <dd className="font-semibold">
            <Ltr>{fixed(solution.rotationDeg, 4)}°</Ltr>
          </dd>
        </div>
      </dl>
      {solution.scaleWarning ? (
        <Notice kind="warning">{t('mapping.placement.summary.scaleWarning')}</Notice>
      ) : null}
    </div>
  );
}

function AddPointForm({
  items,
  mappingSaved,
  onAdd,
}: {
  items: readonly PlacementItem[];
  /** False when the file has no saved mapping: its rules classify the items (ADR-037). */
  mappingSaved: boolean;
  onAdd: PlacementPanelProps['onAddPoints'];
}) {
  const { t } = useI18n();
  const [chosenHandle, setItemHandle] = useState('');
  // Items may arrive after the form: without any, only a typed drawing X / Y is possible.
  const itemHandle = items.length === 0 ? MANUAL : chosenHandle;
  const [x, setX] = useState('');
  const [y, setY] = useState('');
  const [lat, setLat] = useState('');
  const [lon, setLon] = useState('');
  const [error, setError] = useState<'xy' | 'latlon' | null>(null);

  const add = () => {
    const item = items.find((candidate) => candidate.handle === itemHandle);
    const drawing = item ? { x: item.x, y: item.y } : { x: num(x), y: num(y) };
    if (!Number.isFinite(drawing.x) || !Number.isFinite(drawing.y)) return setError('xy');
    const latValue = num(lat);
    const lonValue = num(lon);
    if (!(Math.abs(latValue) <= 90) || !(Math.abs(lonValue) <= 180)) return setError('latlon');
    setError(null);
    onAdd([
      {
        drawing,
        handle: item?.handle ?? null,
        label: item ? itemOption(item) : null,
        lat: latValue,
        lon: lonValue,
        source: 'typed',
        excluded: false,
      },
    ]);
    setLat('');
    setLon('');
  };

  return (
    <section aria-labelledby="placement-add" className="flex flex-col gap-3">
      <h3 id="placement-add" className="font-semibold">
        {t('mapping.placement.add')}
      </h3>
      {!mappingSaved ? <p className="text-sm">{t('mapping.placement.noMapping')}</p> : null}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Select
          id="placement-item"
          label={t('mapping.placement.item')}
          value={itemHandle}
          onChange={(event) => setItemHandle(event.target.value)}
        >
          {items.length > 0 ? (
            <option value="">{t('mapping.placement.itemPlaceholder')}</option>
          ) : null}
          {items.map((item) => (
            <option key={item.handle} value={item.handle}>
              {t(`mapping.placement.itemType.${item.featureType}`)} {itemOption(item)}
            </option>
          ))}
          <option value={MANUAL}>{t('mapping.placement.itemManual')}</option>
        </Select>
        {itemHandle === MANUAL ? (
          <>
            <Input
              id="placement-x"
              dir="ltr"
              inputMode="decimal"
              label={t('mapping.placement.drawingX')}
              value={x}
              onChange={(event) => setX(event.target.value)}
            />
            <Input
              id="placement-y"
              dir="ltr"
              inputMode="decimal"
              label={t('mapping.placement.drawingY')}
              value={y}
              onChange={(event) => setY(event.target.value)}
            />
          </>
        ) : null}
        <Input
          id="placement-lat"
          dir="ltr"
          inputMode="decimal"
          label={t('mapping.placement.lat')}
          value={lat}
          onChange={(event) => setLat(event.target.value)}
        />
        <Input
          id="placement-lon"
          dir="ltr"
          inputMode="decimal"
          label={t('mapping.placement.lon')}
          value={lon}
          onChange={(event) => setLon(event.target.value)}
        />
      </div>
      {error ? (
        <p className="flex items-center gap-1 text-sm text-(--status-rejected)" role="alert">
          <span aria-hidden="true">⚠</span>
          {t(error === 'xy' ? 'mapping.placement.xyInvalid' : 'mapping.placement.latLonInvalid')}
        </p>
      ) : null}
      <div>
        <Button variant="outline" disabled={itemHandle === ''} onClick={add}>
          {t('mapping.placement.addPoint')}
        </Button>
      </div>
    </section>
  );
}

function KmlImport({
  items,
  onAdd,
}: {
  items: readonly PlacementItem[];
  onAdd: PlacementPanelProps['onAddPoints'];
}) {
  const { t } = useI18n();
  const [placemarks, setPlacemarks] = useState<Placemark[]>([]);
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [error, setError] = useState<KmlError | null>(null);
  const suggested = useMemo(() => suggestMatches(placemarks, items), [placemarks, items]);
  const byHandle = useMemo(() => new Map(items.map((item) => [item.handle, item])), [items]);
  const matched = placemarks.filter((placemark) => byHandle.has(chosen[placemark.id] ?? ''));

  const read = async (file: File | undefined) => {
    if (!file) return;
    const result = readKmlBytes(new Uint8Array(await file.arrayBuffer()));
    if (!result.ok) {
      setError(result.error);
      setPlacemarks([]);
      return;
    }
    setError(null);
    setPlacemarks(result.placemarks);
    setChosen(suggestMatches(result.placemarks, items));
  };

  const addMatched = () => {
    onAdd(
      matched.flatMap((placemark) => {
        const item = byHandle.get(chosen[placemark.id] ?? '');
        if (!item) return [];
        return [
          {
            drawing: { x: item.x, y: item.y },
            handle: item.handle,
            label: placemark.name ? `${itemLabel(item)} ↔ ${placemark.name}` : itemLabel(item),
            lat: placemark.lat,
            lon: placemark.lon,
            source: 'kml' as const,
            excluded: false,
          },
        ];
      }),
    );
    setPlacemarks([]);
    setChosen({});
  };

  return (
    <section aria-labelledby="placement-kml" className="flex flex-col gap-3">
      <h3 id="placement-kml" className="font-semibold">
        {t('mapping.placement.kml.title')}
      </h3>
      <p className="text-sm">{t('mapping.placement.kml.hint')}</p>
      <div className="flex flex-col gap-1">
        <label htmlFor="placement-kml-file" className="text-sm font-medium">
          {t('mapping.placement.kml.file')}
        </label>
        <input
          id="placement-kml-file"
          type="file"
          accept=".kml,.kmz,application/vnd.google-earth.kml+xml,application/vnd.google-earth.kmz"
          className="min-h-11"
          onChange={(event) => void read(event.target.files?.[0])}
        />
      </div>
      {error ? <Notice kind="error">{t(`mapping.placement.kml.${error}`)}</Notice> : null}
      {placemarks.length > 0 ? (
        <>
          <p className="text-sm" role="status">
            {t('mapping.placement.kml.count', { count: ltr(placemarks.length) })}
          </p>
          <div className="max-h-96 overflow-auto">
            <Table aria-label={t('mapping.placement.kml.title')}>
              <thead>
                <tr>
                  <Th>{t('mapping.placement.kml.placemark')}</Th>
                  <Th>{t('mapping.placement.col.latlon')}</Th>
                  <Th>{t('mapping.placement.col.item')}</Th>
                </tr>
              </thead>
              <tbody>
                {placemarks.map((placemark, index) => (
                  <tr key={placemark.id}>
                    <Td>
                      <bdi>{placemark.name || '—'}</bdi>
                    </Td>
                    <Td>
                      <Ltr>
                        {fixed(placemark.lat, 7)}, {fixed(placemark.lon, 7)}
                      </Ltr>
                    </Td>
                    <Td>
                      <div className="flex flex-wrap items-center gap-2">
                        <select
                          id={`placement-kml-match-${index}`}
                          aria-label={t('mapping.placement.kml.matchFor', {
                            name: placemark.name || placemark.id,
                          })}
                          value={chosen[placemark.id] ?? ''}
                          onChange={(event) =>
                            setChosen((current) => ({
                              ...current,
                              [placemark.id]: event.target.value,
                            }))
                          }
                          className="min-h-11 rounded-md border border-(--color-border) bg-transparent px-2 text-base focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-focus)"
                        >
                          <option value="">{t('mapping.placement.kml.noMatch')}</option>
                          {items.map((item) => (
                            <option key={item.handle} value={item.handle}>
                              {t(`mapping.placement.itemType.${item.featureType}`)}{' '}
                              {itemOption(item)}
                            </option>
                          ))}
                        </select>
                        {suggested[placemark.id] !== undefined &&
                        suggested[placemark.id] === chosen[placemark.id] ? (
                          <span className="text-sm">
                            <span aria-hidden="true">✦</span> {t('mapping.placement.kml.suggested')}
                          </span>
                        ) : null}
                      </div>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
          <div>
            <Button variant="outline" disabled={matched.length === 0} onClick={addMatched}>
              {t('mapping.placement.kml.addMatched', { count: ltr(matched.length) })}
            </Button>
          </div>
        </>
      ) : null}
    </section>
  );
}

const num = (text: string) => (text.trim() === '' ? Number.NaN : Number(text.trim()));
const fixed = (value: number, digits: number) => value.toFixed(digits);
