import { env } from '../config/env.js';

import type { NextFunction, Request, Response } from 'express';

/**
 * `apps/web` authenticates via an httpOnly session cookie (`sameSite:
 * 'lax'`, see `auth/auth.controller.ts`) and is served from a different
 * origin (Vite dev port) than this API, so credentialed cross-origin
 * requests need an explicit allowlist. A wildcard origin is rejected by
 * browsers whenever `Access-Control-Allow-Credentials: true` is also sent,
 * so only a request whose `Origin` matches `env.webOrigin` (or, since F2-T3
 * PR4 / ADR-0020, `env.desktopOrigin` — `apps/desktop`'s Tauri webview, which
 * carries the same httpOnly session cookie once a session exists) exactly
 * gets the CORS headers reflected back — every other origin gets neither
 * header, never a wildcard fallback.
 */
export function corsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const origin = req.headers.origin;

  // Always vary on Origin, even for non-matching origins, so an
  // origin-unaware cache never serves one origin's response to another.
  res.setHeader('Vary', 'Origin');

  if (origin === env.webOrigin || origin === env.desktopOrigin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.statusCode = 204;
    res.end();
    return;
  }

  next();
}
