'use client';

import { useState } from 'react';

/** Open / closed state of a panel the user can show and hide. */
export function useDisclosure(initial = false) {
  const [open, setOpen] = useState(initial);
  return { open, toggle: () => setOpen((value) => !value) };
}
