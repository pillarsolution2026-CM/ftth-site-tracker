import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { UpdateListItem } from '@ftth/shared';
import { LocaleProvider } from '@/shared/i18n/locale-provider';
import { listQuery } from '../model/update-list-model';
import { UpdateListView } from './update-list';

const PROJECT = '0f8fad5b-d9cb-469f-a165-70867728950a';
const SITE = '0f8fad5b-d9cb-469f-a165-70867728950b';

const update: UpdateListItem = {
  id: '0f8fad5b-d9cb-469f-a165-70867728950c',
  status: 'pending',
  workType: 'civil',
  featureId: '0f8fad5b-d9cb-469f-a165-70867728950d',
  featureType: 'cabinet',
  featureCode: '1-7',
  siteId: SITE,
  siteName: 'Site one',
  drawingKind: 'secondary',
  drawingOrdinal: 2,
  revNo: 3,
  supervisorName: 'Supervisor one',
  workDate: '2026-11-25',
  capturedAt: '2026-11-25T08:00:00.000Z',
  receivedAt: '2026-11-25T08:05:00.000Z',
  gps: { lat: 30.123456, lon: 31.654321, accuracyM: 4 },
  gpsDistanceM: '12.5',
  flags: ['GPS_FAR'],
  label: null,
  note: 'note text',
  reviewReason: null,
  lines: [
    {
      role: 'work',
      workOrderNumber: 'WO-1',
      itemCode: 'C-10',
      itemDescription: 'Digging',
      unit: 'm3',
      quantity: '3.15',
      dimensions: { lengthM: '10', widthM: '0.35', depthM: '0.9' },
      performer: { kind: 'contractor', contractorName: 'Contractor one', scope: null },
    },
    {
      role: 'material',
      workOrderNumber: 'WO-1',
      itemCode: 'M-2',
      itemDescription: 'Pipe',
      unit: 'm',
      quantity: '10',
      dimensions: null,
      performer: null,
    },
  ],
  photos: [
    { photoId: '0f8fad5b-d9cb-469f-a165-70867728950e', requirementKey: 'general', stored: true },
    { photoId: '0f8fad5b-d9cb-469f-a165-70867728950f', requirementKey: 'general', stored: false },
  ],
};

function view(items: UpdateListItem[] | null) {
  return render(
    <LocaleProvider locale="en">
      <UpdateListView
        projectId={PROJECT}
        items={items}
        total={items?.length ?? 0}
        sites={[{ id: SITE, name: 'Site one' }]}
        page={1}
        pageSize={20}
        status="all"
        siteId=""
        errorCode={null}
        onStatusChange={vi.fn()}
        onSiteChange={vi.fn()}
        onPageChange={vi.fn()}
      />
    </LocaleProvider>,
  );
}

describe('UpdateListView (ADR-059)', () => {
  it('shows an update with its element, drawing, lines, GPS and photos', () => {
    view([update]);
    const card = screen.getByText('note text').closest('[data-update]') as HTMLElement;
    const inCard = within(card);
    expect(inCard.getByText('Cabinet')).toBeInTheDocument();
    expect(inCard.getByText('1-7')).toBeInTheDocument();
    expect(inCard.getByText('Secondary 2')).toBeInTheDocument();
    expect(inCard.getByText('Revision 3')).toBeInTheDocument();
    expect(inCard.getByText('Supervisor one')).toBeInTheDocument();
    expect(inCard.getByText('2026-11-25')).toBeInTheDocument();
    expect(inCard.getByText('10 × 0.35 × 0.9 = 3.15')).toBeInTheDocument();
    expect(inCard.getByText(/Contractor one/)).toBeInTheDocument();
    expect(inCard.getByText('30.123456, 31.654321')).toBeInTheDocument();
    expect(inCard.getByText('12.5 m from the element')).toBeInTheDocument();
    expect(inCard.getByText(/Far from the element/)).toBeInTheDocument();
    const photo = inCard.getByRole('img', { name: 'Open photo 1' });
    expect(photo).toHaveAttribute(
      'src',
      `/api/projects/${PROJECT}/execution-updates/photos/0f8fad5b-d9cb-469f-a165-70867728950e`,
    );
    expect(inCard.getByText('Photo 2 still uploading')).toBeInTheDocument();
    expect(card.querySelector('[data-status="pending"]')).toHaveTextContent('Awaiting review');
  });

  it('shows the empty state and the site filter', () => {
    view([]);
    expect(screen.getByText('No recorded work matches this filter')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Site one' })).toBeInTheDocument();
  });

  it('builds the list query from the filters', () => {
    expect(listQuery('all', '', 1)).toEqual({ limit: 20, offset: 0 });
    expect(listQuery('pending', SITE, 3)).toEqual({
      status: 'pending',
      siteId: SITE,
      limit: 20,
      offset: 40,
    });
  });
});
