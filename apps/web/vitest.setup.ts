import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
  // Autosave of unsaved drawing edits (phase 3E) must not carry from one test to the next.
  if (typeof window === 'undefined') return;
  for (const key of Object.keys(window.localStorage)) {
    if (key.startsWith('ftth.cad.unsaved.')) window.localStorage.removeItem(key);
  }
});
