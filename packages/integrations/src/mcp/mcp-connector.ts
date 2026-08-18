/**
 * LuminaOS's own MCP protocol client abstraction — see ADR-0025 §f.
 */

export type ConnectorHealthStatus = 'ok' | 'error';

export interface ConnectorHealth {
  status: ConnectorHealthStatus;
  /** Only present when status is 'error' — a short, loggable (never
   * credential-bearing) diagnostic string, mirrors `HealthService`'s
   * `checks` shape's spirit but per-connector, not global. */
  detail?: string;
}

export interface McpToolCallResult {
  /** Raw MCP tool-call result payload, already zod-validated by the
   * concrete connector implementation against ITS OWN declared result
   * shape before being returned here — callers never receive
   * unvalidated external input (Mimari Değişmez: "her dış girdi şema ile
   * doğrulanır"). */
  content: unknown;
  isError: boolean;
}

export interface McpResourceReadResult {
  uri: string;
  mimeType?: string;
  /** Already zod-validated by the concrete connector before being
   * returned, same discipline as `McpToolCallResult.content`. */
  content: unknown;
}

/**
 * LuminaOS's own connector lifecycle contract — deliberately NOT a
 * wrapper re-exporting `@modelcontextprotocol/sdk`'s own types. Concrete
 * implementations (real transports, `MockMcpConnector`) hide the SDK's
 * actual client/transport classes entirely behind this interface, so
 * every OTHER package in this codebase (F2-T10's real connectors,
 * F2-T11's Connected Search, F2-T12's MCP server) depends only on this
 * stable surface, never on the SDK's own API directly (ADR-0025 SDK
 * boundary note).
 *
 * Error convention: every method THROWS on failure (never returns a
 * result/error union) — mirrors `CalendarConnector`'s existing
 * convention (`refreshToken` throws, doesn't return
 * `{ok:false,error}`), and this codebase's general "errors thrown via
 * packages/shared/errors classes" rule (CLAUDE.md "Kodlama
 * Sözleşmeleri"). `checkHealth` is the ONE deliberate exception below —
 * it never throws, mirroring `HealthService`'s own probe functions,
 * because a connector being unhealthy is an expected, non-exceptional
 * outcome for a health check, not a failure of the check itself.
 */
export interface McpConnector {
  readonly connectorType: string;

  /** Idempotent — establishes (or re-establishes) the underlying MCP
   * session/transport. Throws if the underlying transport/handshake
   * fails. */
  connect(): Promise<void>;

  /** Idempotent — tears down the underlying session/transport. Safe to
   * call on an already-disconnected connector (no-op). */
  disconnect(): Promise<void>;

  /** Never throws — always resolves to a `ConnectorHealth`, even when
   * the underlying probe fails or times out (the concrete
   * implementation is responsible for its own internal
   * try/catch-and-degrade, mirroring `probeDatabase`/`probeRedis`'s
   * internal catch). Callers (e.g. `ConnectorHealthService`, Karar (m))
   * still apply their OWN `withTimeout` wrapper as defense-in-depth,
   * same "belt and suspenders" reasoning `HealthService.check` already
   * uses via `Promise.allSettled`. */
  checkHealth(): Promise<ConnectorHealth>;

  /** Throws if not connected, if `toolName` is unknown to the
   * underlying MCP server, or if the underlying call fails. `args` is
   * validated against a zod schema INSIDE the concrete implementation
   * before being sent (Mimari Değişmez). */
  callTool(toolName: string, args: Record<string, unknown>): Promise<McpToolCallResult>;

  /** Throws if not connected or if `uri` is unknown/unreadable. */
  readResource(uri: string): Promise<McpResourceReadResult>;
}
