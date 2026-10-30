import { requireHttpsOutsideDev } from './env';

describe('API_URL', () => {
  it('allows http only in development builds', () => {
    expect(requireHttpsOutsideDev('http://10.0.2.2:3001', true)).toBe('http://10.0.2.2:3001');
    expect(requireHttpsOutsideDev('https://api.example', false)).toBe('https://api.example');
    expect(() => requireHttpsOutsideDev('http://api.example', false)).toThrow(/https/);
  });
});
