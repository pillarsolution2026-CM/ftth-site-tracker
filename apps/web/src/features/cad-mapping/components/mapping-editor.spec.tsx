import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import type { PlacementDrawing } from '@ftth/shared';
import { describe, expect, it, vi } from 'vitest';
import { QC_ACCESS, renderScreen } from '@/test-utils/render';
import { detection, mappingView } from '../model/mapping-fixtures';
import { MappingEditor, type MappingEditorProps } from './mapping-editor';

// MapLibre needs WebGL, which jsdom has not; the map's maths are tested in the model specs.
vi.mock('./placement-map', () => ({ PlacementMap: () => null }));

const DRAWING: PlacementDrawing = {
  revisionId: '55555555-5555-4555-8555-555555555555',
  items: [
    {
      handle: 'C1',
      featureType: 'cabinet',
      code: null,
      names: ['22U', '1-7'],
      layer: 'CAB',
      x: 7284.27,
      y: 4091.72,
    },
    { handle: 'H1', featureType: 'hhi', code: '04B', names: [], layer: 'HH', x: 7300, y: 4100 },
  ],
  lines: [],
  truncated: false,
};

const KML = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document>
  <Placemark><name>Cab 1-7</name><Point><coordinates>32.78324905782938,30.984506906326853,0</coordinates></Point></Placemark>
  <Placemark><name>Road</name><LineString><coordinates>32.7,30.9 32.8,30.9</coordinates></LineString></Placemark>
</Document></kml>`;

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

describe('MappingEditor', () => {
  it('has no unit picker: the drawing is in metres and Save is on (ADR-035)', () => {
    renderScreen(<MappingEditor {...props()} />);
    expect(screen.queryByRole('combobox', { name: 'Drawing unit' })).not.toBeInTheDocument();
    expect(screen.getByText(/Always metres/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save mapping' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Build revision' })).toBeDisabled();
  });

  it('adds a typed control point for a drawing item and saves it with the mapping', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(1);
    renderScreen(<MappingEditor {...props({ onSave, drawing: DRAWING })} />);
    expect(screen.getByText(/No control points yet/)).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Drawing item'), 'C1');
    await user.type(screen.getByLabelText('Latitude'), '30.984506906326853');
    await user.type(screen.getByLabelText('Longitude'), '32.78324905782938');
    await user.click(screen.getByRole('button', { name: 'Add point' }));

    const table = screen.getByRole('table', { name: 'Control points' });
    expect(within(table).getByText('#C1 (22U · 1-7)')).toBeInTheDocument();
    // One point: a pure shift, so the point lands on its Lat/Lon.
    expect(within(table).getByText('0.00')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Save mapping' }));
    expect(onSave.mock.calls[0]?.[0].placement).toEqual({
      sourceCrs: 'project',
      points: [
        {
          id: 'P1',
          drawing: { x: 7284.27, y: 4091.72 },
          handle: 'C1',
          label: '#C1 (22U · 1-7)',
          lat: 30.984506906326853,
          lon: 32.78324905782938,
          source: 'typed',
          excluded: false,
        },
      ],
      fitScaleWithTwoPoints: false,
      adjust: { dx: 0, dy: 0, rotationDeg: 0, scale: 1, pivot: null },
    });
  });

  it('refuses a point without a valid Lat/Lon and says why', async () => {
    const user = userEvent.setup();
    renderScreen(<MappingEditor {...props({ drawing: DRAWING })} />);
    await user.selectOptions(screen.getByLabelText('Drawing item'), 'H1');
    await user.type(screen.getByLabelText('Latitude'), '95');
    await user.type(screen.getByLabelText('Longitude'), '31');
    await user.click(screen.getByRole('button', { name: 'Add point' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/latitude between -90 and 90/);
    expect(screen.queryByRole('table', { name: 'Control points' })).not.toBeInTheDocument();
  });

  it('reads a KML, matches "Cab 1-7" to cabinet 1-7 by name and adds the matched point', async () => {
    const user = userEvent.setup();
    renderScreen(<MappingEditor {...props({ drawing: DRAWING })} />);
    const file = new File([KML], 'rabaa.kml', { type: 'application/vnd.google-earth.kml+xml' });
    await user.upload(screen.getByLabelText('KML or KMZ file'), file);

    expect(await screen.findByText(/placemarks read/)).toBeInTheDocument();
    expect(screen.getByLabelText('Drawing item for Cab 1-7')).toHaveValue('C1');
    expect(screen.getByText('Matched by name')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /matched points/ }));

    const table = screen.getByRole('table', { name: 'Control points' });
    expect(within(table).getByText('#C1 ↔ Cab 1-7')).toBeInTheDocument();
    expect(within(table).getByText('KML / KMZ')).toBeInTheDocument();
  });

  it('offers the drawing items once they arrive after the form (found in the browser)', async () => {
    const user = userEvent.setup();
    function Later() {
      const [drawing, setDrawing] = useState<PlacementDrawing | null>(null);
      return (
        <>
          <button type="button" onClick={() => setDrawing(DRAWING)}>
            load
          </button>
          <MappingEditor {...props({ drawing })} />
        </>
      );
    }
    renderScreen(<Later />);
    expect(screen.getByLabelText('Drawing X')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'load' }));
    expect(screen.getByLabelText('Drawing item')).toHaveValue('');
    expect(screen.queryByLabelText('Drawing X')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add point' })).toBeDisabled();
  });

  it('says without a built revision that the drawing X / Y is typed by hand', () => {
    renderScreen(<MappingEditor {...props()} />);
    expect(screen.getByText(/Build a revision once/)).toBeInTheDocument();
    expect(screen.getByLabelText('Drawing X')).toBeInTheDocument();
  });

  it('preselects Red Belt when the coordinates read as Red Belt', () => {
    const view = mappingView({ crsDetection: detection({ suggestedSourceCrs: 'egypt_red_belt' }) });
    renderScreen(<MappingEditor {...props({ view })} />);
    expect(screen.getByLabelText('Drawing coordinates')).toHaveValue('egypt_red_belt');
    expect(screen.getByText(/look like the Red Belt/)).toBeInTheDocument();
  });

  it('keeps Save disabled for an unsupported EPSG and says why', async () => {
    const user = userEvent.setup();
    renderScreen(<MappingEditor {...props()} />);
    const epsg = screen.getByLabelText('EPSG code');
    await user.clear(epsg);
    await user.type(epsg, '4326');
    expect(screen.getByText(/Only WGS 84 \/ UTM codes/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save mapping' })).toBeDisabled();
  });

  it('prefills the layer targets from the suggestion with a "Suggested" badge', () => {
    renderScreen(<MappingEditor {...props()} />);
    const layers = screen.getByRole('table', { name: 'Layers' });
    const route = within(layers).getByRole('row', { name: /N_DUC_CBL/ });
    expect(within(route).getByRole('combobox', { name: /^Becomes/ })).toHaveValue('route');
    expect(within(route).getByText('Suggested')).toBeInTheDocument();
    expect(within(route).getByText('ACI 1')).toBeInTheDocument();
  });

  it('saves every layer rule plus block and text rules with metres and the EPSG', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(1);
    renderScreen(<MappingEditor {...props({ onSave })} />);

    await user.selectOptions(screen.getByLabelText('Becomes: BUILDINGS'), 'ignore');
    await user.selectOptions(screen.getByLabelText('Becomes: TREE'), 'background');
    await user.selectOptions(screen.getByLabelText('Point type: NOTE'), 'mh');
    await user.click(screen.getByRole('button', { name: 'Save mapping' }));

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith({
      rules: [
        { source: 'layer', layer: 'N_DUC_CBL', target: 'route' },
        { source: 'layer', layer: 'BUILDINGS', target: 'ignore' },
        { source: 'block', block: 'HHI-BLOCK', target: 'hhi' },
        { source: 'block', block: 'TREE', target: 'background' },
        { source: 'text', layer: 'RRR', text: 'NEW-HHI', target: 'hhi' },
        { source: 'text', layer: 'RRR', text: 'NOTE', target: 'mh' },
      ],
      crsEpsg: 32636,
      drawingUnit: 'm',
      version: null,
      placement: null,
    });
    expect(await screen.findByText('Mapping saved (version 1)')).toBeInTheDocument();
  });

  it('builds a revision with the saved version, only when nothing is unsaved', async () => {
    const user = userEvent.setup();
    const onBuild = vi.fn();
    renderScreen(<MappingEditor {...props({ onBuild })} />);
    const build = screen.getByRole('button', { name: 'Build revision' });
    expect(build).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Save mapping' }));
    expect(build).toBeEnabled();
    await user.click(build);
    expect(onBuild).toHaveBeenCalledWith(1);

    await user.selectOptions(screen.getByLabelText('Becomes: BUILDINGS'), 'ignore');
    expect(build).toBeDisabled();
    expect(screen.getByText(/unsaved changes/)).toBeInTheDocument();
  });

  it('shows the version-conflict message and a reload button', async () => {
    const user = userEvent.setup();
    const onReload = vi.fn();
    renderScreen(
      <MappingEditor
        {...props({ errorKey: 'mapping.error.VERSION_MISMATCH', offerReload: true, onReload })}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('changed by someone else');
    await user.click(screen.getByRole('button', { name: 'Reload' }));
    expect(onReload).toHaveBeenCalled();
  });

  it('is read-only without write permissions (no Save, no Build, controls disabled)', () => {
    renderScreen(<MappingEditor {...props({ canWrite: false, canBuild: false })} />, {
      access: QC_ACCESS,
    });
    expect(screen.queryByRole('button', { name: 'Save mapping' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Build revision' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('EPSG code')).toBeDisabled();
    expect(screen.getByLabelText('Drawing coordinates')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Add point' })).not.toBeInTheDocument();
    expect(screen.getByText(/view this mapping but not change it/)).toBeInTheDocument();
  });

  it('says the file must be processed first and disables editing', () => {
    renderScreen(
      <MappingEditor {...props({ view: mappingView({ fileStatus: 'processing', layers: [] }) })} />,
    );
    expect(screen.getByText(/must be processed/)).toBeInTheDocument();
    expect(screen.getByLabelText('EPSG code')).toBeDisabled();
  });

  it('asks for main or sub when a layer becomes a cabinet, then saves the role', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(1);
    renderScreen(<MappingEditor {...props({ onSave })} />);
    await user.selectOptions(screen.getByLabelText('Becomes: BUILDINGS'), 'cabinet');
    expect(screen.getByText('Choose main or sub for: BUILDINGS')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save mapping' })).toBeDisabled();
    await user.selectOptions(screen.getByLabelText('Cabinet role: BUILDINGS'), 'sub');
    await user.click(screen.getByRole('button', { name: 'Save mapping' }));
    expect(onSave.mock.calls[0]?.[0].rules).toContainEqual({
      source: 'layer',
      layer: 'BUILDINGS',
      target: 'cabinet',
      role: 'sub',
    });
  });
});
