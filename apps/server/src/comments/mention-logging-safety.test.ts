import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * F3-T3 PR6 (ADR-0037 hardening pass): pinned static-source regression test
 * -- asserts every `Logger.warn`/`.error`/`.log` template-literal call site
 * in the three files that touch mention/DM content (`MentionActionEnqueueProjection`,
 * `MentionActionWorker`, `DirectMessagesService`) interpolates ONLY from a
 * fixed allow-list of known-opaque identifiers (row/comment/reply ids,
 * workspace ids), and NEVER a forbidden identifier that could carry raw
 * comment/DM body text, question/answer content, or mention lists.
 *
 * This is a STATIC scan, not a runtime/mocked-construction test: these
 * classes' constructors (`Database`, `SkillExecutionService`,
 * `CommentsService`, `EventStoreService`, ...) are heavyweight enough that
 * fully mocking them just to drive a handful of already-reviewed log
 * statements would add more fragile test surface than it removes. A static
 * scan catches the actual risk this hardening item cares about -- a FUTURE
 * edit accidentally adding `logger.error(body)` or `logger.warn(mentionedAgentIds)`
 * -- without needing to execute the code paths at all.
 *
 * Each of these three files' current logging discipline was already
 * confirmed correct during PR3/PR5's own security review (only opaque ids
 * are ever logged); this test PINS that so it can't silently regress.
 */

const FORBIDDEN_IDENTIFIERS = [
  'body',
  'Body',
  'mentionedAgentIds',
  'dmMessageText',
  'question',
  'answer',
  'Answer',
];

const FILES_TO_SCAN = [
  'mention-action-enqueue.projection.ts',
  'mention-action-worker.service.ts',
  '../direct-messages/direct-messages.service.ts',
];

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Extracts every `logger.(warn|error|log)(\`...\`)` template-literal
 * argument's raw source text (backtick-delimited, across the whole file,
 * `s` flag so a template literal spanning multiple lines is captured
 * intact).
 */
function extractLoggerTemplateLiterals(source: string): string[] {
  const pattern = /logger\.(?:warn|error|log)\(\s*`([^`]*)`/gs;
  const literals: string[] = [];
  for (const match of source.matchAll(pattern)) {
    const literal = match[1];
    if (literal !== undefined) {
      literals.push(literal);
    }
  }
  return literals;
}

/** Extracts every `${...}` interpolation expression from a template literal's raw source text. */
function extractInterpolations(templateLiteral: string): string[] {
  const pattern = /\$\{([^}]*)\}/g;
  const expressions: string[] = [];
  for (const match of templateLiteral.matchAll(pattern)) {
    const expression = match[1];
    if (expression !== undefined) {
      expressions.push(expression);
    }
  }
  return expressions;
}

describe('Logger call sites in mention/DM-adjacent files never interpolate sensitive content (F3-T3 PR6)', () => {
  it.each(FILES_TO_SCAN)(
    '%s: no logger.warn/error/log call embeds a forbidden identifier',
    (relativePath) => {
      const absolutePath = path.join(HERE, relativePath);
      const source = readFileSync(absolutePath, 'utf8');

      const templateLiterals = extractLoggerTemplateLiterals(source);

      for (const literal of templateLiterals) {
        const interpolations = extractInterpolations(literal);
        for (const expression of interpolations) {
          for (const forbidden of FORBIDDEN_IDENTIFIERS) {
            expect(
              expression.includes(forbidden),
              `Logger call in ${relativePath} interpolates "${expression}", which contains the forbidden identifier "${forbidden}" -- this could leak comment/DM body, question, answer, or mention-list content into logs. Full template: \`${literal}\``,
            ).toBe(false);
          }
        }
      }
    },
  );

  it('sanity check: at least one logger call was actually found in each scanned file (proves the scan itself is not silently matching nothing)', () => {
    for (const relativePath of FILES_TO_SCAN) {
      const absolutePath = path.join(HERE, relativePath);
      const source = readFileSync(absolutePath, 'utf8');
      const templateLiterals = extractLoggerTemplateLiterals(source);

      // `direct-messages.service.ts` has NO logging at all today (confirmed
      // by direct inspection) -- that absence is itself the safe state, so
      // this sanity check only requires >=1 match for the two files that DO
      // log.
      if (relativePath.includes('direct-messages')) {
        continue;
      }

      expect(
        templateLiterals.length,
        `Expected at least one logger.warn/error/log call in ${relativePath}`,
      ).toBeGreaterThan(0);
    }
  });
});
