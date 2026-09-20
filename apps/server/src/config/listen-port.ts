const DEFAULT_LISTEN_PORT = 3000;
const MIN_PORT = 1;
const MAX_PORT = 65_535;

/**
 * Resolves the TCP port used by the HTTP server. Hosting platforms commonly
 * inject `PORT`; local development deliberately keeps the established 3000
 * default when it is absent.
 */
export function resolveListenPort(rawPort: string | undefined): number {
  if (rawPort === undefined) {
    return DEFAULT_LISTEN_PORT;
  }

  if (!/^\d+$/.test(rawPort)) {
    throw new Error('PORT must be an integer between 1 and 65535.');
  }

  const port = Number(rawPort);

  if (!Number.isSafeInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    throw new Error('PORT must be an integer between 1 and 65535.');
  }

  return port;
}
