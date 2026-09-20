import { describe, expect, it } from 'vitest';

import { resolveApiUrl } from './api-url.js';

describe('resolveApiUrl', () => {
  it.each([
    'ftp://host',
    'https://user:secret@host',
    'https://host/path',
    'https://host?q=1',
    'https://host/#fragment',
  ])('rejects a base URL that is not a plain HTTP origin: %s', (origin) => {
    expect(() => resolveApiUrl('/health', origin)).toThrow('VITE_API_BASE_URL');
  });
  it('keeps relative URLs when no production API origin is configured', () => {
    expect(resolveApiUrl('/workspaces/ws-1/objects', undefined)).toBe('/workspaces/ws-1/objects');
  });

  it('joins a configured API origin and relative path', () => {
    expect(resolveApiUrl('/workspaces/ws-1/objects', 'https://api.example.test')).toBe(
      'https://api.example.test/workspaces/ws-1/objects',
    );
  });

  it('does not duplicate a slash when the configured origin has a trailing slash', () => {
    expect(resolveApiUrl('/health', 'https://api.example.test/')).toBe(
      'https://api.example.test/health',
    );
  });

  it('joins a root-relative same-origin proxy prefix and API path', () => {
    expect(resolveApiUrl('/workspaces/ws-1/objects?limit=10', '/api/')).toBe(
      '/api/workspaces/ws-1/objects?limit=10',
    );
  });

  it.each(['//other-host/path', '/api?target=other', '/api#fragment'])(
    'rejects an unsafe root-relative API prefix: %s',
    (prefix) => {
      expect(() => resolveApiUrl('/health', prefix)).toThrow('VITE_API_BASE_URL');
    },
  );

  it('rejects an invalid configured origin', () => {
    expect(() => resolveApiUrl('/health', 'not a url')).toThrow('VITE_API_BASE_URL');
  });
});
