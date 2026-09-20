const unavailableResponse = () =>
  Response.json({ error: 'api_proxy_unavailable' }, { status: 503 });

function resolveHttpsOrigin(rawOrigin) {
  if (typeof rawOrigin !== 'string') {
    return null;
  }

  let origin;
  try {
    origin = new URL(rawOrigin.trim());
  } catch {
    return null;
  }

  if (
    origin.protocol !== 'https:' ||
    origin.username !== '' ||
    origin.password !== '' ||
    origin.pathname !== '/' ||
    origin.search !== '' ||
    origin.hash !== ''
  ) {
    return null;
  }

  return origin.origin;
}

function resolveProxySecret(rawSecret) {
  if (
    typeof rawSecret !== 'string' ||
    rawSecret.length < 32 ||
    rawSecret.length > 256 ||
    !/^[A-Za-z0-9+/=_-]+$/.test(rawSecret)
  ) {
    return null;
  }

  return rawSecret;
}

export async function onRequest({ request, env }) {
  const requestUrl = new URL(request.url);
  if (requestUrl.pathname !== '/api' && !requestUrl.pathname.startsWith('/api/')) {
    return Response.json({ error: 'not_found' }, { status: 404 });
  }

  const publicWebOrigin = resolveHttpsOrigin(env.PUBLIC_WEB_ORIGIN);
  const upstreamOrigin = resolveHttpsOrigin(env.API_ORIGIN);
  const proxySecret = resolveProxySecret(env.API_PROXY_SECRET);
  if (
    publicWebOrigin === null ||
    publicWebOrigin !== requestUrl.origin ||
    upstreamOrigin === null ||
    upstreamOrigin === publicWebOrigin ||
    proxySecret === null
  ) {
    return unavailableResponse();
  }

  const upstreamPath = requestUrl.pathname.slice('/api'.length) || '/';
  const upstreamUrl = new URL(upstreamOrigin);
  upstreamUrl.pathname = upstreamPath;
  upstreamUrl.search = requestUrl.search;

  const upstreamRequest = new Request(new Request(upstreamUrl, request), {
    redirect: 'manual',
  });
  upstreamRequest.headers.set('x-lumina-proxy-secret', proxySecret);

  return fetch(upstreamRequest);
}
