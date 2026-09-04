import { generateKeyPairSync, randomUUID } from 'node:crypto';

import { z } from 'zod';

import type { AgentActionResult } from '@luminaos/agent-runtime';
import type { Role } from '@luminaos/core-objects';
import type { Actor } from '@luminaos/shared';
import { ValidationError } from '@luminaos/shared';
import { signSkillManifest } from '@luminaos/skill-sdk';
import type { Skill, SkillManifest } from '@luminaos/skill-sdk';

import { inviteMeetingSchema } from '../notetaker/dto/invite-meeting.schema.js';

import type {
  MeetingDetailsRow,
  MeetingMetadata,
  MeetingsService,
} from '../notetaker/meetings.service.js';
import type { ObjectWithFieldValues } from '../objects/objects.service.js';
import type {
  GenerateNextOccurrenceResult,
  TaskRecurrenceService,
} from '../recurrence/task-recurrence.service.js';

/**
 * F3-T2 PR4 (1/2), ADR-0036 — catalog #10-12 (spec table): `generate-next-
 * recurrence` (`TaskRecurrenceService.generateNextOccurrence`), `invite-
 * meeting-bot` (`MeetingsService.inviteBot`), `get-meeting-details`
 * (`MeetingsService.getMeetingDetails`). Same conventions as PR3's
 * `object-skills.ts` (fixed `CALLER_ROLE = 'member'`, `actor = {type:'agent',
 * id: agentIdentifier}`, `parseSkillInput`+zod validation, Ed25519-signed
 * manifests via `signSkillManifest`).
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
 * before `execute` runs. `inviteMeetingSchema` is `.strict()` with only
 * `meetingUrl`, so parsing the raw `input` against it always failed with
 * `unrecognized_keys` -- `invite-meeting-bot` was unreachable through its
 * real entry point. Stripping these two known, always-present context fields
 * first preserves the DTO's mass-assignment protection against any OTHER
 * unexpected field. Same fix applied in `object-skills.ts`.
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
export const MEETING_RECURRENCE_SKILLS_SIGNING_PUBLIC_KEY_PEM = publicKey.export({
  type: 'spki',
  format: 'pem',
});

const MEETING_RECURRENCE_SKILLS_SIGNING_PRIVATE_KEY_PEM = privateKey.export({
  type: 'pkcs8',
  format: 'pem',
});

function signManifest(id: string, capability: string): SkillManifest {
  const unsigned = { id, version: '1.0.0', capability };
  return {
    ...unsigned,
    signature: signSkillManifest(unsigned, MEETING_RECURRENCE_SKILLS_SIGNING_PRIVATE_KEY_PEM),
  };
}

const generateNextRecurrenceInputSchema = z
  .object({
    sourceObjectId: z.string().min(1),
    causationEventId: z.string().min(1).optional(),
    nextOccurrence: z
      .object({
        title: z.string(),
        fieldValues: z.record(z.string(), z.unknown()),
      })
      .strict(),
  })
  .loose();

export function buildGenerateNextRecurrenceSkill(
  taskRecurrenceService: TaskRecurrenceService,
): Skill<unknown, unknown> {
  return {
    manifest: signManifest(
      'generate-next-recurrence',
      'Generates the next occurrence of a recurring task and links it via a recurrenceOf relation.',
    ),
    execute: async (input: unknown): Promise<GenerateNextOccurrenceResult> => {
      const context = parseSkillInput(
        z.object({ workspaceId: z.string().min(1), agentIdentifier: z.string().min(1) }).loose(),
        input,
      );
      const body = parseSkillInput(generateNextRecurrenceInputSchema, input);

      return taskRecurrenceService.generateNextOccurrence({
        workspaceId: context.workspaceId,
        actor: actorFromAgentIdentifier(context.agentIdentifier),
        sourceObjectId: body.sourceObjectId,
        causationEventId: body.causationEventId ?? randomUUID(),
        nextOccurrence: body.nextOccurrence,
      });
    },
  };
}

/**
 * `invite-meeting-bot`/`get-meeting-details` need NO pre-fetch: their
 * `objectType` is ALWAYS, STATICALLY `'meeting'` (mirrors PR3's
 * `create-object`) -- the caller of `executeSkill` passes `'meeting'` as the
 * 5th argument directly.
 */
export function buildInviteMeetingBotSkill(
  meetingsService: MeetingsService,
): Skill<unknown, unknown> {
  return {
    manifest: signManifest(
      'invite-meeting-bot',
      'Invites a notetaker bot to a meeting URL, creating a meeting Lumina Object.',
    ),
    execute: async (
      input: unknown,
    ): Promise<{ object: ObjectWithFieldValues; meetingDetails: MeetingDetailsRow }> => {
      const context = parseSkillInput(
        z.object({ workspaceId: z.string().min(1), agentIdentifier: z.string().min(1) }).loose(),
        input,
      );
      const body = parseSkillInput(inviteMeetingSchema, stripAuthoritativeContext(input));

      return meetingsService.inviteBot(
        context.workspaceId,
        actorFromAgentIdentifier(context.agentIdentifier),
        CALLER_ROLE,
        body,
      );
    },
  };
}

/**
 * SECURITY NOTE (security-review finding, F3-T2 PR4, explicitly accepted):
 * fixed `CALLER_ROLE = 'member'` unconditionally unlocks `MeetingsService.
 * getMeetingDetails`'s `member`+-gated `transcriptText`/`pendingProposal`
 * fields for every agent that passes the coarse actionType/dataScope
 * permission-manifest check -- same posture as `object-skills.ts`'s own
 * documented `CALLER_ROLE` note, extended here to a more sensitive content
 * class (verbatim meeting transcripts, not generic custom fields). Per-agent
 * field-level visibility narrowing is a separate, not-yet-designed mechanism,
 * out of scope for this PR -- accepted as-is, same as `object-skills.ts`.
 */
export function buildGetMeetingDetailsSkill(
  meetingsService: MeetingsService,
): Skill<unknown, unknown> {
  return {
    manifest: signManifest('get-meeting-details', 'Fetches a meeting’s metadata and status by id.'),
    execute: async (input: unknown): Promise<{ meeting: MeetingMetadata }> => {
      const context = parseSkillInput(
        z
          .object({
            workspaceId: z.string().min(1),
            agentIdentifier: z.string().min(1),
            meetingId: z.string().min(1),
          })
          .loose(),
        input,
      );

      return meetingsService.getMeetingDetails(context.workspaceId, context.meetingId, CALLER_ROLE);
    },
  };
}

/**
 * Structural (not class-imported) types for `ObjectsService`/
 * `SkillExecutionService`'s own public surfaces -- avoids a value-level
 * import of the concrete Nest `@Injectable` classes here, mirroring
 * `object-skills.ts`'s own identical avoidance (see that file's
 * `callObjectIdBasedSkill` doc comment for the full rationale).
 */
interface ObjectsServiceLike {
  get(workspaceId: string, objectId: string, callerRole: string): Promise<{ type: string }>;
}

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
 * `generate-next-recurrence` IS objectId-based (its `sourceObjectId` is an
 * existing object whose real type must be resolved BEFORE the permission
 * check, per ADR-0036 Karar f) -- but its caller-supplied field is named
 * `sourceObjectId`, not `objectId`, so it is NOT compatible with PR3's
 * `callObjectIdBasedSkill` (that helper's own zod pre-check is hardcoded to
 * an `objectId` field). This is a one-off, sibling equivalent instead of
 * generalizing that already-established, already-tested helper's signature.
 *
 * SECURITY NOTE (security-review finding, F3-T2 PR4, explicitly accepted):
 * unlike `ObjectsService`'s own writes (which re-validate `objectId belongs
 * to workspaceId` at the DB layer via `lookupStreamIdAndType`),
 * `TaskRecurrenceService.generateNextOccurrence` does not itself re-check
 * that `sourceObjectId` belongs to `workspaceId` -- this pre-fetch is
 * CURRENTLY the only thing enforcing that binding. Same "zero exploitable
 * surface today" acceptance as `callObjectIdBasedSkill`'s own doc comment
 * (no HTTP route wired yet, ADR-0036 Karar h) -- revisit if/when
 * `TaskRecurrenceService` gains a real external-facing caller.
 */
export async function callGenerateNextRecurrenceSkill<TOutput>(
  objectsService: ObjectsServiceLike,
  skillExecutionService: SkillExecutionServiceLike,
  workspaceId: string,
  agentIdentifier: string,
  input: Record<string, unknown> & { sourceObjectId: string },
): Promise<AgentActionResult<TOutput>> {
  const { sourceObjectId } = parseSkillInput(
    z.object({ sourceObjectId: z.string().min(1) }).loose(),
    input,
  );
  const resolvedObject = await objectsService.get(workspaceId, sourceObjectId, CALLER_ROLE);

  return skillExecutionService.executeSkill<TOutput>(
    workspaceId,
    agentIdentifier,
    'generate-next-recurrence',
    input,
    resolvedObject.type,
  );
}
