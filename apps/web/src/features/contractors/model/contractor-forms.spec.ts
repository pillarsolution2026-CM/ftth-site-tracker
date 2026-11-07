import { describe, expect, it } from 'vitest';
import { ApiClientError } from '@/shared/api/bff-client';
import { availabilityLine, contractorLine, ITEM_1 } from '@/test-utils/contractors';
import { contractorErrorMsg, registrationTotal } from './contractor-errors';
import {
  EMPTY_CONTRACTOR_FORM,
  checkPrice,
  checkQuantity,
  lineBlockReason,
  validateContractorForm,
  validatePriceForm,
  validateRegistration,
} from './contractor-forms';

describe('validateContractorForm', () => {
  it('needs name, contact person and phone; the rest is optional', () => {
    const result = validateContractorForm(EMPTY_CONTRACTOR_FORM);
    expect(result).toMatchObject({
      ok: false,
      errors: {
        name: 'validation.required',
        contactName: 'validation.required',
        contactPhone: 'validation.required',
      },
    });
    expect(
      validateContractorForm({
        ...EMPTY_CONTRACTOR_FORM,
        name: 'A',
        contactName: 'B',
        contactPhone: '+20 (100) 123-4567',
      }),
    ).toEqual({
      ok: true,
      payload: {
        name: 'A',
        contactName: 'B',
        contactPhone: '+20 (100) 123-4567',
        commercialRegister: null,
        taxCard: null,
      },
    });
  });

  it('rejects a phone with letters', () => {
    expect(
      validateContractorForm({
        ...EMPTY_CONTRACTOR_FORM,
        name: 'A',
        contactName: 'B',
        contactPhone: 'call me',
      }),
    ).toMatchObject({ ok: false, errors: { contactPhone: 'contractors.validation.phone' } });
  });
});

describe('quantity and price checks', () => {
  it('accepts Arabic digits and compares exactly', () => {
    expect(checkQuantity('٤٠٫٥', '40.5')).toEqual({ value: '40.5' });
    expect(checkQuantity('40.00001', '40.5')).toMatchObject({
      error: { key: 'contractors.validation.quantity' },
    });
    expect(checkQuantity('0', null)).toHaveProperty('error');
    expect(checkQuantity('0.30000001', null)).toHaveProperty('error');
    expect(checkQuantity('40.6', '40.5')).toMatchObject({
      error: { key: 'contractors.validation.quantityMax', params: { available: '40.5' } },
    });
    expect(checkPrice('100', '100')).toEqual({ value: '100' });
    expect(checkPrice('100.000001', '100')).toMatchObject({
      error: { key: 'contractors.validation.priceMax' },
    });
    expect(checkPrice('1.1234567', '100')).toMatchObject({
      error: { key: 'contractors.validation.price' },
    });
  });
});

describe('lineBlockReason', () => {
  it('blocks legacy lines and lines with nothing left', () => {
    expect(lineBlockReason(availabilityLine())).toBeNull();
    expect(lineBlockReason(availabilityLine({ assignable: false }))).toBe(
      'contractors.register.notAssignable',
    );
    expect(lineBlockReason(availabilityLine({ availableQuantity: '0' }))).toBe(
      'contractors.register.nothingLeft',
    );
  });
});

describe('validateRegistration', () => {
  const availability = [availabilityLine()];
  it('needs a contractor, a date and at least one line', () => {
    const result = validateRegistration(
      { contractorId: '', registeredOn: '', lines: {} },
      availability,
    );
    expect(result).toMatchObject({
      ok: false,
      errors: {
        contractorId: { key: 'contractors.validation.contractor' },
        registeredOn: { key: 'contractors.validation.date' },
        lines: { key: 'contractors.validation.noLines' },
      },
    });
  });

  it('builds the request from the chosen, valid lines only', () => {
    const result = validateRegistration(
      {
        contractorId: '3c1c9f2e-6b3d-4e8a-9c7f-2d4b6a8c0e1f',
        registeredOn: '2026-11-07',
        lines: { [ITEM_1]: { selected: true, quantity: '5', unitPrice: '99.5' } },
      },
      availability,
    );
    expect(result).toMatchObject({
      ok: true,
      payload: { lines: [{ workOrderItemId: ITEM_1, quantity: '5', unitPrice: '99.5' }] },
    });
  });
});

describe('validatePriceForm', () => {
  const line = contractorLine(); // latest price from 2026-11-05
  it('needs a date after the latest one', () => {
    expect(validatePriceForm({ effectiveFrom: '2026-11-05', unitPrice: '90' }, line)).toMatchObject(
      {
        ok: false,
        errors: { effectiveFrom: { params: { latest: '2026-11-05' } } },
      },
    );
    expect(validatePriceForm({ effectiveFrom: '2026-11-06', unitPrice: '90' }, line)).toEqual({
      ok: true,
      payload: { effectiveFrom: '2026-11-06', unitPrice: '90' },
    });
  });
});

const price = (unitPrice: string) => ({
  id: '7a000000-0000-4000-8000-000000000009',
  effectiveFrom: '2026-11-01',
  unitPrice,
  createdById: null,
  createdAt: '2026-11-07T08:00:00.000Z',
});

describe('registrationTotal', () => {
  it('is Σ quantity × latest price, exact to the last digit', () => {
    expect(registrationTotal([contractorLine()])).toBe('905');
    expect(
      registrationTotal([
        contractorLine({
          quantity: '0.1',
          prices: [price('0.2')],
        }),
        contractorLine({
          quantity: '1234567.8912',
          prices: [price('98.123456')],
        }),
      ]),
    ).toBe('121140068.1711759872');
    expect(registrationTotal([])).toBe('0');
  });
});

describe('contractorErrorMsg', () => {
  it('maps a contractor 409 reason and keeps its numbers', () => {
    expect(
      contractorErrorMsg(
        new ApiClientError('CONFLICT', 409, {
          reason: 'PRICE_DATE_NOT_AFTER_LATEST',
          latestEffectiveFrom: '2026-11-05',
        }),
      ),
    ).toEqual({
      key: 'contractors.reasons.PRICE_DATE_NOT_AFTER_LATEST',
      params: { latestEffectiveFrom: '2026-11-05' },
    });
  });

  it('falls back to the error code', () => {
    expect(contractorErrorMsg(new ApiClientError('CONFLICT', 409))).toEqual({
      key: 'errors.CONFLICT',
    });
    expect(contractorErrorMsg(new Error('x'))).toEqual({ key: 'errors.INTERNAL' });
  });
});
