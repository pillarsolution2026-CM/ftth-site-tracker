'use client';

import { useState } from 'react';

/** The text of the «add a group» field of one element card. */
export function useAddGroup(onAdd: (name: string) => void) {
  const [value, setValue] = useState('');
  return {
    value,
    setValue,
    submit: () => {
      if (value.trim() === '') return;
      onAdd(value);
      setValue('');
    },
  };
}
