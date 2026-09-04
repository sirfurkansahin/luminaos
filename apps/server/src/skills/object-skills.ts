import { generateKeyPairSync } from 'node:crypto';

import { z } from 'zod';

import type { AgentActionResult } from '@luminaos/agent-runtime';
import type { RecurrenceRule, Role } from '@luminaos/core-objects';
import type { Actor } from '@luminaos/shared';
import { ValidationError, querySpecSchema } from '@luminaos/shared';
import { signSkillManifest } from '@luminaos/skill-sdk';
import type { Skill, SkillManifest } from '@luminaos/skill-sdk';

import { addChecklistItemSchema } from '../objects/dto/add-checklist-item.schema.js';
import { createObjectSchema } from '../objects/dto/create-object.schema.js';
import { scheduleTimeblockSchema } from '../objects/dto/schedule-timeblock.schema.js';
import { setFieldValuesSchema } from '../objects/dto/set-field-values.schema.js';
import { setRecurrenceRuleSchema } from '../objects/dto/set-recurrence-rule.schema.js';

import type { ObjectsService, ObjectWithFieldValues } from '../objects/objects.service.js';

/**
 * F3-T2 PR3, ADR-0036 §(c)/(d): the first 9, real, first-party skills (spec
 * table #1-9) -- each a thin wrapper around one already-implemented,
 * already-tested `ObjectsService` method. No new business logic is invented
 * here (per the task's 3rd binding human decision).
 *
 * Every skill's `execute` receives `input` already carrying the AUTHORITATIVE
 * `workspaceId`/`agentIdentifier` -- injected by `SkillExecutionService.
 * executeSkill` right before `execute` is ever called (see that file's own
 * doc comment) -- plus whatever skill-specific fields the caller supplied.
 *
 * VALIDATION (security-review finding, F3-T2 PR3): every skill-specific field
 * is validated with the SAME zod schema its HTTP-facing DTO counterpart
 * already uses (`../objects/dto/*.schema.ts`) before it ever reaches
 * `ObjectsService` -- reused, not re-invented, so the skill path is held to
 * the identical shape contract as the existing controller path. `objectId`/
 * `itemId`/`fieldKey` (no existing DTO, since those are normally URL params)
 * get a small local non-empty-string schema.
 *
 * Actor convention for ALL 9 skills: `{type: 'agent', id: agentIdentifier}`.
 * `CALLER_ROLE` (fixed `'member'`) only satisfies `ObjectsService`'s own
 * technical role parameter -- the REAL authorization is the agent permission
 * manifest, already checked by `executeSkill` before `execute` ever runs.
 * (Security-review note, accepted as-is: this means every agent sees
 * member-level field visibility regardless of its manifest's own scope --
 * dataScope narrows WHICH objects/actions an agent may touch, not per-field
 * visibility within an authorized object; narrowing field-level visibility to
 * an agent's own scope is a separate, not-yet-designed mechanism, out of
 * scope for this PR.)
 */
const CALLER_ROLE: Role = 'member';

function actorFromAgentIdentifier(agentIdentifier: string): Actor {
  return { type: 'agent', id: agentIdentifier };
}

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
 * before `execute` runs (see that file's own doc comment). Every `.strict()`
 * HTTP-facing DTO schema reused below (`createObjectSchema`,
 * `setFieldValuesSchema`, etc.) declares ONLY its own body fields, so parsing
 * the raw `input` against it directly always fails with `unrecognized_keys`
 * for those two injected fields -- every skill below that did this was
 * unreachable through its real `executeSkill` entry point. Stripping exactly
 * these two known, always-present context fields before the strict body
 * parse preserves the DTO's mass-assignment protection against any OTHER
 * unexpected field while allowing the two fields that legitimately coexist.
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

// BUG FIX (discovered via ci/wire-integration-tests): `.strict()` rejected
// ANY extra field beyond `objectId` -- but `callObjectIdBasedSkill` is a
// shared helper for skills whose own body carries additional fields (e.g.
// add-checklist-item's `text`), which this pre-check must not reject; each
// skill's OWN `execute` validates its own fields separately. This bug was
// masked until now: `object-skills.integration.test.ts`'s `beforeAll` threw
// `ConflictError` (a separate, now-fixed bug), skipping every `it` in the
// file before any of them could ever exercise this code path.
const objectIdSchema = z.object({ objectId: z.string().min(1) }).loose();

/**
 * A fresh Ed25519 keypair generated once, at this module's own load time --
 * see this file's `SkillsModule` wiring caller for why this is a KNOWN,
 * TEMPORARY gap (no private key matching the checked-in canonical
 * `SKILL_SDK_PUBLIC_KEY_PEM` exists anywhere in this repo, per that
 * constant's own doc comment).
 */
const { privateKey, publicKey } = generateKeyPairSync('ed25519');

/** The public half of the module-scope signing keypair above -- exported so `SkillsModule` can register these 9 skills against the key they were ACTUALLY signed with. */
export const OBJECT_SKILLS_SIGNING_PUBLIC_KEY_PEM = publicKey.export({
  type: 'spki',
  format: 'pem',
});

const OBJECT_SKILLS_SIGNING_PRIVATE_KEY_PEM = privateKey.export({
  type: 'pkcs8',
  format: 'pem',
});

function signManifest(id: string, capability: string): SkillManifest {
  const unsigned = { id, version: '1.0.0', capability };
  return {
    ...unsigned,
    signature: signSkillManifest(unsigned, OBJECT_SKILLS_SIGNING_PRIVATE_KEY_PEM),
  };
}

export function buildCreateObjectSkill(objectsService: ObjectsService): Skill<unknown, unknown> {
  return {
    manifest: signManifest(
      'create-object',
      'Creates a new Lumina Object of a given type with a title.',
    ),
    execute: async (input: unknown): Promise<ObjectWithFieldValues> => {
      const context = parseSkillInput(
        z.object({ workspaceId: z.string().min(1), agentIdentifier: z.string().min(1) }),
        input,
      );
      const body = parseSkillInput(createObjectSchema, stripAuthoritativeContext(input));

      return objectsService.create(
        context.workspaceId,
        actorFromAgentIdentifier(context.agentIdentifier),
        body,
        CALLER_ROLE,
      );
    },
  };
}

/**
 * SECURITY NOTE (2nd-pass review finding, F3-T2 PR3): `get-object` does NOT
 * reuse `callObjectIdBasedSkill`'s own pre-fetch (which exists solely to
 * resolve the object's type for the permission check) -- `execute` cannot
 * distinguish a value that helper genuinely fetched from one a DIRECT caller
 * of `executeSkill` simply fabricated in `input` (an `.id === objectId`
 * check is not provenance: an attacker who controls `input` controls BOTH
 * fields and can make them match trivially). There is no unforgeable channel
 * for `execute` to receive a "trusted" pre-fetched value, so this skill just
 * re-fetches itself -- one extra, cheap, indexed primary-key read, not a
 * meaningful cost, in exchange for a real (not merely cosmetic) guarantee
 * that what `get-object` returns is always independently re-verified.
 */
export function buildGetObjectSkill(objectsService: ObjectsService): Skill<unknown, unknown> {
  return {
    manifest: signManifest('get-object', 'Fetches a single Lumina Object by id.'),
    execute: async (input: unknown): Promise<ObjectWithFieldValues> => {
      const context = parseSkillInput(
        z
          .object({
            workspaceId: z.string().min(1),
            agentIdentifier: z.string().min(1),
            objectId: z.string().min(1),
          })
          .loose(),
        input,
      );

      return objectsService.get(context.workspaceId, context.objectId, CALLER_ROLE);
    },
  };
}

export function buildQueryObjectsSkill(objectsService: ObjectsService): Skill<unknown, unknown> {
  return {
    manifest: signManifest(
      'query-objects',
      'Queries Lumina Objects with filters, sort and grouping.',
    ),
    execute: async (input: unknown) => {
      const context = parseSkillInput(
        z.object({ workspaceId: z.string().min(1), agentIdentifier: z.string().min(1) }),
        input,
      );
      const { querySpec } = parseSkillInput(
        z.object({ querySpec: querySpecSchema }).strict(),
        stripAuthoritativeContext(input),
      );

      return objectsService.query(context.workspaceId, CALLER_ROLE, querySpec);
    },
  };
}

export function buildSetFieldValuesSkill(objectsService: ObjectsService): Skill<unknown, unknown> {
  return {
    manifest: signManifest(
      'set-field-values',
      'Sets one or more custom field values on a Lumina Object.',
    ),
    execute: async (input: unknown): Promise<ObjectWithFieldValues> => {
      const context = parseSkillInput(
        z
          .object({
            workspaceId: z.string().min(1),
            agentIdentifier: z.string().min(1),
            objectId: z.string().min(1),
          })
          .loose(),
        input,
      );
      const body = parseSkillInput(setFieldValuesSchema, stripAuthoritativeContext(input));
      const entries = Object.entries(body.values).map(([fieldKey, value]) => ({
        fieldKey,
        value,
      }));

      return objectsService.setFieldValues(
        context.workspaceId,
        context.objectId,
        actorFromAgentIdentifier(context.agentIdentifier),
        CALLER_ROLE,
        entries,
      );
    },
  };
}

export function buildAddChecklistItemSkill(
  objectsService: ObjectsService,
): Skill<unknown, unknown> {
  return {
    manifest: signManifest('add-checklist-item', 'Adds a checklist item to a Lumina Object.'),
    execute: async (input: unknown): Promise<ObjectWithFieldValues> => {
      const context = parseSkillInput(
        z
          .object({
            workspaceId: z.string().min(1),
            agentIdentifier: z.string().min(1),
            objectId: z.string().min(1),
          })
          .loose(),
        input,
      );
      const body = parseSkillInput(addChecklistItemSchema, stripAuthoritativeContext(input));

      return objectsService.addChecklistItem(
        context.workspaceId,
        context.objectId,
        actorFromAgentIdentifier(context.agentIdentifier),
        CALLER_ROLE,
        body,
      );
    },
  };
}

export function buildToggleChecklistItemSkill(
  objectsService: ObjectsService,
): Skill<unknown, unknown> {
  return {
    manifest: signManifest(
      'toggle-checklist-item',
      'Toggles a checklist item done/not-done on a Lumina Object.',
    ),
    execute: async (input: unknown): Promise<ObjectWithFieldValues> => {
      const context = parseSkillInput(
        z
          .object({
            workspaceId: z.string().min(1),
            agentIdentifier: z.string().min(1),
            objectId: z.string().min(1),
            itemId: z.string().min(1),
          })
          .loose(),
        input,
      );

      return objectsService.toggleChecklistItem(
        context.workspaceId,
        context.objectId,
        actorFromAgentIdentifier(context.agentIdentifier),
        CALLER_ROLE,
        context.itemId,
      );
    },
  };
}

export function buildScheduleTimeBlockSkill(
  objectsService: ObjectsService,
): Skill<unknown, unknown> {
  return {
    manifest: signManifest(
      'schedule-time-block',
      'Schedules a start/end time block on a Lumina Object.',
    ),
    execute: async (input: unknown): Promise<ObjectWithFieldValues> => {
      const context = parseSkillInput(
        z
          .object({
            workspaceId: z.string().min(1),
            agentIdentifier: z.string().min(1),
            objectId: z.string().min(1),
          })
          .loose(),
        input,
      );
      const body = parseSkillInput(scheduleTimeblockSchema, stripAuthoritativeContext(input));

      return objectsService.scheduleTimeBlock(
        context.workspaceId,
        context.objectId,
        actorFromAgentIdentifier(context.agentIdentifier),
        CALLER_ROLE,
        body,
      );
    },
  };
}

export function buildRefreshAIFieldSkill(objectsService: ObjectsService): Skill<unknown, unknown> {
  return {
    manifest: signManifest(
      'refresh-ai-field',
      "Re-runs an ai-typed field's prompt and stores its refreshed value.",
    ),
    execute: async (input: unknown): Promise<ObjectWithFieldValues> => {
      const context = parseSkillInput(
        z
          .object({
            workspaceId: z.string().min(1),
            agentIdentifier: z.string().min(1),
            objectId: z.string().min(1),
            fieldKey: z.string().min(1),
          })
          .loose(),
        input,
      );

      return objectsService.refreshAIField(
        context.workspaceId,
        context.objectId,
        context.fieldKey,
        actorFromAgentIdentifier(context.agentIdentifier),
        CALLER_ROLE,
      );
    },
  };
}

export function buildSetRecurrenceRuleSkill(
  objectsService: ObjectsService,
): Skill<unknown, unknown> {
  return {
    manifest: signManifest('set-recurrence-rule', 'Sets a recurrence rule on a Lumina Object.'),
    execute: async (input: unknown): Promise<ObjectWithFieldValues> => {
      const context = parseSkillInput(
        z
          .object({
            workspaceId: z.string().min(1),
            agentIdentifier: z.string().min(1),
            objectId: z.string().min(1),
          })
          .loose(),
        input,
      );
      const body = parseSkillInput(setRecurrenceRuleSchema, stripAuthoritativeContext(input));
      // `exactOptionalPropertyTypes` -- built conditionally, mirroring
      // `objects.controller.ts`'s own `setRecurrenceRule` handler, rather
      // than spreading `body` as-is (zod's `.optional()` types its output as
      // `T | undefined`, not the plain-optional `T?` shape `RecurrenceRule`
      // itself declares).
      const rule: RecurrenceRule = {
        frequency: body.frequency,
        interval: body.interval,
        ...(body.byWeekday !== undefined ? { byWeekday: body.byWeekday } : {}),
        ...(body.endDate !== undefined ? { endDate: body.endDate } : {}),
      };

      return objectsService.setRecurrenceRule(
        context.workspaceId,
        context.objectId,
        actorFromAgentIdentifier(context.agentIdentifier),
        CALLER_ROLE,
        rule,
      );
    },
  };
}

/**
 * Structural (not class-imported) type for `SkillExecutionService`'s own
 * public surface -- avoids a value-level import of the concrete Nest
 * `@Injectable` class here (this file is imported by `SkillsModule` itself,
 * which also constructs `SkillExecutionService`; keeping this a structural
 * type sidesteps any risk of a circular module graph, mirroring this file's
 * own integration test's identical `SkillExecutionServiceLike` avoidance).
 */
interface SkillExecutionServiceLike {
  executeSkill<TOutput>(
    workspaceId: string,
    agentIdentifier: string,
    skillId: string,
    input: Record<string, unknown>,
    objectType?: string,
  ): Promise<AgentActionResult<TOutput>>;
}

/**
 * The generic caller-side helper for every objectId-based skill (2, 4-9):
 * resolves the target object's REAL type via a pre-fetch (needed so
 * `executeSkill`'s `dataScope.objectTypes` permission check can narrow on
 * the object's ACTUAL type, never a type the caller merely asserts), then
 * runs the skill through `executeSkill` with that resolved type -- per
 * ADR-0036 Karar (f), the permission check must run BEFORE `skill.execute`.
 *
 * KNOWN, ACCEPTED GAP (security-review finding, F3-T2 PR3): this pre-fetch
 * runs BEFORE `executeSkill`'s permission check and OUTSIDE
 * `AgentResourceLimitsService.executeAgentAction`'s rate-limit/concurrency
 * gate -- an agent with NO manifest at all (or one that denies this specific
 * skill) can still cause one indexed, primary-key `objectsService.get` read
 * per call. This does not leak object CONTENT to an unauthorized caller (the
 * fetched object is discarded, never returned, unless the subsequent
 * permission check passes) and there is today no HTTP/external caller of
 * this function at all (ADR-0036 Karar h -- no route wired yet, F3-T3 will
 * be the first real caller) -- so the current exploitable surface is zero.
 * Revisit (a cheap pre-check that the agent has ANY active manifest at all,
 * before paying for the object fetch) when F3-T3 adds a real external-facing
 * caller with its own request-level rate limiting.
 */
export async function callObjectIdBasedSkill<TOutput>(
  objectsService: ObjectsService,
  skillExecutionService: SkillExecutionServiceLike,
  workspaceId: string,
  agentIdentifier: string,
  skillId: string,
  input: Record<string, unknown> & { objectId: string },
): Promise<AgentActionResult<TOutput>> {
  const { objectId } = parseSkillInput(objectIdSchema, input);
  const resolvedObject = await objectsService.get(workspaceId, objectId, CALLER_ROLE);

  // `resolvedObject` itself is used ONLY to resolve `objectType` for the
  // permission check below -- it is deliberately NOT threaded into `input`
  // (an earlier version tried that, as a `get-object`-only fetch-avoidance
  // optimization; removed, see `buildGetObjectSkill`'s own doc comment for
  // why no caller-suppliable value can safely stand in for a real fetch).
  return skillExecutionService.executeSkill<TOutput>(
    workspaceId,
    agentIdentifier,
    skillId,
    input,
    resolvedObject.type,
  );
}
