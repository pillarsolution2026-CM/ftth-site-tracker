import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { translate } from '@ftth/i18n';
import {
  SECONDARY_PLACEMENT_REFUSALS,
  generalCabinetPointId,
  type SecondaryPlacementSuggestion,
} from '@ftth/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '@/shared/api/bff-client';
import { renderScreen } from '@/test-utils/render';
import { useGeneralCabinets } from '../hooks/use-general-cabinets';
import { CAD_FILE_ID, mappingView } from '../model/mapping-fixtures';
import { generalCabinetsErrorKey } from '../model/general-cabinets';
import { MappingEditor } from './mapping-editor';

vi.mock('./placement-map', () => ({ PlacementMap: () => null }));
const api = vi.hoisted(() => ({
  getGeneralCabinets: vi.fn(),
  getMapping: vi.fn(),
  getPlacementDrawing: vi.fn(),
  saveMapping: vi.fn(),
}));
vi.mock('../api/mapping-api', () => api);

const PROJECT = '0f8fad5b-d9cb-469f-a165-70867728950e';
const GENERAL_FILE = '66666666-6666-4666-8666-666666666666';
const REVISION = '77777777-7777-4777-8777-777777777777';

function suggestion(
  overrides: Partial<SecondaryPlacementSuggestion> = {},
): SecondaryPlacementSuggestion {
  return {
    cadFileId: CAD_FILE_ID,
    secondaryRevisionId: REVISION,
    general: { cadFileId: GENERAL_FILE, revisionId: REVISION, status: 'draft', revNo: null },
    points: [
      {
        id: generalCabinetPointId('1-2'),
        drawing: { x: 100.5, y: 200.25 },
        handle: 'C12',
        label: '1-2',
        lat: 30.984506,
        lon: 32.783249,
        source: 'general_cabinet',
        excluded: false,
      },
      {
        id: generalCabinetPointId('1-3'),
        drawing: { x: 300, y: 250 },
        handle: 'C13',
        label: '1-3',
        lat: 30.985,
        lon: 32.784,
        source: 'general_cabinet',
        excluded: false,
      },
    ],
    matchedCount: 2,
    truncated: false,
    unmatched: {
      onlyInSecondary: ['1-9'],
      onlyInGeneral: ['2-1', '2-2'],
      duplicateInSecondary: ['1-5'],
      duplicateInGeneral: [],
      unnamedSecondary: 1,
      unnamedGeneral: 0,
      withoutDrawingPosition: [],
    },
    ...overrides,
  };
}

function Screen({ auto = true, canWrite = true }: { auto?: boolean; canWrite?: boolean }) {
  const cabinets = useGeneralCabinets({
    projectId: PROJECT,
    cadFileId: CAD_FILE_ID,
    available: canWrite,
    auto,
  });
  return (
    <MappingEditor
      view={mappingView()}
      drawingKind="secondary"
      drawing={null}
      canWrite={canWrite}
      canBuild
      saving={false}
      building={false}
      errorKey={null}
      offerReload={false}
      onSave={vi.fn().mockResolvedValue(1)}
      onBuild={vi.fn()}
      onReload={vi.fn()}
      cabinets={cabinets.available ? cabinets : null}
    />
  );
}

beforeEach(() => {
  Object.values(api).forEach((fn) => fn.mockReset());
});

describe('«من كبائن الرئيسي» on a Secondary (ADR-042 part G)', () => {
  it('fetches by itself when the placement has no point and fills the panel, unsaved', async () => {
    api.getGeneralCabinets.mockResolvedValue(suggestion());
    renderScreen(<Screen />);
    const table = await screen.findByRole('table', { name: 'Control points' });
    expect(api.getGeneralCabinets).toHaveBeenCalledWith(PROJECT, CAD_FILE_ID);
    expect(within(table).getByText('gc-1-2')).toBeInTheDocument();
    expect(within(table).getByText('gc-1-3')).toBeInTheDocument();
    expect(within(table).getAllByText('Cabinet from the General')).toHaveLength(2);
    expect(
      await screen.findByText(/2.* points added from the General’s cabinets. Not saved yet/),
    ).toBeInTheDocument();
    // Nothing is saved by the fetch: the PM saves as usual.
    expect(api.saveMapping).not.toHaveBeenCalled();
    expect(screen.getByText(/General drawing: draft/)).toBeInTheDocument();
  });

  it('does not fetch again by itself, only on the button; a new suggestion replaces the old points', async () => {
    api.getGeneralCabinets.mockResolvedValueOnce(suggestion());
    renderScreen(<Screen />);
    await screen.findByRole('table', { name: 'Control points' });
    expect(api.getGeneralCabinets).toHaveBeenCalledTimes(1);

    api.getGeneralCabinets.mockResolvedValueOnce(
      suggestion({
        points: [suggestion().points[0] as never],
        matchedCount: 1,
        general: { cadFileId: GENERAL_FILE, revisionId: REVISION, status: 'published', revNo: 4 },
      }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'From the General’s cabinets' }));
    await waitFor(() => expect(api.getGeneralCabinets).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/General drawing: published/)).toBeInTheDocument();
    const rows = within(screen.getByRole('table', { name: 'Control points' })).getAllByRole('row');
    // Header + one point: the earlier gc-1-3 is gone, gc-1-2 not duplicated.
    expect(rows).toHaveLength(2);
  });

  it('lets the PM leave a point out or remove it, and says the others cannot be edited', async () => {
    api.getGeneralCabinets.mockResolvedValue(suggestion());
    renderScreen(<Screen />);
    const use = await screen.findByRole('checkbox', { name: 'Use point gc-1-2' });
    expect(use).toBeChecked();
    await userEvent.click(use);
    expect(use).not.toBeChecked();
    await userEvent.click(screen.getByRole('button', { name: 'Remove gc-1-3' }));
    expect(screen.queryByText('gc-1-3')).not.toBeInTheDocument();
    expect(screen.getByText(/can only be left out or removed/)).toBeInTheDocument();
  });

  it('lists every cabinet that gave no point', async () => {
    api.getGeneralCabinets.mockResolvedValue(
      suggestion({
        unmatched: {
          onlyInSecondary: ['1-9'],
          onlyInGeneral: ['2-1', '2-2'],
          duplicateInSecondary: ['1-5'],
          duplicateInGeneral: ['3-3'],
          unnamedSecondary: 1,
          unnamedGeneral: 2,
          withoutDrawingPosition: ['4-4'],
        },
      }),
    );
    renderScreen(<Screen />);
    await screen.findByText('Cabinets that did not match');
    expect(screen.getByText(/In the Secondary only:/)).toHaveTextContent('1-9');
    expect(screen.getByText(/In the General only:/)).toHaveTextContent('2-1');
    expect(screen.getByText(/In the General only:/)).toHaveTextContent('2-2');
    expect(screen.getByText(/Duplicated in the Secondary/)).toHaveTextContent('1-5');
    expect(screen.getByText(/Duplicated in the General/)).toHaveTextContent('3-3');
    expect(
      screen.getByText(/Cabinets with no name: Secondary .*1.* \/ General .*2/),
    ).toBeInTheDocument();
    expect(screen.getByText(/no drawing position \(rebuild the Secondary\)/)).toHaveTextContent(
      '4-4',
    );
  });

  it('says so when no cabinet is shared, and when the limit cut some', async () => {
    api.getGeneralCabinets.mockResolvedValue(suggestion({ points: [], matchedCount: 0 }));
    renderScreen(<Screen />);
    expect(await screen.findByText(/No cabinet is shared by name/)).toBeInTheDocument();
  });

  it('warns when the matched cabinets were more than the limit', async () => {
    api.getGeneralCabinets.mockResolvedValue(suggestion({ truncated: true, matchedCount: 250 }));
    renderScreen(<Screen />);
    expect(await screen.findByText(/only some were added/)).toBeInTheDocument();
  });

  it.each(SECONDARY_PLACEMENT_REFUSALS)('shows the clear refusal %s', async (reason) => {
    api.getGeneralCabinets.mockRejectedValue(
      new ApiClientError('CONFLICT', 409, { reason, revisionId: null }),
    );
    renderScreen(<Screen />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      translate('en', `mapping.placement.cabinets.refusal.${reason}`),
    );
    expect(screen.queryByRole('table', { name: 'Control points' })).not.toBeInTheDocument();
  });

  it('shows the generic failure for anything else', async () => {
    api.getGeneralCabinets.mockRejectedValue(new ApiClientError('INTERNAL', 500));
    renderScreen(<Screen />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /Could not fetch the General’s cabinets/,
    );
  });

  it('is not shown to someone who cannot write, and never fetches', () => {
    renderScreen(<Screen canWrite={false} />);
    expect(
      screen.queryByRole('button', { name: 'From the General’s cabinets' }),
    ).not.toBeInTheDocument();
    expect(api.getGeneralCabinets).not.toHaveBeenCalled();
  });

  it('waits for the button when auto is off', async () => {
    api.getGeneralCabinets.mockResolvedValue(suggestion());
    renderScreen(<Screen auto={false} />);
    const button = await screen.findByRole('button', { name: 'From the General’s cabinets' });
    expect(api.getGeneralCabinets).not.toHaveBeenCalled();
    await userEvent.click(button);
    expect(await screen.findByRole('table', { name: 'Control points' })).toBeInTheDocument();
  });
});

describe('generalCabinetsErrorKey', () => {
  it('has a message in every language for each refusal', () => {
    for (const reason of SECONDARY_PLACEMENT_REFUSALS) {
      const key = generalCabinetsErrorKey('CONFLICT', reason);
      expect(key).toBe(`mapping.placement.cabinets.refusal.${reason}`);
      for (const locale of ['ar', 'en', 'fr'] as const) {
        expect(translate(locale, key)).not.toBe(key);
      }
    }
  });

  it('does not treat other 409 reasons as refusals', () => {
    expect(generalCabinetsErrorKey('CONFLICT', 'VERSION_MISMATCH')).toBe(
      'mapping.placement.cabinets.failed',
    );
    expect(generalCabinetsErrorKey('FORBIDDEN', null)).toBe('errors.FORBIDDEN');
  });
});
