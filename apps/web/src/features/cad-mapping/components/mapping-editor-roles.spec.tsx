import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CadMappingView } from '@ftth/shared';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/test-utils/render';
import { CAD_FILE_ID, mappingView } from '../model/mapping-fixtures';
import { MappingEditor, type MappingEditorProps } from './mapping-editor';

// MapLibre needs WebGL, which jsdom has not.
vi.mock('./placement-map', () => ({ PlacementMap: () => null }));

function props(overrides: Partial<MappingEditorProps> = {}): MappingEditorProps {
  return {
    view: mappingView(),
    drawing: null,
    canWrite: true,
    canBuild: true,
    saving: false,
    building: false,
    errorKey: null,
    offerReload: false,
    onSave: vi.fn().mockResolvedValue(1),
    onBuild: vi.fn(),
    onReload: vi.fn(),
    ...overrides,
  };
}

const layer = (name: string, suggestedTarget: 'label' | 'route' | 'cabinet') => ({
  name,
  aciColor: 7,
  trueColor: null,
  isOn: true,
  entityCounts: { TEXT: 10 },
  entityTotal: 10,
  suggestedTarget,
  suggestionSource: 'name_pattern' as const,
});

const view = () =>
  mappingView({
    layers: [layer('TXTNMPER', 'label'), layer('1X12w Line', 'route')],
    blocks: [],
    texts: [
      { layer: 'TXTNMPER', text: '9', count: 40, suggestedTarget: null },
      { layer: 'TXTNMPER', text: '12', count: 30, suggestedTarget: null },
    ],
  });

const savedMapping = (rules: NonNullable<CadMappingView['mapping']>['rules'], version = 4) => ({
  cadFileId: CAD_FILE_ID,
  rules,
  crsEpsg: 32636,
  drawingUnit: 'm' as const,
  metresPerUnit: '1',
  placement: null,
  version,
  updatedById: null,
  updatedAt: '2026-11-11T10:00:00.000Z',
});

const rowOf = (name: string) =>
  within(screen.getByRole('table', { name: 'Layers' })).getByRole('row', {
    name: new RegExp(name),
  });

describe('MappingEditor text roles and ways (ADR-041)', () => {
  it('offers a Secondary file the Secondary roles only, with box_number pre-ticked', () => {
    renderScreen(<MappingEditor {...props({ view: view(), drawingKind: 'secondary' })} />);
    const row = rowOf('TXTNMPER');
    expect(within(row).getByRole('checkbox', { name: 'Box number' })).toBeChecked();
    expect(within(row).getByRole('checkbox', { name: 'Box cabinet' })).not.toBeChecked();
    expect(within(row).getByRole('checkbox', { name: 'Bundle spare SPn' })).toBeInTheDocument();
    expect(within(row).queryByRole('checkbox', { name: 'Handhole type' })).not.toBeInTheDocument();
    expect(within(row).queryByRole('checkbox', { name: 'Cable spare SP' })).not.toBeInTheDocument();
  });

  it('offers a General file the General roles only', () => {
    renderScreen(<MappingEditor {...props({ view: view(), drawingKind: 'general' })} />);
    const row = rowOf('TXTNMPER');
    expect(within(row).getByRole('checkbox', { name: 'Handhole type' })).toBeInTheDocument();
    expect(
      within(row).getByRole('checkbox', { name: 'Cable text (length / cores)' }),
    ).toBeInTheDocument();
    expect(within(row).queryByRole('checkbox', { name: 'Box number' })).not.toBeInTheDocument();
  });

  it('shows no roles while the drawing kind is unknown', () => {
    renderScreen(<MappingEditor {...props({ view: view() })} />);
    expect(screen.queryByRole('checkbox', { name: 'Box number' })).not.toBeInTheDocument();
  });

  it('pre-fills the ways of a route layer from its name; the zone target is Secondary only', () => {
    const { unmount } = renderScreen(
      <MappingEditor {...props({ view: view(), drawingKind: 'secondary' })} />,
    );
    expect(within(rowOf('1X12w')).getByLabelText(/Number of ways/)).toHaveValue('12');
    expect(
      within(screen.getByLabelText('Becomes: TXTNMPER')).getByRole('option', {
        name: 'Cabinet zone',
      }),
    ).toBeInTheDocument();
    unmount();
    renderScreen(<MappingEditor {...props({ view: view(), drawingKind: 'general' })} />);
    expect(
      within(screen.getByLabelText('Becomes: TXTNMPER')).queryByRole('option', {
        name: 'Cabinet zone',
      }),
    ).not.toBeInTheDocument();
  });

  it('saves the ticked roles and the ways with the layer rules', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(1);
    renderScreen(<MappingEditor {...props({ view: view(), drawingKind: 'secondary', onSave })} />);
    await user.click(within(rowOf('TXTNMPER')).getByRole('checkbox', { name: 'Box cabinet' }));
    await user.click(screen.getByRole('button', { name: 'Save mapping' }));
    expect(onSave.mock.calls[0]?.[0].rules).toEqual([
      {
        source: 'layer',
        layer: 'TXTNMPER',
        target: 'label',
        textRoles: ['box_cabinet', 'box_number'],
      },
      { source: 'layer', layer: '1X12w Line', target: 'route', ways: 12 },
    ]);
  });

  it('keeps the saved roles and ways when another field is edited and saved', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(5);
    const rules: NonNullable<CadMappingView['mapping']>['rules'] = [
      { source: 'layer', layer: 'TXTNMPER', target: 'label', textRoles: ['box_number'] },
      { source: 'layer', layer: '1X12w Line', target: 'route', ways: 12 },
    ];
    const saved = mappingView({ ...view(), mapping: savedMapping(rules) });
    renderScreen(<MappingEditor {...props({ view: saved, drawingKind: 'secondary', onSave })} />);
    await user.clear(screen.getByLabelText('EPSG code'));
    await user.type(screen.getByLabelText('EPSG code'), '32635');
    await user.click(screen.getByRole('button', { name: 'Save mapping' }));
    expect(onSave.mock.calls[0]?.[0].rules).toEqual(rules);
  });

  it('fills the meanings of a saved legacy mapping only when asked', async () => {
    const user = userEvent.setup();
    const legacy = mappingView({
      ...view(),
      mapping: savedMapping(
        [
          { source: 'layer', layer: 'TXTNMPER', target: 'label' },
          { source: 'layer', layer: '1X12w Line', target: 'route' },
        ],
        2,
      ),
    });
    renderScreen(<MappingEditor {...props({ view: legacy, drawingKind: 'secondary' })} />);
    expect(
      within(rowOf('TXTNMPER')).getByRole('checkbox', { name: 'Box number' }),
    ).not.toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Suggest meanings' }));
    expect(within(rowOf('TXTNMPER')).getByRole('checkbox', { name: 'Box number' })).toBeChecked();
    expect(within(rowOf('1X12w')).getByLabelText(/Number of ways/)).toHaveValue('12');
  });

  it('marks a role the kind does not read, and keeps Save off for ways outside 1-288', async () => {
    const user = userEvent.setup();
    const saved = mappingView({
      ...view(),
      mapping: savedMapping(
        [
          { source: 'layer', layer: 'TXTNMPER', target: 'label', textRoles: ['handhole_type'] },
          { source: 'layer', layer: '1X12w Line', target: 'route' },
        ],
        2,
      ),
    });
    renderScreen(<MappingEditor {...props({ view: saved, drawingKind: 'secondary' })} />);
    const row = rowOf('TXTNMPER');
    expect(within(row).getByRole('checkbox', { name: 'Handhole type' })).toBeChecked();
    expect(within(row).getByText(/not read in this drawing/)).toBeInTheDocument();

    await user.type(within(rowOf('1X12w')).getByLabelText(/Number of ways/), '300');
    expect(screen.getAllByText(/whole number from 1 to 288/).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Save mapping' })).toBeDisabled();
  });

  it.each([
    ['ROLE_NOT_FOR_KIND', /does not read/],
    ['ZONE_NOT_FOR_KIND', /Secondary drawing only/],
  ] as const)('shows the %s refusal clearly', (reason, expected) => {
    renderScreen(<MappingEditor {...props({ errorKey: `mapping.error.${reason}` })} />);
    expect(screen.getByRole('alert')).toHaveTextContent(expected);
  });
});
