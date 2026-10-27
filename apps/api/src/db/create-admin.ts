import { fileURLToPath } from 'node:url';
import { hash } from '@node-rs/argon2';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { z } from 'zod';
import type { Database } from './db.module.js';
import { schema, users } from './schema.js';

/** Bootstrap admin for staging/production, where the dev seed is not allowed. */
export const CreateAdminInputSchema = z.object({
  email: z
    .email()
    .max(254)
    .transform((email) => email.toLowerCase()),
  password: z.string().min(12).max(128),
  displayName: z.string().min(1).max(100).default('Administrator'),
});
export type CreateAdminInput = z.input<typeof CreateAdminInputSchema>;

/** Creates the admin if the email is unused. Never overwrites an existing user. */
export async function createAdmin(
  db: Database,
  input: CreateAdminInput,
): Promise<{ created: boolean; id: string }> {
  const { email, password, displayName } = CreateAdminInputSchema.parse(input);
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
  if (existing) return { created: false, id: existing.id };

  const [created] = await db
    .insert(users)
    .values({ email, displayName, passwordHash: await hash(password), isAdmin: true, locale: 'ar' })
    .returning({ id: users.id });
  if (!created) throw new Error('admin insert returned no row');
  return { created: true, id: created.id };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  const pool = new pg.Pool({ connectionString: url });
  createAdmin(drizzle(pool, { schema }), {
    email: process.env.ADMIN_EMAIL ?? '',
    password: process.env.ADMIN_PASSWORD ?? '',
    displayName: process.env.ADMIN_NAME,
  })
    .then(({ created }) => console.log(created ? 'Admin created' : 'Admin already exists'))
    .catch((error: unknown) => {
      console.error(error instanceof z.ZodError ? z.prettifyError(error) : error);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
