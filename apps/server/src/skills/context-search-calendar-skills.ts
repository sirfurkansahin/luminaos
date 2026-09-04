import { generateKeyPairSync } from 'node:crypto';

import { z } from 'zod';

import { ValidationError } from '@luminaos/shared';
import { signSkillManifest } from '@luminaos/skill-sdk';
import type { Skill, SkillManifest } from '@luminaos/skill-sdk';

import { listCalendarEventsSchema } from '../calendar/dto/list-calendar-events.schema.js';

import type {
  CachedCalendarEvent,
  CalendarEventsService,
} from '../calendar/calendar-events.service.js';
import type { ContextResponse, ContextService } from '../context/context.service.js';
import type {
  ConnectedSearchResponse,
  ConnectedSearchService,
} from '../search/connected-search.service.js';

/**
 * F3-T2 PR4 (2/2), ADR-0036 — catalog #13-15 (spec table): `get-object-
 * context` (`ContextService.getContext`), `search-connected-sources`
 * (`ConnectedSearchService.searchExternal`), `list-cached-calendar-events`
 * (`CalendarEventsService.listCachedEvents`). Same conventions as PR3's
 * `object-skills.ts` / this PR's sibling `meeting-recurrence-skills.ts`
 * (fixed `CALLER_ROLE = 'member'` where an actor/role is needed at all,
 * `parseSkillInput`+zod validation, Ed25519-signed manifests).
 */
const CALLER_ROLE = 'member';

function parseSkillInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);

  if (!result.success) {
    throw new ValidationError('Invalid skill input', { issues: result.error.issues });
  }

  return result.data;
}

/**
 * BUG FIX (security-review finding, F3-T2 PR4): `SkillExecutionService.
 * executeSkill` always injects `workspaceId`/`agentIdentifier` into `input`
 * before `execute` runs. `listCalendarEventsSchema` is `.strict()` with only
 * `start`/`end`, so parsing the raw `input` against it always failed with
 * `unrecognized_keys` -- `list-cached-calendar-events` was unreachable
 * through its real entry point. Stripping these two known, always-present
 * context fields first preserves the DTO's mass-assignment protection
 * against any OTHER unexpected field. Same fix applied in `object-skills.ts`
 * / `meeting-recurrence-skills.ts`.
 */
function stripAuthoritativeContext(input: unknown): unknown {
  if (typeof input !== 'object' || input === null) {
    return input;
  }
  const withoutContext = { ...(input as Record<string, unknown>) };
  delete withoutContext.workspaceId;
  delete withoutContext.agentIdentifier;
  return withoutContext;
}

/** A fresh Ed25519 keypair generated once, at this module's own load time -- same known, temporary gap as `object-skills.ts`. */
const { privateKey, publicKey } = generateKeyPairSync('ed25519');

/** The public half of this module's own signing keypair, exported so the skills module can register these 3 skills against the key they were ACTUALLY signed with. */
export const CONTEXT_SEARCH_CALENDAR_SKILLS_SIGNING_PUBLIC_KEY_PEM = publicKey.export({
  type: 'spki',
  format: 'pem',
});

const CONTEXT_SEARCH_CALENDAR_SKILLS_SIGNING_PRIVATE_KEY_PEM = privateKey.export({
  type: 'pkcs8',
  format: 'pem',
});

function signManifest(id: string, capability: string): SkillManifest {
  const unsigned = { id, version: '1.0.0', capability };
  return {
    ...unsigned,
    signature: signSkillManifest(unsigned, CONTEXT_SEARCH_CALENDAR_SKILLS_SIGNING_PRIVATE_KEY_PEM),
  };
}

/**
 * `get-object-context` IS objectId-based (its `objectId` is an existing
 * object whose real type must be resolved BEFORE the permission check, per
 * ADR-0036 Karar f) -- and its caller-supplied field IS literally named
 * `objectId`, so it IS compatible with PR3's already-merged
 * `callObjectIdBasedSkill` (reused unchanged by callers, from
 * `./object-skills.js`). `execute` itself just calls `getContext` -- no
 * pre-fetched-object-reuse trick (same "no unforgeable channel" reasoning as
 * `get-object`'s own doc comment in `object-skills.ts`).
 */
export function buildGetObjectContextSkill(
  contextService: ContextService,
): Skill<unknown, unknown> {
  return {
    manifest: signManifest(
      'get-object-context',
      "Fetches a Lumina Object's 1-hop context graph (related entities).",
    ),
    execute: async (input: unknown): Promise<ContextResponse> => {
      const context = parseSkillInput(
        z
          .object({
            workspaceId: z.string().min(1),
            agentIdentifier: z.string().min(1),
            objectId: z.string().min(1),
            options: z
              .object({ sort: z.literal('relevance').optional() })
              .strict()
              .optional(),
          })
          .loose(),
        input,
      );

      // `exactOptionalPropertyTypes` -- `GetContextOptions.sort` is `'relevance'`
      // plain-optional, not `'relevance' | undefined`, so `context.options`
      // (whose zod-inferred `sort` IS `'relevance' | undefined`) cannot be
      // passed through as-is when it carries an explicit `sort: undefined`.
      const options =
        context.options?.sort !== undefined ? { sort: context.options.sort } : undefined;

      return contextService.getContext(context.workspaceId, context.objectId, CALLER_ROLE, options);
    },
  };
}

const searchConnectedSourcesInputSchema = z.object({ query: z.string().min(1) }).loose();

/**
 * SECURITY-CRITICAL (this task's own instructions): this input schema
 * declares NO `userId` field at all -- `execute` calls
 * `connectedSearchService.searchExternal(workspaceId, agentIdentifier,
 * query)`, using the agent's OWN identifier in the `userId` slot. There is no
 * caller-suppliable "act as this human user" channel here at all -- accepting
 * one would let any agent read ANY human user's connected-account
 * credentials.
 */
export function buildSearchConnectedSourcesSkill(
  connectedSearchService: ConnectedSearchService,
): Skill<unknown, unknown> {
  return {
    manifest: signManifest(
      'search-connected-sources',
      "Searches the calling agent's own connected external sources (Notion, Drive, Gmail, Slack, GitHub).",
    ),
    execute: async (input: unknown): Promise<ConnectedSearchResponse> => {
      const context = parseSkillInput(
        z.object({ workspaceId: z.string().min(1), agentIdentifier: z.string().min(1) }).loose(),
        input,
      );
      const { query } = parseSkillInput(searchConnectedSourcesInputSchema, input);

      return connectedSearchService.searchExternal(
        context.workspaceId,
        context.agentIdentifier,
        query,
      );
    },
  };
}

export function buildListCachedCalendarEventsSkill(
  calendarEventsService: CalendarEventsService,
): Skill<unknown, unknown> {
  return {
    manifest: signManifest(
      'list-cached-calendar-events',
      'Lists previously-polled external calendar events cached for a date range.',
    ),
    execute: async (input: unknown): Promise<CachedCalendarEvent[]> => {
      const context = parseSkillInput(
        z.object({ workspaceId: z.string().min(1), agentIdentifier: z.string().min(1) }).loose(),
        input,
      );
      const range = parseSkillInput(listCalendarEventsSchema, stripAuthoritativeContext(input));

      return calendarEventsService.listCachedEvents(context.workspaceId, range);
    },
  };
}
