import { z } from 'zod';

import { desktopSignalTypeSchema } from './grant-desktop-signal-consent.schema.js';

/**
 * Validates a `POST /workspaces/:workspaceId/context/desktop-signals` request
 * body (F2-T3 PR2, ADR-0020 Karar b/c/d). Deliberately NOT `.strict()` — same
 * self-service-by-construction reasoning as
 * `grantDesktopSignalConsentSchema`: the SESSION user (`req.user.id`) is the
 * only source of user identity, so an extra `userId` key in the body is a
 * harmless, silently-stripped no-op rather than a validation error.
 */
/**
 * security-reviewer finding (F2-T3 PR2): `value` is meant to carry only a
 * derived/summarized signal (a short app-name label, a busy/free status) per
 * ADR-0020 Karar (e)'s "yerinde işleme" boundary — that boundary is a
 * CLIENT-side rule (enforced by the desktop app in PR3/PR4), so the server
 * must not silently trust it. Without a length cap here, any authenticated
 * workspace member could POST an arbitrarily large string directly (bypassing
 * the desktop client entirely), which lands unbounded in the immutable event
 * log AND as a `context_graph_nodes.natural_key` value. 200 chars is
 * generously above any real derived-signal value (an app name, a busy/free
 * enum) while still bounding worst-case storage/DoS exposure.
 */
export const captureDesktopSignalSchema = z.object({
  signalType: desktopSignalTypeSchema,
  value: z.string().min(1).max(200),
});

export type CaptureDesktopSignalInput = z.infer<typeof captureDesktopSignalSchema>;
