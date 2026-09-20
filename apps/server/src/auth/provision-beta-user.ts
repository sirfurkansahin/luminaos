import { pathToFileURL } from 'node:url';

import { ConflictError, ValidationError } from '@luminaos/shared';

import { registerSchema } from './dto/register.schema.js';
import { hashPassword } from './password.js';
import { hasPostgresErrorCode } from '../common/postgres-error.js';
import { createDatabaseClient } from '../db/client.js';
import { users } from '../db/schema/users.js';

import type { Database } from '../db/client.js';
import type { RegisterInput } from './dto/register.schema.js';

const POSTGRES_UNIQUE_VIOLATION = '23505';
const MAX_STDIN_BYTES = 1024;

export function parseProvisionInput(email: string, password: string): RegisterInput {
  const result = registerSchema.safeParse({ email, password });
  if (!result.success) {
    throw new ValidationError('Invalid beta user credentials.');
  }
  return result.data;
}

export async function provisionBetaUser(
  db: Database,
  email: string,
  password: string,
): Promise<{ id: string; email: string }> {
  const input = parseProvisionInput(email, password);
  const passwordHash = await hashPassword(input.password);

  try {
    const [user] = await db
      .insert(users)
      .values({ email: input.email, passwordHash })
      .returning({ id: users.id, email: users.email });

    if (!user) {
      throw new ConflictError('User provisioning returned no row.');
    }
    return user;
  } catch (error) {
    if (hasPostgresErrorCode(error, POSTGRES_UNIQUE_VIOLATION)) {
      throw new ConflictError('A beta account with this email already exists.');
    }
    throw error;
  }
}

async function readPasswordFromStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new ValidationError('Password must be supplied through standard input.');
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    totalBytes += buffer.length;
    if (totalBytes > MAX_STDIN_BYTES) {
      throw new ValidationError('Password input is too large.');
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

function readEmailArgument(argv: string[]): string {
  const emailFlagIndex = argv.indexOf('--email');
  const email = emailFlagIndex >= 0 ? argv[emailFlagIndex + 1] : undefined;
  if (email === undefined || email.trim() === '') {
    throw new ValidationError('Usage: provision-beta-user --email <address>');
  }
  return email;
}

async function main(): Promise<void> {
  const email = readEmailArgument(process.argv.slice(2));
  const password = await readPasswordFromStdin();
  const { env } = await import('../config/env.js');
  const db = createDatabaseClient(env.databaseUrl);

  try {
    await provisionBetaUser(db, email, password);
    process.stdout.write('Beta user provisioned.\n');
  } finally {
    await db.$client.end();
  }
}

const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  main().catch((error: unknown) => {
    const message = error instanceof ValidationError || error instanceof ConflictError
      ? error.message
      : 'Beta user provisioning failed.';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
