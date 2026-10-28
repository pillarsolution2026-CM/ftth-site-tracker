import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { QC_ACCESS, renderScreen } from '@/test-utils/render';
import { detection, mappingView } from '../model/mapping-fixtures';
import { MappingEditor, type MappingEditorProps } from './mapping-editor';

function props(overrides: Partial<MappingEditorProps> = {}): MappingEditorProps {
  return {
    view: mappingView(),
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
  it('has no preselected drawing unit and keeps Save disabled until one is chosen', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(1);
    renderScreen(<MappingEditor {...props({ onSave })} />);

    const unit = screen.getByLabelText('Drawing unit');
    expect(unit).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Save mapping' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Build revision' })).toBeDisabled();

    await user.selectOptions(unit, 'm');
    expect(screen.getByRole('button', { name: 'Save mapping' })).toBeEnabled();
  });

  it('shows the units-conflict warning with text and an icon before any unit is chosen', () => {
    renderScreen(<MappingEditor {...props()} />);
    const warning = screen.getByText(/The file declares/);
    expect(warning.textContent).toContain('in');
    expect(warning.textContent).toContain('m');
    expect(screen.getByText('Check the drawing unit')).toBeInTheDocument();
    expect(screen.getAllByText('▲').length).toBeGreaterThan(0);
  });

  it('warns when the chosen unit differs from the declared and implied units', async () => {
    const user = userEvent.setup();
    const quiet = detection({
      unitsConflict: false,
      declaredUnit: 'm',
      impliedUnit: 'm',
      insUnits: 6,
    });
    renderScreen(<MappingEditor {...props({ view: mappingView({ crsDetection: quiet }) })} />);
    expect(screen.queryByText('Check the drawing unit')).not.toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Drawing unit'), 'ft');
    expect(screen.getByText(/differs from the unit declared by the file/)).toBeInTheDocument();
    expect(screen.getByText(/differs from the unit implied by the extents/)).toBeInTheDocument();
  });

  it('keeps Save disabled for an unsupported EPSG and says why', async () => {
    const user = userEvent.setup();
    renderScreen(<MappingEditor {...props()} />);
    await user.selectOptions(screen.getByLabelText('Drawing unit'), 'm');
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
    expect(within(route).getByRole('combobox')).toHaveValue('route');
    expect(within(route).getByText('Suggested')).toBeInTheDocument();
    expect(within(route).getByText('ACI 1')).toBeInTheDocument();
  });

  it('saves every layer rule plus block and text rules with the chosen unit and EPSG', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(1);
    renderScreen(<MappingEditor {...props({ onSave })} />);

    await user.selectOptions(screen.getByLabelText('Drawing unit'), 'm');
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
    });
    expect(await screen.findByText('Mapping saved (version 1)')).toBeInTheDocument();
  });

  it('builds a revision with the saved version, only when nothing is unsaved', async () => {
    const user = userEvent.setup();
    const onBuild = vi.fn();
    renderScreen(<MappingEditor {...props({ onBuild })} />);
    await user.selectOptions(screen.getByLabelText('Drawing unit'), 'm');
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
    expect(screen.getByLabelText('Drawing unit')).toBeDisabled();
    expect(screen.getByText(/view this mapping but not change it/)).toBeInTheDocument();
  });

  it('says the file must be processed first and disables editing', () => {
    renderScreen(
      <MappingEditor {...props({ view: mappingView({ fileStatus: 'processing', layers: [] }) })} />,
    );
    expect(screen.getByText(/must be processed/)).toBeInTheDocument();
    expect(screen.getByLabelText('Drawing unit')).toBeDisabled();
  });
});
