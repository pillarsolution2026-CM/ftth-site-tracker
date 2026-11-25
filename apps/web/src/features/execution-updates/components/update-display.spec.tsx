import { render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import type { Locale } from '@ftth/i18n';
import { LocaleProvider } from '@/shared/i18n/locale-provider';
import { LineDimensionsText } from './line-dimensions';
import { UpdateElement } from './update-element';
import { dimensionsText, isPlanningUpdate } from '../model/update-display';

const FEATURE = '0f8fad5b-d9cb-469f-a165-70867728950e';
const wrap = (ui: ReactElement, locale: Locale = 'en') =>
  render(<LocaleProvider locale={locale}>{ui}</LocaleProvider>);

describe('UpdateElement', () => {
  it('shows the feature type of an element update', () => {
    wrap(<UpdateElement update={{ featureId: FEATURE, featureType: 'box' }} />);
    expect(screen.getByText('Box')).toBeInTheDocument();
  });

  it('shows the planning label for an update with no feature', () => {
    wrap(<UpdateElement update={{ featureId: null, featureType: null }} />, 'ar');
    expect(screen.getByText('التخطيط')).toBeInTheDocument();
    expect(isPlanningUpdate({ featureId: null })).toBe(true);
    expect(isPlanningUpdate({ featureId: FEATURE })).toBe(false);
  });
});

describe('LineDimensionsText', () => {
  const dims = { lengthM: '10', widthM: '0.35', depthM: '0.9' };

  it('shows L × W × D = quantity m3 with the numbers left-to-right', () => {
    wrap(<LineDimensionsText dimensions={dims} quantity="3.15" />, 'ar');
    const numbers = screen.getByText('10 × 0.35 × 0.9 = 3.15');
    expect(numbers.closest('bdi')).toHaveAttribute('dir', 'ltr');
    expect(screen.getByText(/م3/)).toBeInTheDocument();
    expect(dimensionsText(dims)).toBe('10 × 0.35 × 0.9');
  });

  it('shows nothing for a line without dimensions', () => {
    const { container } = wrap(<LineDimensionsText dimensions={null} quantity="3.15" />);
    expect(container).toBeEmptyDOMElement();
  });
});
