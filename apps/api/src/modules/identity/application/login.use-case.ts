import type { LoginRequest, TokenPair } from '@ftth/shared';
import { AppError } from '../../../common/app-error.js';
import type { EventLog } from '../../../common/event-log.port.js';
import type { UserRepository } from '../domain/user.js';
import type { PasswordHasher } from './ports.js';
import type { SessionIssuer } from './session-issuer.js';

export class LoginUseCase {
  private dummyHash: Promise<string> | undefined;

  constructor(
    private readonly users: UserRepository,
    private readonly hasher: PasswordHasher,
    private readonly sessions: SessionIssuer,
    private readonly events: EventLog,
  ) {}

  async execute(request: LoginRequest): Promise<TokenPair> {
    const user = await this.users.findByEmail(request.email.trim().toLowerCase());
    // Unknown email still pays for one hash verification so timing does not reveal which emails exist.
    const hashToCheck = user?.passwordHash ?? (await this.getDummyHash());
    const passwordMatches = await this.hasher.verify(hashToCheck, request.password);

    if (!user || !passwordMatches || !user.isActive) {
      throw new AppError('INVALID_CREDENTIALS', 'Invalid email or password');
    }

    const tokens = await this.sessions.startSession(user);
    await this.events.append({
      entity: 'user',
      entityId: user.id,
      type: 'user.logged_in',
      actorId: user.id,
    });
    return tokens;
  }

  private getDummyHash(): Promise<string> {
    this.dummyHash ??= this.hasher.hash('not-a-real-password');
    return this.dummyHash;
  }
}
