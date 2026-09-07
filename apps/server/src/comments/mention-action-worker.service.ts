import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import type { AgentActionResult } from '@luminaos/agent-runtime';
import { ForbiddenError, NotFoundError } from '@luminaos/shared';

import { CommentsService } from './object-comments.service.js';
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
            continue;
          }
          // Any other thrown error is treated as transient -- same retry
          // path as `outcome: 'failure'`.
          await this.retryOrFail(row.id, row.attempts, this.sanitizeError(error));
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
            await this.retryOrFail(row.id, row.attempts, this.sanitizeError(error));
            continue;
          }

          try {
            await this.markDone(row.id, reply.id);
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
          }
          continue;
        }

        if (executionResult.outcome === 'timeout') {
          await this.retryOrFail(row.id, row.attempts, TIMEOUT_LAST_ERROR);
          continue;
        }

        // `outcome: 'failure'`.
        await this.retryOrFail(
          row.id,
          row.attempts,
          this.resultErrorToString(executionResult.error),
        );
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

  private async retryOrFail(
    rowId: string,
    currentAttempts: number,
    lastError: string,
  ): Promise<void> {
    const newAttempts = currentAttempts + 1;

    if (newAttempts < MAX_ATTEMPTS) {
      const backoffMs = BACKOFF_BASE_MS * 2 ** (newAttempts - 1);
      const nextAttemptAt = new Date(Date.now() + backoffMs);
      await this.db.execute(sql`
        UPDATE mention_actions
        SET status = 'pending', attempts = ${newAttempts}, next_attempt_at = ${nextAttemptAt}, last_error = ${lastError}
        WHERE id = ${rowId}
      `);
    } else {
      await this.db.execute(sql`
        UPDATE mention_actions
        SET status = 'failed', attempts = ${newAttempts}, last_error = ${lastError}
        WHERE id = ${rowId}
      `);
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
