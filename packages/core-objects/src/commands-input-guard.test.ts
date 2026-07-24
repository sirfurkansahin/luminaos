import { describe, expect, it } from 'vitest';

import { ValidationError } from '@luminaos/shared';

import { createObject, renameObject } from './commands.js';

import type { LuminaObject } from './lumina-object.js';

/**
 * Regression tests from F1-T1 PR-A security review (Findings 1 & 3):
 * `packages/core-objects` is the last validation layer before an event is
 * persisted (PR-B's zod DTO layer does not exist yet, and even once it
 * does, this domain layer must not silently trust its caller). A
 * non-string `title` must fail with `ValidationError`, not a bare
 * `TypeError` from `title.trim()`. An unknown `objectType` must not have
 * its raw value echoed into the error MESSAGE (only into `details`), to
 * avoid unbounded/attacker-controlled content landing in plain-text logs.
 *
 * `unknown`-typed inputs below simulate a caller that has not gone through
 * TypeScript's own type checking (an unvalidated request body, a bug in a
 * future caller) — cast via `unknown`, never `any`, to keep this file
 * itself lint-clean under the repo's `no-unsafe-assignment` rule.
 */

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const OBJECT_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const ACTOR = { type: 'user', id: 'user-1' } as const;

function buildState(overrides: Partial<LuminaObject> = {}): LuminaObject {
  return {
    id: OBJECT_ID,
    type: 'task',
    workspaceId: WORKSPACE_ID,
    title: 'Original title',
    createdBy: 'user-1',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    lifecycle: 'active',
    ...overrides,
  };
}

function createObjectWithUnsafeTitle(badTitle: unknown): void {
  createObject({
    objectId: OBJECT_ID,
    workspaceId: WORKSPACE_ID,
    objectType: 'task',
    title: badTitle as string,
    actor: ACTOR,
  });
}

function renameObjectWithUnsafeTitle(badTitle: unknown): void {
  renameObject(buildState(), { title: badTitle as string });
}

const NON_STRING_TITLES: unknown[] = [null, undefined, 123, {}, [], true];

describe('createObject rejects a non-string title with ValidationError, not a TypeError', () => {
  it.each(NON_STRING_TITLES)('title = %p', (badTitle) => {
    expect(() => {
      createObjectWithUnsafeTitle(badTitle);
    }).toThrow(ValidationError);
  });
});

describe('renameObject rejects a non-string title with ValidationError, not a TypeError', () => {
  it.each(NON_STRING_TITLES)('title = %p', (badTitle) => {
    expect(() => {
      renameObjectWithUnsafeTitle(badTitle);
    }).toThrow(ValidationError);
  });
});

describe('unknown object type error does not interpolate the raw value into the message', () => {
  it('keeps the attacker-controlled objectType out of the message string', () => {
    const badObjectType = 'not-a-real-type<script>' as unknown as 'task';

    try {
      createObject({
        objectId: OBJECT_ID,
        workspaceId: WORKSPACE_ID,
        objectType: badObjectType,
        title: 'x',
        actor: ACTOR,
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).message).not.toContain('not-a-real-type');
    }
  });
});
