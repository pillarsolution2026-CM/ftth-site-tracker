import { randomUUID } from 'node:crypto';

export interface Clock {
  now(): Date;
}
export const systemClock: Clock = { now: () => new Date() };

export interface IdGenerator {
  next(): string;
}
export const uuidGenerator: IdGenerator = { next: () => randomUUID() };
