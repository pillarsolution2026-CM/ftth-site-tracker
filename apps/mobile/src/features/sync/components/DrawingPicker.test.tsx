import { fireEvent, render, screen } from '@testing-library/react-native';
import type { OfflineDrawing } from '@ftth/shared';
import { I18nProvider } from '../../../shared/i18n/I18nProvider';
import { InMemoryLocaleStorage } from '../../../shared/storage/locale-storage';
import { DrawingPicker } from './DrawingPicker';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const drawing = (n: number, siteId: string, siteName: string): OfflineDrawing => ({
  drawingId: id(100 + n),
  siteId,
  siteName,
  kind: 'general',
  ordinal: 1,
  revision: {
    id: id(200 + n),
    revNo: 1,
    publishedAt: '2026-10-29T08:00:00.000Z',
    tilesAvailable: true,
  },
});

describe('DrawingPicker with a supervisor bundle (ADR-054)', () => {
  it('offers only the sites the bundle lists', async () => {
    const own = [drawing(1, id(10), 'موقع أ'), drawing(2, id(12), 'موقع ج')];
    await render(
      <I18nProvider storage={new InMemoryLocaleStorage()}>
        <DrawingPicker
          drawings={own}
          downloaded={{}}
          currentDrawingId={own[0]?.drawingId ?? null}
          busy={false}
          onSelect={() => undefined}
        />
      </I18nProvider>,
    );
    expect(screen.getByTestId(`site-${id(10)}`)).toBeTruthy();
    expect(screen.getByTestId(`site-${id(12)}`)).toBeTruthy();
    expect(screen.queryByTestId(`site-${id(11)}`)).toBeNull();
    expect(screen.queryByTestId('site-none')).toBeNull();
    await fireEvent.press(screen.getByTestId(`site-${id(12)}`));
    expect(screen.getByTestId(`drawing-${id(102)}`)).toBeTruthy();
  });
});
