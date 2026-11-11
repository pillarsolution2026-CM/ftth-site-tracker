import { screen, waitFor } from '@testing-library/react';
import type { SecondaryPlacementSuggestion } from '@ftth/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '@/shared/api/bff-client';
import { renderScreen } from '@/test-utils/render';
import { CAD_FILE_ID, mappingView } from '../model/mapping-fixtures';
import { MappingScreen } from './mapping-screen';

vi.mock('./placement-map', () => ({ PlacementMap: () => null }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
const mappingApi = vi.hoisted(() => ({
  getMapping: vi.fn(),
  saveMapping: vi.fn(),
  getPlacementDrawing: vi.fn(),
  getGeneralCabinets: vi.fn(),
}));
vi.mock('../api/mapping-api', () => mappingApi);
const proposalsApi = vi.hoisted(() => ({
  listGpsProposals: vi.fn(),
  acceptGpsProposal: vi.fn(),
  rejectGpsProposal: vi.fn(),
  gpsProposalPhotoUrl: () => '',
}));
vi.mock('../api/proposals-api', () => proposalsApi);
const cadApi = vi.hoisted(() => ({ getCadFile: vi.fn() }));
vi.mock('@/features/cad-files/api/cad-api', () => ({
  ...cadApi,
  toQueryString: () => '',
}));
const installationApi = vi.hoisted(() => ({
  getInstallation: vi.fn(),
  setInstallationAnswer: vi.fn(),
  createTrenchMark: vi.fn(),
  withdrawTrenchMark: vi.fn(),
}));
vi.mock('@/features/installation/api/installation-api', () => installationApi);

const PROJECT = '0f8fad5b-d9cb-469f-a165-70867728950e';

const cadFile = (drawingKind: 'general' | 'secondary', supersededAt: string | null = null) => ({
  id: CAD_FILE_ID,
  drawingKind,
  supersededAt,
  status: 'processed',
});

const suggestion: SecondaryPlacementSuggestion = {
  cadFileId: CAD_FILE_ID,
  secondaryRevisionId: '77777777-7777-4777-8777-777777777777',
  general: {
    cadFileId: '66666666-6666-4666-8666-666666666666',
    revisionId: '77777777-7777-4777-8777-777777777777',
    status: 'published',
    revNo: 3,
  },
  points: [],
  matchedCount: 0,
  truncated: false,
  unmatched: {
    onlyInSecondary: [],
    onlyInGeneral: [],
    duplicateInSecondary: [],
    duplicateInGeneral: [],
    unnamedSecondary: 0,
    unnamedGeneral: 0,
    withoutDrawingPosition: [],
  },
};

function renderMapping() {
  renderScreen(
    <MappingScreen
      projectId={PROJECT}
      cadFileId={CAD_FILE_ID}
      filePath="/en/projects/p/cad-files/f"
    />,
  );
}

beforeEach(() => {
  [mappingApi, proposalsApi, cadApi, installationApi].forEach((api) =>
    Object.values(api).forEach(
      (fn) => typeof fn === 'function' && 'mockReset' in fn && fn.mockReset(),
    ),
  );
  mappingApi.getMapping.mockResolvedValue(mappingView());
  mappingApi.getPlacementDrawing.mockResolvedValue({
    mappingVersion: 1,
    items: [],
    lines: [],
    truncated: false,
  });
  proposalsApi.listGpsProposals.mockResolvedValue({ items: [], total: 0 });
  installationApi.getInstallation.mockResolvedValue({
    cadFileId: CAD_FILE_ID,
    drawingKind: 'general',
    asked: true,
    answer: null,
    answerHistory: [],
    marks: [],
    activeMarkCount: 0,
    activeTrenchM: '0.000',
  });
});

describe('MappingScreen (ADR-042)', () => {
  it('asks the installation question on a General and offers no General-cabinet points', async () => {
    cadApi.getCadFile.mockResolvedValue(cadFile('general'));
    renderMapping();
    expect(
      await screen.findByText(
        'Is the whole route pulled through old pipes, or does part of it need digging and new pipes?',
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'From the General’s cabinets' }),
    ).not.toBeInTheDocument();
    expect(mappingApi.getGeneralCabinets).not.toHaveBeenCalled();
  });

  it('does not ask a Secondary, and fetches the General’s cabinets by itself when it has no point', async () => {
    cadApi.getCadFile.mockResolvedValue(cadFile('secondary'));
    mappingApi.getGeneralCabinets.mockResolvedValue(suggestion);
    renderMapping();
    expect(
      await screen.findByRole('button', { name: 'From the General’s cabinets' }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(mappingApi.getGeneralCabinets).toHaveBeenCalledWith(PROJECT, CAD_FILE_ID),
    );
    expect(await screen.findByText(/General drawing: published.*#3/)).toBeInTheDocument();
    expect(installationApi.getInstallation).not.toHaveBeenCalled();
    expect(screen.queryByText(/pulled through old pipes/)).not.toBeInTheDocument();
  });

  it('shows a refusal reason on a Secondary whose General is not placed', async () => {
    cadApi.getCadFile.mockResolvedValue(cadFile('secondary'));
    mappingApi.getGeneralCabinets.mockRejectedValue(
      new ApiClientError('CONFLICT', 409, { reason: 'GENERAL_NOT_PLACED', revisionId: null }),
    );
    renderMapping();
    expect(
      await screen.findByText(/no control point in use. Place the General first/),
    ).toBeInTheDocument();
  });

  it('does not fetch for a superseded Secondary', async () => {
    cadApi.getCadFile.mockResolvedValue(cadFile('secondary', '2026-11-10T10:00:00.000Z'));
    renderMapping();
    await screen.findByText(/superseded|newer version/i);
    expect(mappingApi.getGeneralCabinets).not.toHaveBeenCalled();
  });
});
