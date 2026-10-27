import { API_URL } from '../../../shared/config/env';
import { SecureTokenStorage } from '../../../shared/storage/token-storage';
import { createAuthApi } from './api-client';

/** Production wiring: real API URL + OS secure store. Tests build their own client. */
export const authApi = createAuthApi({ baseUrl: API_URL, storage: new SecureTokenStorage() });
