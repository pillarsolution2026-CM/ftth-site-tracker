import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { translate } from '@ftth/i18n';
import { InMemoryLocaleStorage } from '../../../shared/storage/locale-storage';
import { InMemoryTokenStorage } from '../../../shared/storage/token-storage';
import { I18nProvider } from '../../../shared/i18n/I18nProvider';
import { createAuthApi } from '../api/api-client';
import { AuthProvider } from '../hooks/AuthProvider';
import { LoginScreen } from './LoginScreen';

const mockReplace = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ replace: mockReplace }) }));

const TOKENS = { accessToken: 'access', refreshToken: 'r'.repeat(40), expiresIn: 900 };
const ME = {
  id: '3f0c1c1e-6d1f-4a39-8a3e-7a0c2f1b9d11',
  email: 'sup@example.com',
  displayName: 'Mona',
  locale: 'ar',
  isAdmin: false,
  memberships: [],
};

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function renderLogin(fetchFn: jest.Mock) {
  const api = createAuthApi({
    baseUrl: 'http://api.test',
    storage: new InMemoryTokenStorage(),
    fetchFn: fetchFn as unknown as typeof fetch,
  });
  return await render(
    <I18nProvider storage={new InMemoryLocaleStorage()}>
      <AuthProvider api={api}>
        <LoginScreen />
      </AuthProvider>
    </I18nProvider>,
  );
}

async function fill(email: string, password: string) {
  await fireEvent.changeText(await screen.findByTestId('login-email'), email);
  await fireEvent.changeText(screen.getByTestId('login-password'), password);
  await fireEvent.press(screen.getByTestId('login-submit'));
}

describe('LoginScreen', () => {
  beforeEach(() => {
    mockReplace.mockClear();
  });

  it('shows validation errors in Arabic and does not call the API', async () => {
    const fetchFn = jest.fn();
    await renderLogin(fetchFn);

    await fill('not-an-email', 'short');

    expect(await screen.findByText(translate('ar', 'auth.emailInvalid'))).toBeTruthy();
    expect(screen.getByText(translate('ar', 'auth.passwordTooShort'))).toBeTruthy();
    expect(fetchFn).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('logs in and navigates home on success', async () => {
    const fetchFn = jest.fn((url: string) =>
      Promise.resolve(url.endsWith('/auth/login') ? reply(200, TOKENS) : reply(200, ME)),
    );
    await renderLogin(fetchFn);

    await fill('sup@example.com', 'password123');

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/'));
    const [loginUrl, loginInit] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(loginUrl).toBe('http://api.test/auth/login');
    expect(JSON.parse(String(loginInit.body))).toEqual({
      email: 'sup@example.com',
      password: 'password123',
    });
  });

  it('shows the Arabic INVALID_CREDENTIALS message on 401', async () => {
    const fetchFn = jest.fn(() =>
      Promise.resolve(reply(401, { code: 'INVALID_CREDENTIALS', message: 'nope' })),
    );
    await renderLogin(fetchFn);

    await fill('sup@example.com', 'wrong-password');

    expect(await screen.findByText(translate('ar', 'errors.INVALID_CREDENTIALS'))).toBeTruthy();
    expect(mockReplace).not.toHaveBeenCalled();
  });
});
