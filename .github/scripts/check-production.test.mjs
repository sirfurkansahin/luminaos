import assert from 'node:assert/strict';
import test from 'node:test';

import { checkProduction, parseProductionOrigin } from './check-production.mjs';

test('parseProductionOrigin accepts only a pathless HTTPS origin', () => {
  assert.equal(parseProductionOrigin('https://example.com').href, 'https://example.com/');

  for (const value of [
    'http://example.com',
    'https://user:secret@example.com',
    'https://example.com/path',
    'https://example.com?query=yes',
    'not-a-url',
  ]) {
    assert.throws(() => parseProductionOrigin(value));
  }
});

test('checkProduction validates the web shell and healthy dependencies', async () => {
  const requested = [];
  const fetchImpl = async (url, options) => {
    requested.push({ url: String(url), options });

    if (String(url).endsWith('/?view=list')) {
      return new Response('<!doctype html><div id="root"></div>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }

    return Response.json({
      status: 'ok',
      checks: { db: 'ok', redis: 'ok' },
      version: 'test',
    });
  };

  const result = await checkProduction('https://example.com', {
    fetchImpl,
    timeoutMs: 1234,
  });

  assert.deepEqual(result, { web: 'ok', api: 'ok' });
  assert.deepEqual(
    requested.map(({ url }) => url),
    ['https://example.com/?view=list', 'https://example.com/api/health'],
  );
  assert.ok(requested.every(({ options }) => options.signal instanceof AbortSignal));
});

test('checkProduction rejects an unhealthy API without exposing its body', async () => {
  const fetchImpl = async (url) => {
    if (String(url).endsWith('/?view=list')) {
      return new Response('<div id="root"></div>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    }

    return Response.json({
      status: 'degraded',
      checks: { db: 'error', redis: 'ok' },
      privateDetail: 'must-not-be-in-the-error',
    });
  };

  await assert.rejects(checkProduction('https://example.com', { fetchImpl }), (error) => {
    assert.match(error.message, /health payload/i);
    assert.doesNotMatch(error.message, /privateDetail|must-not-be-in-the-error/);
    return true;
  });
});

test('checkProduction rejects a non-HTML or rootless web response', async () => {
  const fetchImpl = async () =>
    new Response('temporarily unavailable', {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    });

  await assert.rejects(checkProduction('https://example.com', { fetchImpl }), /web shell/i);
});
