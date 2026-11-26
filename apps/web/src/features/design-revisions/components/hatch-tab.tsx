'use client';

import { useId, useState, type ReactNode } from 'react';
import {
  GRADIENT_PATTERNS,
  HATCH_DRAW_ORDERS,
  HATCH_ISLAND_STYLES,
  HATCH_LINE_PATTERNS,
  MAX_HATCH_TRANSPARENCY,
  type GradientPattern,
  type HatchLinePattern,
} from '@ftth/shared';
import { useI18n } from '@/shared/i18n/locale-provider';
import type { HatchSettings, HatchType } from '../hooks/hatch-command';
import type { CanvasEditState } from '../hooks/use-canvas-edit';
import { ACI_COLORS } from '../model/cad-commands';
import { familiesOf, familyGap, patternSegments } from '../model/hatch-patterns';

/**
 * AutoCAD's contextual «Hatch Creation» ribbon tab (ADR-055 part 8), shown while HATCH or GRADIENT
 * runs: Boundaries (Pick Points, Select, Remove; Recreate greyed), the Pattern gallery, Properties
 * (type, colour, background, transparency, angle, scale), Origin, Options (Associative, Annotative
 * and Match Properties greyed with the reason; gap tolerance, separate hatches, island detection,
 * draw order) and Close Hatch Creation. Every change is drawn at once on the hatch being made.
 */

const FIELD = 'min-h-7 rounded border border-[#4a505a] bg-[#1d2127] px-1 text-xs text-[#e8eaed]';
const TILE = 'text-[#e8eaed] hover:bg-white/10';
const ON = 'bg-[#3d6fb6] text-white';

function TabPanel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div
      role="group"
      aria-label={title}
      className="flex flex-col border-e border-[#454b55] px-2 last:border-e-0"
    >
      <div className="flex flex-1 items-start gap-1">{children}</div>
      <div
        dir="ltr"
        className="mt-1 rounded-sm bg-[#22262c] text-center text-[11px] text-[#aab0b8]"
      >
        {title}
      </div>
    </div>
  );
}

function Big({
  label,
  onClick,
  disabled,
  title,
  pressed,
  children,
}: {
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
  pressed?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      title={title ?? label}
      disabled={disabled}
      onClick={onClick}
      className={`flex min-h-16 min-w-14 flex-col items-center justify-center gap-1 rounded px-1.5 py-1 text-[11px] disabled:opacity-40 ${
        pressed ? ON : TILE
      }`}
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        className="size-6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
      >
        {children}
      </svg>
      <span dir="ltr" className="whitespace-nowrap">
        {label}
      </span>
    </button>
  );
}

/** A swatch of a pattern, drawn with the pattern's own line families. */
function Swatch({ pattern, solid }: { pattern: HatchLinePattern; solid?: boolean }) {
  const clip = useId();
  if (solid || pattern === 'SOLID')
    return <rect x="0" y="0" width="24" height="24" fill="currentColor" />;
  const families = familiesOf(pattern, 1, true);
  const finest = Math.min(...families.map(familyGap));
  // About four repeats of the finest line family across the swatch.
  const scale = finest > 0 ? 6 / finest : 1;
  const segments =
    patternSegments(families, {
      angle: 0,
      scale,
      origin: [0, 0],
      box: { minX: 0, minY: 0, maxX: 24, maxY: 24 },
    }) ?? [];
  return (
    <>
      <clipPath id={clip}>
        <rect x="0" y="0" width="24" height="24" />
      </clipPath>
      <g clipPath={`url(#${clip})`}>
        {segments.map((s, i) =>
          s.a[0] === s.b[0] && s.a[1] === s.b[1] ? (
            <circle key={i} cx={s.a[0]} cy={24 - s.a[1]} r="0.7" fill="currentColor" />
          ) : (
            <line
              key={i}
              x1={s.a[0]}
              y1={24 - s.a[1]}
              x2={s.b[0]}
              y2={24 - s.b[1]}
              strokeWidth="0.8"
            />
          ),
        )}
      </g>
    </>
  );
}

function GradientSwatch({ name }: { name: GradientPattern }) {
  const id = useId();
  const radial = name.includes('SPH') || name.includes('HEM');
  const inverse = name.includes('INV');
  const [a, b] = inverse ? ['#ffffff', '#3d6fb6'] : ['#3d6fb6', '#ffffff'];
  const stops = name.includes('CYL')
    ? [
        [0, a],
        [0.5, b],
        [1, a],
      ]
    : radial
      ? [
          [0, b],
          [1, a],
        ]
      : [
          [0, a],
          [1, b],
        ];
  return (
    <>
      <defs>
        {radial ? (
          <radialGradient id={id} cy={name.includes('HEM') ? '1' : '0.5'}>
            {stops.map(([o, c]) => (
              <stop key={String(o)} offset={String(o)} stopColor={String(c)} />
            ))}
          </radialGradient>
        ) : (
          <linearGradient id={id}>
            {stops.map(([o, c]) => (
              <stop key={String(o)} offset={String(o)} stopColor={String(c)} />
            ))}
          </linearGradient>
        )}
      </defs>
      <rect x="0" y="0" width="24" height="24" fill={`url(#${id})`} stroke="none" />
    </>
  );
}

function ColorSelect({
  label,
  value,
  empty,
  onChange,
}: {
  label: string;
  value: string | null;
  empty: string;
  onChange: (value: string | null) => void;
}) {
  return (
    <label className="flex items-center gap-1 text-xs">
      <span className="w-28 truncate" title={label}>
        {label}
      </span>
      <select
        aria-label={label}
        className={`${FIELD} w-28`}
        value={value ?? ''}
        onChange={(event) => onChange(event.target.value || null)}
      >
        <option value="">{empty}</option>
        {ACI_COLORS.map((c) => (
          <option key={c.hex} value={c.hex}>
            {c.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function NumberInput({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max?: number;
  step: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="flex items-center gap-1 text-xs">
      <span className="w-28 truncate" title={label}>
        {label}
      </span>
      <input
        type="number"
        dir="ltr"
        aria-label={label}
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(event) => {
          const next = Number(event.target.value);
          if (Number.isFinite(next) && next >= min && (max === undefined || next <= max)) {
            onChange(next);
          }
        }}
        className={`${FIELD} w-20`}
      />
    </label>
  );
}

export function HatchCreationTab({ edit }: { edit: CanvasEditState }) {
  const { t } = useI18n();
  const [more, setMore] = useState(false);
  const hatch = edit.hatch;
  if (!hatch) return null;
  const h = hatch.settings;
  const set = hatch.set;
  const gradient = h.type === 'gradient';
  const user = h.type === 'user';
  const types: HatchType[] = ['pattern', 'solid', 'gradient', 'user'];
  const typeName: Record<HatchType, string> = {
    pattern: t('design.cad.hatch.typePattern'),
    solid: t('design.cad.hatch.typeSolid'),
    gradient: t('design.cad.hatch.typeGradient'),
    user: t('design.cad.hatch.typeUser'),
  };
  const choose = (pattern: HatchLinePattern) =>
    set(
      pattern === 'SOLID'
        ? { type: 'solid' }
        : pattern === 'USER'
          ? { type: 'user' }
          : { type: 'pattern', pattern },
    );
  const selected = (pattern: HatchLinePattern) =>
    (pattern === 'SOLID' && h.type === 'solid') ||
    (pattern === 'USER' && h.type === 'user') ||
    (h.type === 'pattern' && h.pattern === pattern);
  return (
    <div
      role="tabpanel"
      aria-label={t('design.cad.hatch.tab')}
      className="flex flex-wrap items-stretch gap-y-2 py-1.5"
    >
      <TabPanel title={t('design.cad.hatch.boundaries')}>
        <Big
          label={t('design.cad.hatch.pickPoints')}
          pressed={edit.prompt.key === 'hatchPick'}
          onClick={() => edit.chooseOption('K')}
        >
          <path d="M4 4h16v16H4z" />
          <path d="M12 9v6M9 12h6" />
        </Big>
        <div className="flex flex-col gap-0.5">
          <button
            type="button"
            aria-pressed={edit.prompt.key === 'hatchSelect'}
            onClick={() => edit.chooseOption('S')}
            className={`min-h-7 rounded px-1.5 text-start text-xs ${
              edit.prompt.key === 'hatchSelect' ? ON : TILE
            }`}
          >
            {t('design.cad.hatch.select')}
          </button>
          <button
            type="button"
            aria-pressed={edit.prompt.key === 'hatchRemove'}
            disabled={hatch.loops === 0}
            onClick={() => edit.chooseOption('B')}
            className={`min-h-7 rounded px-1.5 text-start text-xs disabled:opacity-40 ${
              edit.prompt.key === 'hatchRemove' ? ON : TILE
            }`}
          >
            {t('design.cad.hatch.remove')}
          </button>
          <button
            type="button"
            disabled
            title={t('design.cad.hatch.recreateReason')}
            className={`min-h-7 rounded px-1.5 text-start text-xs opacity-40 ${TILE}`}
          >
            {t('design.cad.hatch.recreate')}
          </button>
          <span dir="ltr" className="px-1.5 text-[11px] text-[#aab0b8]">
            {t('design.cad.hatch.loops', { count: hatch.loops })}
          </span>
        </div>
      </TabPanel>
      <TabPanel title={t('design.cad.hatch.pattern')}>
        <div
          role="listbox"
          aria-label={t('design.cad.hatch.pattern')}
          className="grid max-h-24 grid-cols-8 gap-0.5 overflow-y-auto pe-1"
        >
          {gradient
            ? GRADIENT_PATTERNS.map((name) => (
                <button
                  key={name}
                  type="button"
                  role="option"
                  aria-selected={h.gradient === name}
                  aria-label={name}
                  title={name}
                  onClick={() => set({ gradient: name })}
                  className={`size-9 rounded border p-0.5 ${
                    h.gradient === name ? 'border-[#6fa3ff]' : 'border-transparent'
                  }`}
                >
                  <svg aria-hidden="true" viewBox="0 0 24 24" className="size-full">
                    <GradientSwatch name={name} />
                  </svg>
                </button>
              ))
            : HATCH_LINE_PATTERNS.map((name) => (
                <button
                  key={name}
                  type="button"
                  role="option"
                  aria-selected={selected(name)}
                  aria-label={name}
                  title={name}
                  onClick={() => choose(name)}
                  className={`size-9 rounded border bg-[#1d2127] p-0.5 text-[#e8eaed] ${
                    selected(name) ? 'border-[#6fa3ff]' : 'border-transparent'
                  }`}
                >
                  <svg
                    aria-hidden="true"
                    viewBox="0 0 24 24"
                    className="size-full"
                    stroke="currentColor"
                  >
                    {name === 'USER' ? <Swatch pattern="LINE" /> : <Swatch pattern={name} />}
                  </svg>
                </button>
              ))}
        </div>
      </TabPanel>
      <TabPanel title={t('design.cad.hatch.properties')}>
        <div className="flex flex-col gap-0.5">
          <label className="flex items-center gap-1 text-xs">
            <span className="w-28">{t('design.cad.hatch.type')}</span>
            <select
              aria-label={t('design.cad.hatch.type')}
              className={`${FIELD} w-28`}
              value={h.type}
              onChange={(event) => set({ type: event.target.value as HatchType })}
            >
              {types.map((type) => (
                <option key={type} value={type}>
                  {typeName[type]}
                </option>
              ))}
            </select>
          </label>
          <ColorSelect
            label={t('design.cad.hatch.color')}
            value={h.color}
            empty={t('design.cad.hatch.useCurrent')}
            onChange={(color) => set({ color })}
          />
          {gradient ? (
            <ColorSelect
              label={t('design.cad.hatch.color2')}
              value={h.color2}
              empty="White"
              onChange={(color2) => set({ color2 })}
            />
          ) : (
            <ColorSelect
              label={t('design.cad.hatch.background')}
              value={h.background}
              empty={t('design.cad.hatch.none')}
              onChange={(background) => set({ background })}
            />
          )}
        </div>
        <div className="flex flex-col gap-0.5">
          <label className="flex items-center gap-1 text-xs">
            <span className="w-28">{t('design.cad.hatch.transparency')}</span>
            <input
              type="range"
              aria-label={t('design.cad.hatch.transparency')}
              min={0}
              max={MAX_HATCH_TRANSPARENCY}
              value={h.transparency}
              onChange={(event) => set({ transparency: Number(event.target.value) })}
              className="w-20"
            />
            <span dir="ltr" className="w-8 text-end">
              {h.transparency}
            </span>
          </label>
          <NumberInput
            label={t('design.cad.hatch.angle')}
            value={h.angle}
            min={-360}
            max={360}
            step={15}
            onChange={(angle) => set({ angle })}
          />
          {user ? (
            <>
              <NumberInput
                label={t('design.cad.hatch.spacing')}
                value={h.spacing}
                min={0.001}
                step={0.5}
                onChange={(spacing) => set({ spacing })}
              />
              <label className="flex items-center gap-1 text-xs">
                <input
                  type="checkbox"
                  checked={h.double}
                  onChange={(event) => set({ double: event.target.checked })}
                />
                {t('design.cad.hatch.double')}
              </label>
            </>
          ) : gradient ? null : (
            <NumberInput
              label={t('design.cad.hatch.scale')}
              value={h.scale}
              min={0.001}
              max={1000}
              step={0.25}
              onChange={(scale) => set({ scale })}
            />
          )}
        </div>
      </TabPanel>
      <TabPanel title={t('design.cad.hatch.origin')}>
        <Big
          label={t('design.cad.hatch.setOrigin')}
          pressed={edit.prompt.key === 'hatchOrigin'}
          onClick={() => edit.chooseOption('O')}
        >
          <path d="M4 20V6M4 20h14" />
          <circle cx="4" cy="20" r="2" />
        </Big>
        <button
          type="button"
          aria-pressed={h.origin === null}
          onClick={() => set({ origin: null })}
          className={`min-h-7 rounded px-1.5 text-xs ${h.origin === null ? ON : TILE}`}
        >
          {t('design.cad.hatch.defaultOrigin')}
        </button>
      </TabPanel>
      <TabPanel title={t('design.cad.hatch.options')}>
        <div className="flex flex-col gap-0.5">
          {(['associative', 'annotative', 'matchProperties'] as const).map((key) => (
            <button
              key={key}
              type="button"
              disabled
              title={t(
                key === 'associative'
                  ? 'design.cad.hatch.associativeReason'
                  : key === 'annotative'
                    ? 'design.cad.hatch.annotativeReason'
                    : 'design.cad.hatch.matchReason',
              )}
              className={`min-h-7 rounded px-1.5 text-start text-xs opacity-40 ${TILE}`}
            >
              {t(`design.cad.hatch.${key}`)}
            </button>
          ))}
        </div>
        <div className="relative">
          <button
            type="button"
            aria-expanded={more}
            aria-label={`${t('design.cad.hatch.options')} ▾`}
            onClick={() => setMore(!more)}
            className={`min-h-7 rounded px-1.5 text-xs ${more ? ON : TILE}`}
          >
            ▾
          </button>
          {more ? (
            <div className="absolute end-0 top-full z-40 mt-0.5 flex w-72 flex-col gap-1 rounded border border-[#454b55] bg-[#2b2f36] p-2 shadow-lg">
              <NumberInput
                label={t('design.cad.hatch.gap')}
                value={h.gap}
                min={0}
                step={0.1}
                onChange={(gap) => set({ gap })}
              />
              <label className="flex items-center gap-1 text-xs">
                <input
                  type="checkbox"
                  checked={h.separate}
                  onChange={(event) => set({ separate: event.target.checked })}
                />
                {t('design.cad.hatch.separate')}
              </label>
              <label className="flex items-center gap-1 text-xs">
                <span className="w-28">{t('design.cad.hatch.island')}</span>
                <select
                  aria-label={t('design.cad.hatch.island')}
                  className={`${FIELD} w-40`}
                  value={h.island}
                  onChange={(event) =>
                    set({ island: event.target.value as HatchSettings['island'] })
                  }
                >
                  {HATCH_ISLAND_STYLES.map((style) => (
                    <option key={style} value={style}>
                      {t(
                        style === 'normal'
                          ? 'design.cad.hatch.islandNormal'
                          : style === 'outer'
                            ? 'design.cad.hatch.islandOuter'
                            : 'design.cad.hatch.islandIgnore',
                      )}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-1 text-xs">
                <span className="w-28">{t('design.cad.hatch.drawOrder')}</span>
                <select
                  aria-label={t('design.cad.hatch.drawOrder')}
                  className={`${FIELD} w-40`}
                  value={h.drawOrder}
                  onChange={(event) =>
                    set({ drawOrder: event.target.value as HatchSettings['drawOrder'] })
                  }
                >
                  {HATCH_DRAW_ORDERS.map((order) => (
                    <option key={order} value={order}>
                      {t(`design.cad.hatch.order.${order}`)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          ) : null}
        </div>
      </TabPanel>
      <TabPanel title={t('design.cad.hatch.close')}>
        <Big label={t('design.cad.hatch.close')} onClick={hatch.close}>
          <path d="M5 5l14 14M19 5 5 19" />
        </Big>
      </TabPanel>
    </div>
  );
}
