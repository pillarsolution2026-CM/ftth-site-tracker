import { describe, expect, it } from 'vitest';
import { ApiClientError } from '@/shared/api/bff-client';
import {
  boxAvailability,
  boxLine,
  availabilityLine,
  contractorLine,
} from '@/test-utils/contractors';
import { contractorErrorMsg, registrationTotal } from './contractor-errors';
import {
  EMPTY_CONTRACTOR_FORM,
  checkPrice,
  checkQuantity,
  maxAllowedPriceOf,
  validateContractorForm,
  validateLineQuantity,
  validateNewTarget,
  validatePriceForm,
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

describe('validateNewTarget', () => {
  it('needs the contractor and the registration date', () => {
    expect(validateNewTarget({ contractorId: '', registeredOn: '' })).toMatchObject({
      ok: false,
      errors: {
        contractorId: { key: 'contractors.validation.contractor' },
        registeredOn: { key: 'contractors.validation.date' },
      },
    });
    expect(validateNewTarget({ contractorId: 'c1', registeredOn: '2026-11-07' })).toEqual({
      ok: true,
      target: { kind: 'new', contractorId: 'c1', registeredOn: '2026-11-07' },
    });
  });
});

describe('quantity and price checks', () => {
  it('accepts Arabic digits and compares exactly', () => {
    expect(checkQuantity('٤٠٫٥', '40.5')).toEqual({ value: '40.5' });
    expect(checkQuantity('40.00001', '40.5')).toMatchObject({
      error: { key: 'contractors.validation.quantity' },
    });
    expect(checkQuantity('0', null)).toHaveProperty('error');
    expect(checkQuantity('40.6', '40.5')).toMatchObject({
      error: { key: 'contractors.validation.quantityMax', params: { available: '40.5' } },
    });
    expect(checkPrice('100', '100')).toEqual({ value: '100' });
    expect(checkPrice('100.000001', '100')).toMatchObject({
      error: { key: 'contractors.validation.priceMaxAllowed', params: { maxAllowed: '100' } },
    });
    expect(checkPrice('1.1234567', '100')).toMatchObject({
      error: { key: 'contractors.validation.price' },
    });
  });
});

describe('scope-aware limits', () => {
  it('caps a quantity by the scope availability plus the line own quantity', () => {
    // box scope: available 80 + own 20
    expect(validateLineQuantity('100', boxLine(), boxAvailability())).toEqual({
      ok: true,
      quantity: '100',
    });
    expect(validateLineQuantity('100.0001', boxLine(), boxAvailability())).toMatchObject({
      ok: false,
      error: { params: { available: '100' } },
    });
    // a whole line is the scope with no name
    expect(validateLineQuantity('50', contractorLine(), availabilityLine())).toEqual({
      ok: true,
      quantity: '50',
    });
  });

  it('allows a price up to the price room plus this scope highest price', () => {
    expect(maxAllowedPriceOf(boxLine(), boxAvailability())).toBe('12');
    expect(maxAllowedPriceOf(contractorLine(), availabilityLine())).toBe('100');
    expect(maxAllowedPriceOf(contractorLine(), undefined)).toBe('100');
  });

  it('needs a date after the latest one and a price within the maximum', () => {
    const line = contractorLine(); // latest price from 2026-11-05
    expect(
      validatePriceForm({ effectiveFrom: '2026-11-05', unitPrice: '90' }, line, availabilityLine()),
    ).toMatchObject({
      ok: false,
      errors: { effectiveFrom: { params: { latest: '2026-11-05' } } },
    });
    expect(
      validatePriceForm(
        { effectiveFrom: '2026-11-06', unitPrice: '100' },
        line,
        availabilityLine(),
      ),
    ).toEqual({ ok: true, payload: { effectiveFrom: '2026-11-06', unitPrice: '100' } });
    expect(
      validatePriceForm(
        { effectiveFrom: '2026-11-06', unitPrice: '13' },
        boxLine(),
        boxAvailability(),
      ),
    ).toMatchObject({ ok: false, errors: { unitPrice: { params: { maxAllowed: '12' } } } });
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
        contractorLine({ quantity: '0.1', prices: [price('0.2')] }),
        contractorLine({ quantity: '1234567.8912', prices: [price('98.123456')] }),
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
          reason: 'PRICE_EXCEEDS_CONTRACT',
          maxAllowedPrice: '70',
          otherScopesPrice: '30',
        }),
      ),
    ).toEqual({
      key: 'contractors.reasons.PRICE_EXCEEDS_CONTRACT',
      params: { otherScopesPrice: '30', maxAllowedPrice: '70' },
    });
  });

  it('a quantity overrun on a whole line carries an empty scope', () => {
    expect(
      contractorErrorMsg(
        new ApiClientError('CONFLICT', 409, {
          reason: 'QUANTITY_EXCEEDS_WORK_ORDER',
          scope: null,
          availableQuantity: '5',
        }),
      ),
    ).toEqual({
      key: 'contractors.reasons.QUANTITY_EXCEEDS_WORK_ORDER',
      params: { availableQuantity: '5', scope: '' },
    });
  });

  it('knows STALE_VERSION, WHOLE_AND_SCOPES_MIXED and the fallbacks', () => {
    expect(
      contractorErrorMsg(new ApiClientError('CONFLICT', 409, { reason: 'STALE_VERSION' })),
    ).toEqual({ key: 'contractors.reasons.STALE_VERSION' });
    expect(
      contractorErrorMsg(new ApiClientError('CONFLICT', 409, { reason: 'WHOLE_AND_SCOPES_MIXED' })),
    ).toMatchObject({ key: 'contractors.reasons.WHOLE_AND_SCOPES_MIXED' });
    expect(contractorErrorMsg(new ApiClientError('CONFLICT', 409))).toEqual({
      key: 'errors.CONFLICT',
    });
    expect(contractorErrorMsg(new Error('x'))).toEqual({ key: 'errors.INTERNAL' });
  });
});
