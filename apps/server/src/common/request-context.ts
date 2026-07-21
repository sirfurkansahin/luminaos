/**
 * Declaration-merges LuminaOS's request-scoped auth/tenant context onto
 * Express's `Request` interface, so `SessionAuthGuard` (and, downstream, the
 * workspaces module's membership-resolution middleware/guard) can attach
 * `user`/`sessionId`/`membership` to `req` without every consumer needing an
 * `as` cast.
 *
 * All three fields are optional because they're populated progressively
 * during a request's lifecycle (no session => none of them are set; a valid
 * session but no workspace in the URL => `user`/`sessionId` set,
 * `membership` not).
 */
declare module 'express-serve-static-core' {
  interface Request {
    user?: {
      id: string;
      email: string;
    };
    sessionId?: string;
    membership?: {
      workspaceId: string;
      role: string;
    };
  }
}

export {};
