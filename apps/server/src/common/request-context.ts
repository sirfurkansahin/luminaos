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
    /** Populated only by `McpTokenAuthGuard` (`mcp-server/mcp-token-auth.guard.ts`,
     * ADR-0028 §m) -- never set on the `SessionAuthGuard` path. Carries the
     * resolved PAT grant's own id, used as the rate-limit key (ADR-0028 §h). */
    mcpGrant?: {
      id: string;
    };
  }
}

export {};
