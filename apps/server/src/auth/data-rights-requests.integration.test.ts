import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabaseClient } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { dataRightsRequests } from '../db/schema/data-rights-requests.js';

import type { Database } from '../db/client.js';
import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';

const PASSWORD = 'correct-horse-battery-staple';

interface RequestEnvelope {
  request: {
    id: string;
    type: string;
    status: string;
    requestedAt: string;
    resolvedAt: string | null;
  } | null;
}

function toCookieHeader(setCookie: string[] | undefined): string {
  expect(setCookie).toBeDefined();
  return (setCookie ?? []).map((cookie) => cookie.split(';')[0]).join('; ');
}

describe('data rights requests (real Postgres + real HTTP)', () => {
  let postgres: StartedPostgreSqlContainer;
  let redis: StartedRedisContainer;
  let app: INestApplication;
  let server: Server;
  let db: Database;
  let counter = 0;

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer('postgres:16').start();
    process.env.DATABASE_URL = postgres.getConnectionUri();
    redis = await new RedisContainer('redis:7').start();
    process.env.REDIS_URL = redis.getConnectionUrl();
    await runMigrations(postgres.getConnectionUri());

    const { AppModule } = await import('../app.module.js');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    server = app.getHttpServer() as Server;
    db = createDatabaseClient(postgres.getConnectionUri());
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await db.$client.end();
    await postgres.stop();
    await redis.stop();
  }, 60_000);

  async function registerUser(): Promise<{ cookie: string; userId: string }> {
    counter += 1;
    const response = await request(server)
      .post('/auth/register')
      .send({ email: `data-rights-${String(counter)}@example.com`, password: PASSWORD });
    expect(response.status).toBe(201);
    return {
      cookie: toCookieHeader(response.get('Set-Cookie')),
      userId: (response.body as { user: { id: string } }).user.id,
    };
  }

  it('rejects unauthenticated requests', async () => {
    expect((await request(server).get('/me/data-rights-requests')).status).toBe(401);
    expect((await request(server).post('/me/data-rights-requests/deletion')).status).toBe(401);
  });

  it('creates one pending request idempotently and does not expose internal user data', async () => {
    const { cookie, userId } = await registerUser();

    const first = await request(server)
      .post('/me/data-rights-requests/deletion')
      .set('Cookie', cookie);
    const second = await request(server)
      .post('/me/data-rights-requests/deletion')
      .set('Cookie', cookie);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const firstBody = first.body as unknown as RequestEnvelope;
    const secondBody = second.body as unknown as RequestEnvelope;
    expect(secondBody.request?.id).toBe(firstBody.request?.id);
    expect(firstBody.request).toMatchObject({ type: 'deletion', status: 'pending' });
    expect(firstBody.request).not.toHaveProperty('userId');

    const rows = await db
      .select()
      .from(dataRightsRequests)
      .where(eq(dataRightsRequests.userId, userId));
    expect(rows).toHaveLength(1);
  });

  it('returns only the signed-in user request', async () => {
    const userA = await registerUser();
    const userB = await registerUser();
    const created = await request(server)
      .post('/me/data-rights-requests/deletion')
      .set('Cookie', userA.cookie);

    const own = await request(server).get('/me/data-rights-requests').set('Cookie', userA.cookie);
    const other = await request(server).get('/me/data-rights-requests').set('Cookie', userB.cookie);

    expect(own.status).toBe(200);
    const ownBody = own.body as unknown as RequestEnvelope;
    const createdBody = created.body as unknown as RequestEnvelope;
    expect(ownBody.request?.id).toBe(createdBody.request?.id);
    expect(other.status).toBe(200);
    expect(other.body as unknown).toEqual({ request: null });
  });
});
