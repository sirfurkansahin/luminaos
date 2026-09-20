/**
 * Resolves an API request URL for both local development (where Vite proxies
 * relative requests) and static production hosting (where the API is a
 * separate origin).
 */
export function resolveApiUrl(path: string, rawBaseUrl: string | undefined): string {
  if (rawBaseUrl === undefined || rawBaseUrl.trim() === '') {
    return path;
  }

  const configuredBaseUrl = rawBaseUrl.trim();

  if (configuredBaseUrl.startsWith('/') && !configuredBaseUrl.startsWith('//')) {
    const prefixWithoutTrailingSlash = configuredBaseUrl.replace(/\/$/, '');
    const segments = prefixWithoutTrailingSlash.split('/').slice(1);
    const isSafePathPrefix =
      !configuredBaseUrl.includes('?') &&
      !configuredBaseUrl.includes('#') &&
      segments.every(
        (segment) =>
          segment !== '' &&
          segment !== '.' &&
          segment !== '..' &&
          /^[A-Za-z0-9._~-]+$/.test(segment),
      );

    if (isSafePathPrefix) {
      return `${prefixWithoutTrailingSlash}${path}`;
    }
  }

  let baseUrl: URL;

  try {
    baseUrl = new URL(configuredBaseUrl);
  } catch {
    throw new Error(
      'VITE_API_BASE_URL must be an HTTP(S) origin or a safe root-relative path prefix.',
    );
  }

  if (
    (baseUrl.protocol !== 'http:' && baseUrl.protocol !== 'https:') ||
    baseUrl.username !== '' ||
    baseUrl.password !== '' ||
    baseUrl.pathname !== '/' ||
    baseUrl.search !== '' ||
    baseUrl.hash !== ''
  ) {
    throw new Error(
      'VITE_API_BASE_URL must be an HTTP(S) origin or a safe root-relative path prefix.',
    );
  }

  return `${baseUrl.origin}${path}`;
}
