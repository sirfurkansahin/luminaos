import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../db/migrate.js';

import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';

const CURRENT_PASSWORD = 'correct-horse-battery-staple';
const NEW_PASSWORD = 'new-correct-horse-battery-staple';

function toCookieHeader(setCookie: string[] | undefined): string {
  expect(setCookie).toBeDefined();
  expect(setCookie?.length).toBeGreaterThan(0);
  return (setCookie ?? []).map((cookie) => cookie.split(';')[0]).join('; ');
}

describe('POST /auth/change-password', () => {
  let postgres: StartedPostgreSqlContainer;
  let redis: StartedRedisContainer;
  let app: INestApplication;
  let server: Server;

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer('postgres:16').start();
    redis = await new RedisContainer('redis:7').start();
    process.env.DATABASE_URL = postgres.getConnectionUri();
    process.env.REDIS_URL = redis.getConnectionUrl();
    await runMigrations(postgres.getConnectionUri());

    const { AppModule } = await import('../app.module.js');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    server = app.getHttpServer() as Server;
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await postgres.stop();
    await redis.stop();
  }, 60_000);

  it('requires authentication and rejects an incorrect current password', async () => {
    const email = 'change-password-wrong@example.com';
    const registerResponse = await request(server)
      .post('/auth/register')
      .send({ email, password: CURRENT_PASSWORD });
    const cookie = toCookieHeader(registerResponse.get('Set-Cookie'));

    const unauthenticated = await request(server)
      .post('/auth/change-password')
      .send({ currentPassword: CURRENT_PASSWORD, newPassword: NEW_PASSWORD });
    expect(unauthenticated.status).toBe(401);

    const wrongCurrent = await request(server)
      .post('/auth/change-password')
      .set('Cookie', cookie)
      .send({ currentPassword: 'definitely-wrong-password', newPassword: NEW_PASSWORD });
    expect(wrongCurrent.status).toBe(401);

    const oldPasswordStillWorks = await request(server)
      .post('/auth/login')
      .send({ email, password: CURRENT_PASSWORD });
    expect(oldPasswordStillWorks.status).toBe(200);
  }, 60_000);

  it('changes the password, revokes every old session, and issues one fresh session', async () => {
    const email = 'change-password-success@example.com';
    const registerResponse = await request(server)
      .post('/auth/register')
      .send({ email, password: CURRENT_PASSWORD });
    expect(registerResponse.status).toBe(201);
    const registrationCookie = toCookieHeader(registerResponse.get('Set-Cookie'));

    const secondLogin = await request(server)
      .post('/auth/login')
      .send({ email, password: CURRENT_PASSWORD });
    expect(secondLogin.status).toBe(200);
    const secondCookie = toCookieHeader(secondLogin.get('Set-Cookie'));

    const changeResponse = await request(server)
      .post('/auth/change-password')
      .set('Cookie', registrationCookie)
      .send({ currentPassword: CURRENT_PASSWORD, newPassword: NEW_PASSWORD });
    expect(changeResponse.status).toBe(204);
    const freshCookie = toCookieHeader(changeResponse.get('Set-Cookie'));

    expect((await request(server).get('/me').set('Cookie', registrationCookie)).status).toBe(401);
    expect((await request(server).get('/me').set('Cookie', secondCookie)).status).toBe(401);
    expect((await request(server).get('/me').set('Cookie', freshCookie)).status).toBe(200);

    expect(
      (
        await request(server)
          .post('/auth/login')
          .send({ email, password: CURRENT_PASSWORD })
      ).status,
    ).toBe(401);
    expect(
      (
        await request(server)
          .post('/auth/login')
          .send({ email, password: NEW_PASSWORD })
      ).status,
    ).toBe(200);
  }, 60_000);
});
