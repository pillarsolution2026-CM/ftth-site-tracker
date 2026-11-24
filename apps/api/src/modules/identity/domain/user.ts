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

/** The contractor a login account belongs to (ADR-053); contractor accounts are users of one contractor. */
export interface ContractorAccountLookup {
  /** The contractor of the user, or null when the user is not a contractor account. */
  contractorOf(userId: string): Promise<{ id: string; name: string } | null>;
}
