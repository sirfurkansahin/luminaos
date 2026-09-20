import { pathToFileURL } from 'node:url';

const DEFAULT_TIMEOUT_MS = 10_000;

export function parseProductionOrigin(value) {
  let url;

  try {
    url = new URL(value);
  } catch {
    throw new TypeError('Production origin must be a valid HTTPS URL.');
  }

  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new TypeError('Production origin must be a pathless HTTPS origin without credentials.');
  }

  return url;
}

function timeoutSignal(timeoutMs) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('Timeout must be a positive integer.');
  }

  return AbortSignal.timeout(timeoutMs);
}

async function checkWebShell(origin, fetchImpl, timeoutMs) {
  const url = new URL('/?view=list', origin);
  const response = await fetchImpl(url, {
    headers: { accept: 'text/html' },
    redirect: 'error',
    signal: timeoutSignal(timeoutMs),
  });
  const contentType = response.headers.get('content-type') ?? '';

  if (!response.ok || !contentType.toLowerCase().includes('text/html')) {
    throw new Error(`Production web shell check failed with HTTP ${response.status}.`);
  }

  const body = await response.text();
  if (!/<(?:div|main)\s+[^>]*id=["']root["'][^>]*>/i.test(body)) {
    throw new Error('Production web shell response does not contain the application root.');
  }
}

async function checkApiHealth(origin, fetchImpl, timeoutMs) {
  const url = new URL('/api/health', origin);
  const response = await fetchImpl(url, {
    headers: { accept: 'application/json' },
    redirect: 'error',
    signal: timeoutSignal(timeoutMs),
  });

  if (!response.ok) {
    throw new Error(`Production API health check failed with HTTP ${response.status}.`);
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error('Production API health payload is not valid JSON.');
  }

  if (
    typeof payload !== 'object' ||
    payload === null ||
    payload.status !== 'ok' ||
    typeof payload.checks !== 'object' ||
    payload.checks === null ||
    payload.checks.db !== 'ok' ||
    payload.checks.redis !== 'ok'
  ) {
    throw new Error('Production API health payload reports an unhealthy dependency.');
  }
}

export async function checkProduction(
  originValue,
  { fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {},
) {
  const origin = parseProductionOrigin(originValue);

  await checkWebShell(origin, fetchImpl, timeoutMs);
  await checkApiHealth(origin, fetchImpl, timeoutMs);

  return { web: 'ok', api: 'ok' };
}

async function main() {
  const origin = process.env.PRODUCTION_ORIGIN;
  if (origin === undefined || origin.trim() === '') {
    throw new TypeError('PRODUCTION_ORIGIN is required.');
  }

  const result = await checkProduction(origin);
  process.stdout.write(`Production checks passed: web=${result.web}, api=${result.api}\n`);
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : 'Production check failed.';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
