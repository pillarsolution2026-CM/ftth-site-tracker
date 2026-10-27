'use client';

import { useCallback, useState, type ChangeEvent } from 'react';
import { validateHeader, type HeaderFormErrors, type HeaderFormValues } from '../model/header-form';

/** Field state and validation for the work-order header (create and edit share it). */
export function useHeaderForm(initial: HeaderFormValues) {
  const [values, setValues] = useState<HeaderFormValues>(initial);
  const [errors, setErrors] = useState<HeaderFormErrors>({});

  const onChange =
    (field: keyof HeaderFormValues) =>
    (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setValues((current) => ({ ...current, [field]: event.target.value }));
    };

  const validate = useCallback((): boolean => {
    const found = validateHeader(values);
    setErrors(found);
    return Object.keys(found).length === 0;
  }, [values]);

  const reset = useCallback((next: HeaderFormValues) => {
    setValues(next);
    setErrors({});
  }, []);

  return { values, errors, onChange, validate, reset, setErrors };
}
