import { fileURLToPath } from 'node:url';
import { hash } from '@node-rs/argon2';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import type { Database } from './db.module.js';
import { assignments, projects, schema, users, zones } from './schema.js';

const SEED_USERS = [
  { email: 'admin@ftth.local', displayName: 'Admin', password: 'Admin#12345', isAdmin: true },
  { email: 'pm@ftth.local', displayName: 'Project Manager', password: 'Pm#123456', isAdmin: false },
  {
    email: 'supervisor@ftth.local',
    displayName: 'Supervisor',
    password: 'Super#12345',
    isAdmin: false,
  },
] as const;

async function ensureProject(db: Database, name: string, client: string): Promise<string> {
  const [existing] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.name, name));
  if (existing) return existing.id;
  const [created] = await db
    .insert(projects)
    .values({ name, client, crsEpsg: 32636, currency: 'EGP', locale: 'ar' })
    .returning({ id: projects.id });
  if (!created) throw new Error('project insert returned no row');
  return created.id;
}

/** Idempotent development seed. Never run against production data. */
export async function seed(db: Database): Promise<void> {
  const ids = new Map<string, string>();
  for (const user of SEED_USERS) {
    const [existing] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, user.email));
    if (existing) {
      ids.set(user.email, existing.id);
      continue;
    }
    // @node-rs/argon2 defaults to Argon2id.
    const passwordHash = await hash(user.password);
    const [created] = await db
      .insert(users)
      .values({
        email: user.email,
        displayName: user.displayName,
        passwordHash,
        isAdmin: user.isAdmin,
        locale: 'ar',
      })
      .returning({ id: users.id });
    if (!created) throw new Error('user insert returned no row');
    ids.set(user.email, created.id);
  }

  const projectA = await ensureProject(db, 'القطاع الأول – قليوب', 'WE');
  await ensureProject(db, 'Test Project B', 'WE');

  let [zone] = await db
    .select({ id: zones.id })
    .from(zones)
    .where(and(eq(zones.projectId, projectA), eq(zones.name, 'Sector 1')));
  if (!zone) {
    [zone] = await db
      .insert(zones)
      .values({ projectId: projectA, name: 'Sector 1' })
      .returning({ id: zones.id });
  }
  if (!zone) throw new Error('zone insert returned no row');

  const pmId = ids.get('pm@ftth.local');
  const supervisorId = ids.get('supervisor@ftth.local');
  if (!pmId || !supervisorId) throw new Error('seed users missing');
  await db
    .insert(assignments)
    .values([
      { userId: pmId, projectId: projectA, role: 'pm' },
      { userId: supervisorId, projectId: projectA, role: 'supervisor', zoneId: zone.id },
    ])
    .onConflictDoNothing();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  if (process.env.NODE_ENV === 'production') {
    console.error('Refusing to seed with NODE_ENV=production');
    process.exit(1);
  }
  if (process.env.ALLOW_DEV_SEED !== 'true') {
    console.error('Refusing to seed: set ALLOW_DEV_SEED=true to confirm this is a dev database');
    process.exit(1);
  }
  const pool = new pg.Pool({ connectionString: url });
  seed(drizzle(pool, { schema }))
    .then(() => console.log('Seed complete'))
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
