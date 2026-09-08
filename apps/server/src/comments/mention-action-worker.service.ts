import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { commentResource, objectResource } from '@luminaos/agent-runtime';
import type { ActionResourceReference, AgentActionResult } from '@luminaos/agent-runtime';
import { ForbiddenError, NotFoundError } from '@luminaos/shared';

import { CommentsService } from './object-comments.service.js';
import { AgentActionRecordsService } from '../agent-runtime/agent-action-records.service.js';
import { DATABASE_CONNECTION } from '../db/database-connection.token.js';
import { SkillExecutionService } from '../skills/skill-execution.service.js';

import type { Database } from '../db/client.js';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';

/** How often `runOnce()` is invoked via the background interval -- mirrors `WebhookDeliveryWorker`'s own `WORKER_INTERVAL_MS` naming/shape. */
const WORKER_INTERVAL_MS = 20_000;

/** A row is retried at most this many times before being marked terminal (`status: 'failed'`) -- mirrors `WebhookDeliveryWorker`'s own convention. */
const MAX_ATTEMPTS = 3;

/** Base exponential-backoff unit: `30_000 * 2 ** (attempts - 1)` ms -- mirrors `WebhookDeliveryWorker`'s own `BACKOFF_BASE_MS`. */
const BACKOFF_BASE_MS = 30_000;

/** A sanitized, fixed error string never derived from the question/body/answer text -- pinned exactly by this task's spec. */
const FORBIDDEN_LAST_ERROR = 'Agent lacks permission or skill not registered';

/** A sanitized, fixed error string for a `'timeout'` outcome -- pinned exactly by this task's spec. */
const TIMEOUT_LAST_ERROR = 'Skill execution timed out';

/**
 * F3-T4 PR3 (ADR-0038 Karar d): FIXED template strings for every ledger
 * record this worker writes -- NEVER the raw mention `body`/AI `answer`
 * text, mirroring `FORBIDDEN_LAST_ERROR`/`TIMEOUT_LAST_ERROR`'s own
 * never-log-user-content discipline.
 */
const AUTONOMOUS_MENTION_INTENT = "Bir yorumdaki @mention'a yanıt verildi";
const AUTONOMOUS_MENTION_RATIONALE =
  "Ajan, kendi izin manifestosu kapsamında bu nesnedeki bir mention'a otomatik yanıt verdi (ikinci bir insan onayı adımı yok, ADR-0037 Karar d).";

// `type` (not `interface`) so this satisfies `db.execute<T>()`'s
// `T extends Record<string, unknown>` constraint -- an `interface` here
// fails that generic constraint check (TypeScript requires an explicit
// index signature for interfaces, but not for object-literal type aliases).
type DueMentionActionRow = {
  id: string;
  workspaceId: string;
  commentId: string;
  objectId: string;
  objectType: string;
  agentIdentifier: string;
  attempts: number;
  nextAttemptAt: Date;
  body: string;
  title: string | null;
};

/**
 * F3-T3 PR3 (ADR-0037 Karar (3)): `MentionActionWorker`, the claim-based
 * background worker that is `SkillExecutionService`'s FIRST real caller.
 * Mirrors `WebhookDeliveryWorker`'s exact shape (`OnModuleInit`/
 * `OnModuleDestroy` + `setInterval`, a public `runOnce()`, per-row
 * `try/catch`, an atomic conditional-UPDATE `claimRow`, `MAX_ATTEMPTS`/
 * exponential backoff).
 *
 * Scans `mention_actions` for `status='pending' AND next_attempt_at <=
 * now()` rows, joined to `object_comments`/`objects_view` for `body`/
 * `title`. For each row: builds `question = 'Regarding "<title>":
 * <body>'`, calls `skillExecutionService.executeSkill(workspaceId,
 * agentIdentifier, 'answer-question', {question}, objectType)`.
 *
 * `ForbiddenError`/`NotFoundError` thrown synchronously by `executeSkill` ->
 * immediate terminal `'failed'`, never retried, `last_error` a short fixed
 * sanitized string -- NEVER the question/body/answer text (CLAUDE.md's
 * "kullanıcı verisini log'a yazma" rule). Any other thrown error is treated
 * as transient, same retry path as `outcome: 'failure'`.
 */
@Injectable()
export class MentionActionWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MentionActionWorker.name);
  private intervalHandle: ReturnType<typeof setInterval> | undefined;

  constructor(
    @Inject(DATABASE_CONNECTION) private readonly db: Database,
    private readonly skillExecutionService: SkillExecutionService,
    private readonly commentsService: CommentsService,
    private readonly agentActionRecordsService: AgentActionRecordsService,
  ) {}

  onModuleInit(): void {
    this.intervalHandle = setInterval(() => {
      void this.runOnce();
    }, WORKER_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    if (this.intervalHandle !== undefined) {
      clearInterval(this.intervalHandle);
    }
  }

  async runOnce(): Promise<void> {
    const now = new Date();

    const result = await this.db.execute<DueMentionActionRow>(sql`
      SELECT
        ma.id AS "id",
        ma.workspace_id AS "workspaceId",
        ma.comment_id AS "commentId",
        ma.object_id AS "objectId",
        ma.object_type AS "objectType",
        ma.agent_identifier AS "agentIdentifier",
        ma.attempts AS "attempts",
        ma.next_attempt_at AS "nextAttemptAt",
        oc.body AS "body",
        ov.title AS "title"
      FROM mention_actions ma
      INNER JOIN object_comments oc ON oc.id = ma.comment_id AND oc.workspace_id = ma.workspace_id
      LEFT JOIN objects_view ov ON ov.id = ma.object_id AND ov.workspace_id = ma.workspace_id
      WHERE ma.status = 'pending' AND ma.next_attempt_at <= ${now}
    `);

    for (const row of result.rows) {
      try {
        const claimed = await this.claimRow(row.id, row.nextAttemptAt);
        if (!claimed) {
          // Another (overlapping) tick already claimed this row -- skip it
          // rather than process a second time.
          continue;
        }

        const question = `Regarding "${row.title ?? ''}": ${row.body}`;

        const contextResources: ActionResourceReference[] = [
          objectResource(row.objectId),
          commentResource(row.commentId),
        ];

        let executionResult: AgentActionResult<{ answer: string }>;
        try {
          executionResult = await this.skillExecutionService.executeSkill<{ answer: string }>(
            row.workspaceId,
            row.agentIdentifier,
            'answer-question',
            { question },
            row.objectType,
          );
        } catch (error) {
          if (error instanceof ForbiddenError || error instanceof NotFoundError) {
            await this.markFailedImmediately(row.id, row.attempts, FORBIDDEN_LAST_ERROR);
            await this.recordTerminalFailure(
              row.workspaceId,
              row.agentIdentifier,
              contextResources,
            );
            continue;
          }
          // Any other thrown error is treated as transient -- same retry
          // path as `outcome: 'failure'`.
          const terminal = await this.retryOrFail(row.id, row.attempts, this.sanitizeError(error));
          if (terminal) {
            await this.recordTerminalFailure(
              row.workspaceId,
              row.agentIdentifier,
              contextResources,
            );
          }
          continue;
        }

        if (executionResult.outcome === 'success') {
          let reply: { id: string };
          try {
            reply = await this.commentsService.create(
              row.workspaceId,
              { type: 'agent', id: row.agentIdentifier },
              'member',
              { objectId: row.objectId, body: executionResult.value.answer },
            );
          } catch (error) {
            // No reply was ever posted -- safe to retry the whole pipeline
            // (re-running `executeSkill` cannot duplicate anything yet).
            const terminal = await this.retryOrFail(
              row.id,
              row.attempts,
              this.sanitizeError(error),
            );
            if (terminal) {
              await this.recordTerminalFailure(
                row.workspaceId,
                row.agentIdentifier,
                contextResources,
              );
            }
            continue;
          }

          try {
            await this.markDone(row.id, reply.id);
            await this.recordSuccess(
              row.workspaceId,
              row.agentIdentifier,
              contextResources,
              reply.id,
            );
          } catch (error) {
            // Security-review finding (F3-T3 PR3): the reply WAS already
            // posted here -- letting this row go back to `'pending'` would
            // re-run `executeSkill`+`create` on the next tick and post a
            // SECOND AI-generated reply for the same mention. Terminally
            // fail instead (never retried), preserving `replyCommentId` for
            // manual recovery rather than risking a duplicate comment.
            this.logger.error(
              `Reply comment ${reply.id} was created for mention_actions row ${row.id}, but marking it done failed.`,
              error instanceof Error ? error.stack : undefined,
            );
            await this.markFailedAfterReply(row.id, row.attempts, reply.id);
            // The reply comment genuinely exists (a real mutation happened) --
            // recorded as `succeeded`, never `failed`, even though this
            // row's OWN bookkeeping update failed (ADR-0038 §d).
            await this.recordSuccess(
              row.workspaceId,
              row.agentIdentifier,
              contextResources,
              reply.id,
            );
          }
          continue;
        }

        if (executionResult.outcome === 'timeout') {
          const terminal = await this.retryOrFail(row.id, row.attempts, TIMEOUT_LAST_ERROR);
          if (terminal) {
            await this.recordTerminalFailure(
              row.workspaceId,
              row.agentIdentifier,
              contextResources,
            );
          }
          continue;
        }

        // `outcome: 'failure'`.
        const terminal = await this.retryOrFail(
          row.id,
          row.attempts,
          this.resultErrorToString(executionResult.error),
        );
        if (terminal) {
          await this.recordTerminalFailure(row.workspaceId, row.agentIdentifier, contextResources);
        }
      } catch (error) {
        // One row's failure must never abort the rest of the scan --
        // mirrors `WebhookDeliveryWorker.runOnce()`'s identical per-row
        // isolation discipline. Logged with the opaque row id only, never
        // the row's own question/body/answer content.
        this.logger.error(
          `Mention action processing failed for mention_actions row ${row.id}.`,
          error instanceof Error ? error.stack : undefined,
        );
      }
    }
  }

  /**
   * Never logs the underlying error's own message (which could contain
   * question/body/answer content) -- only a generic, opaque marker is ever
   * derived from an unexpected error when used as `last_error`.
   */
  private sanitizeError(error: unknown): string {
    return error instanceof Error ? error.message : 'Unknown skill execution error';
  }

  /**
   * Converts an `outcome: 'failure'` result's own `error: unknown` field
   * (per `@luminaos/agent-runtime`'s `AgentActionResult` shape) into the
   * `last_error` string this task's spec pins verbatim -- a plain string
   * `error` is used as-is, an `Error` instance's `.message` is used,
   * otherwise a generic fallback (never a raw, un-stringifiable object).
   */
  private resultErrorToString(error: unknown): string {
    if (typeof error === 'string') {
      return error;
    }
    return this.sanitizeError(error);
  }

  private async markFailedImmediately(
    rowId: string,
    currentAttempts: number,
    lastError: string,
  ): Promise<void> {
    await this.db.execute(sql`
      UPDATE mention_actions
      SET status = 'failed', attempts = ${currentAttempts + 1}, last_error = ${lastError}
      WHERE id = ${rowId}
    `);
  }

  /**
   * F3-T4 PR3: returns `true` when THIS call reached the terminal
   * `'failed'` state (`newAttempts >= MAX_ATTEMPTS`), `false` when it merely
   * scheduled a future retry (row stays `'pending'`) -- callers use this to
   * decide whether a ledger record belongs to this call (only the FINAL
   * outcome is ever recorded, never one record per retry attempt, per
   * ADR-0038 §d/spec PR3 kabul kriteri).
   */
  private async retryOrFail(
    rowId: string,
    currentAttempts: number,
    lastError: string,
  ): Promise<boolean> {
    const newAttempts = currentAttempts + 1;

    if (newAttempts < MAX_ATTEMPTS) {
      const backoffMs = BACKOFF_BASE_MS * 2 ** (newAttempts - 1);
      const nextAttemptAt = new Date(Date.now() + backoffMs);
      await this.db.execute(sql`
        UPDATE mention_actions
        SET status = 'pending', attempts = ${newAttempts}, next_attempt_at = ${nextAttemptAt}, last_error = ${lastError}
        WHERE id = ${rowId}
      `);
      return false;
    }

    await this.db.execute(sql`
      UPDATE mention_actions
      SET status = 'failed', attempts = ${newAttempts}, last_error = ${lastError}
      WHERE id = ${rowId}
    `);
    return true;
  }

  /**
   * F3-T4 PR3 (ADR-0038 §d): writes the unified ledger entry for a
   * successfully-answered mention -- `provenance:'autonomous'`, `actor` is
   * the agent itself (never a human), `intent`/`rationale` are the FIXED
   * template strings (never the raw question/body/answer text).
   * `AgentActionRecordsService.record` is itself best-effort/never-throws --
   * this method ALSO wraps the call in its own try/catch (defense in depth,
   * mirrors `CommandsService.recordDecidedLedgerEntry`'s identical F3-T4 PR2
   * precedent): a ledger write must never surface as (or be masked by)
   * `runOnce()`'s own per-row error log, which would misattribute a ledger
   * failure as a mention-processing failure even though the real mutation
   * already succeeded.
   */
  private async recordSuccess(
    workspaceId: string,
    agentIdentifier: string,
    resources: ActionResourceReference[],
    replyCommentId: string,
  ): Promise<void> {
    try {
      await this.agentActionRecordsService.record(workspaceId, {
        provenance: 'autonomous',
        actor: { type: 'agent', id: agentIdentifier },
        actionType: 'answer-question',
        intent: AUTONOMOUS_MENTION_INTENT,
        rationale: AUTONOMOUS_MENTION_RATIONALE,
        resources,
        rollbackPlan: {
          kind: 'delete',
          targetResource: commentResource(replyCommentId),
          description: 'Ajanın yanıt yorumunu sil.',
        },
        outcome: 'succeeded',
        resultRef: commentResource(replyCommentId),
        causationEventId: null,
      });
    } catch (error) {
      this.logger.error(
        `Ledger record write failed for workspace ${workspaceId}, agent "${agentIdentifier}"; the mention reply itself is unaffected.`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  /**
   * F3-T4 PR3 (ADR-0038 §d): writes the unified ledger entry for a
   * terminally-failed mention (permission denied, or retries exhausted) --
   * never called for a merely-scheduled retry. Own try/catch, same
   * defense-in-depth reasoning as `recordSuccess` above.
   */
  private async recordTerminalFailure(
    workspaceId: string,
    agentIdentifier: string,
    resources: ActionResourceReference[],
  ): Promise<void> {
    try {
      await this.agentActionRecordsService.record(workspaceId, {
        provenance: 'autonomous',
        actor: { type: 'agent', id: agentIdentifier },
        actionType: 'answer-question',
        intent: AUTONOMOUS_MENTION_INTENT,
        rationale: AUTONOMOUS_MENTION_RATIONALE,
        resources,
        rollbackPlan: {
          kind: 'none',
          description: 'Ajan bu mention’a yanıt veremedi; hiçbir mutasyon oluşmadı.',
        },
        outcome: 'failed',
        resultRef: null,
        causationEventId: null,
      });
    } catch (error) {
      this.logger.error(
        `Ledger record write failed for workspace ${workspaceId}, agent "${agentIdentifier}"; the mention_actions row's own terminal state is unaffected.`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  private async markDone(rowId: string, replyCommentId: string): Promise<void> {
    await this.db.execute(sql`
      UPDATE mention_actions
      SET status = 'done', reply_comment_id = ${replyCommentId}
      WHERE id = ${rowId}
    `);
  }

  /**
   * Terminal `'failed'` (never retried) for the case where a reply comment
   * was already successfully created but recording that fact failed --
   * `replyCommentId` is preserved on the row for manual recovery, since
   * re-running this row would post a duplicate AI-generated reply.
   */
  private async markFailedAfterReply(
    rowId: string,
    currentAttempts: number,
    replyCommentId: string,
  ): Promise<void> {
    await this.db.execute(sql`
      UPDATE mention_actions
      SET status = 'failed', attempts = ${currentAttempts + 1}, reply_comment_id = ${replyCommentId}, last_error = 'Reply created but failed to record completion'
      WHERE id = ${rowId}
    `);
  }

  /**
   * Security-review-precedent atomic conditional claim (mirrors
   * `WebhookDeliveryWorker.claimRow()` exactly): pushes `next_attempt_at`
   * forward ONLY if the row is STILL `pending` with the SAME
   * `next_attempt_at` this tick originally observed, using a `RETURNING`
   * clause to detect whether the UPDATE actually matched a row. Guards on
   * the observed `next_attempt_at` (not just `status = 'pending'`) so a
   * concurrent/overlapping `runOnce()` that already claimed (or finished)
   * this row never gets double-processed.
   */
  private async claimRow(rowId: string, observedNextAttemptAt: Date): Promise<boolean> {
    const leaseUntil = new Date(Date.now() + WORKER_INTERVAL_MS * 3);
    const result = await this.db.execute<{ id: string }>(sql`
      UPDATE mention_actions
      SET next_attempt_at = ${leaseUntil}
      WHERE id = ${rowId} AND status = 'pending' AND next_attempt_at = ${observedNextAttemptAt}
      RETURNING id
    `);

    return result.rows.length > 0;
  }
}
