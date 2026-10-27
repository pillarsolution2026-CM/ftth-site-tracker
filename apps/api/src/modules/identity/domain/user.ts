export type Locale = 'ar' | 'en' | 'fr';

export interface User {
  id: string;
  email: string;
  displayName: string;
  passwordHash: string;
  locale: Locale;
  isAdmin: boolean;
  isActive: boolean;
}

export interface UserRepository {
  /** `email` must already be normalised to lower case. */
  findByEmail(email: string): Promise<User | null>;
  findById(id: string): Promise<User | null>;
}
