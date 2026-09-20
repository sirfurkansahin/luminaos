import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { onRequest } from './[[path]].js';

const originalFetch = globalThis.fetch;
const VALID_ENV = {
  API_ORIGIN: 'https://api.example.test',
  API_PROXY_SECRET: 'test-proxy-secret-that-is-long-enough',
  PUBLIC_WEB_ORIGIN: 'https://lumina.pages.dev',
};

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('forwards an API request to the fixed HTTPS origin and strips only /api', async () => {
  let forwarded;
  globalThis.fetch = async (request) => {
    forwarded = request;
    return new Response('created', {
      status: 201,
      headers: { 'set-cookie': 'sid=test; Secure; HttpOnly; Path=/' },
    });
  };

  const request = new Request('https://lumina.pages.dev/api/workspaces?view=board', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: 'sid=existing',
      origin: 'https://lumina.pages.dev',
      'x-lumina-proxy-secret': 'attacker-controlled',
    },
    body: JSON.stringify({ name: 'Alpha' }),
  });

  const response = await onRequest({
    request,
    env: { ...VALID_ENV, API_ORIGIN: 'https://api.example.test/' },
  });

  assert.equal(forwarded.url, 'https://api.example.test/workspaces?view=board');
  assert.equal(forwarded.method, 'POST');
  assert.equal(forwarded.headers.get('cookie'), 'sid=existing');
  assert.equal(forwarded.headers.get('origin'), 'https://lumina.pages.dev');
  assert.equal(
    forwarded.headers.get('x-lumina-proxy-secret'),
    'test-proxy-secret-that-is-long-enough',
  );
  assert.deepEqual(await forwarded.json(), { name: 'Alpha' });
  assert.equal(response.status, 201);
  assert.match(response.headers.get('set-cookie'), /HttpOnly/);
});

test('passes a WebSocket upgrade request through to the upstream path', async () => {
  let forwarded;
  const upstreamResponse = new Response(null, { status: 204 });
  globalThis.fetch = async (request) => {
    forwarded = request;
    return upstreamResponse;
  };

  const request = new Request('https://lumina.pages.dev/api/ws/docs?docId=01ABC', {
    headers: { upgrade: 'websocket', cookie: 'sid=test' },
  });
  const response = await onRequest({
    request,
    env: VALID_ENV,
  });

  assert.equal(forwarded.url, 'https://api.example.test/ws/docs?docId=01ABC');
  assert.equal(forwarded.headers.get('upgrade'), 'websocket');
  assert.equal(response, upstreamResponse);
});

test('cannot escape the configured origin with a network-path API URL', async () => {
  let forwarded;
  globalThis.fetch = async (request) => {
    forwarded = request;
    return new Response('ok');
  };

  await onRequest({
    request: new Request('https://lumina.pages.dev/api//attacker.example/secrets'),
    env: VALID_ENV,
  });

  assert.equal(forwarded.url, 'https://api.example.test//attacker.example/secrets');
});

test('fails closed for missing, invalid, or self-referential configuration', async (t) => {
  const request = new Request('https://lumina.pages.dev/api/health');
  const cases = [
    { ...VALID_ENV, API_ORIGIN: undefined },
    {
      ...VALID_ENV,
      API_ORIGIN: 'http://api.example.test',
    },
    {
      ...VALID_ENV,
      API_ORIGIN: 'https://user:secret@api.example.test',
    },
    {
      ...VALID_ENV,
      API_ORIGIN: 'https://api.example.test/path',
    },
    {
      ...VALID_ENV,
      API_ORIGIN: 'https://lumina.pages.dev',
    },
    { ...VALID_ENV, API_PROXY_SECRET: undefined },
    { ...VALID_ENV, API_PROXY_SECRET: 'too-short' },
    { ...VALID_ENV, PUBLIC_WEB_ORIGIN: undefined },
    { ...VALID_ENV, PUBLIC_WEB_ORIGIN: 'http://lumina.pages.dev' },
    { ...VALID_ENV, PUBLIC_WEB_ORIGIN: 'https://preview.lumina.pages.dev' },
  ];

  for (const env of cases) {
    await t.test(JSON.stringify(env), async () => {
      let called = false;
      globalThis.fetch = async () => {
        called = true;
        return new Response();
      };

      const response = await onRequest({ request, env });
      assert.equal(response.status, 503);
      assert.equal(called, false);
      assert.deepEqual(await response.json(), { error: 'api_proxy_unavailable' });
    });
  }
});
