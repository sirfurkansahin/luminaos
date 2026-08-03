import { describe, expect, it } from 'vitest';

import { InvalidObjectStateError, ValidationError } from '@luminaos/shared';
import type { QuerySpec } from '@luminaos/shared';

import { createSavedView, deleteSavedView, updateSavedView } from './saved-view-commands.js';

import type { SavedView, ViewType } from './saved-view.js';

/**
 * F1-T9 PR1 (backend) — designed command signatures (must be matched exactly
 * by `implementer`), mirroring `relation-commands.ts`'s / `field-commands.ts`'s
 * pure-command-fn discipline (`SavedViewEventDraft[]` return shape, same
 * `{ type, payload }` draft shape as `RelationEventDraft`/`FieldEventDraft`):
 *
 *   export interface SavedViewEventDraft { type: string; payload: Record<string, unknown>; }
 *
 *   export interface CreateSavedViewInput {
 *     savedViewId: string; workspaceId: string; objectType: string; name: string;
 *     icon: string; viewType: ViewType;
 *     querySpec: Omit<QuerySpec, 'cursor' | 'limit'>;
 *     dateField?: string; startField?: string; endField?: string;
 *     ownerId: string | null;
 *   }
 *
 *   createSavedView(input: CreateSavedViewInput): SavedViewEventDraft[]
 *     -> single draft, type 'SavedViewCreated', payload carrying every field
 *        of the input (savedViewId, workspaceId, objectType, name, icon,
 *        viewType, querySpec, dateField, startField, endField, ownerId).
 *     -> throws ValidationError when `name.trim().length === 0` (empty or
 *        whitespace-only name).
 *     -> throws ValidationError when `viewType` is not one of
 *        'list'|'board'|'table'|'calendar'|'timeline'.
 *     -> throws ValidationError when `querySpec.objectType !== objectType`.
 *     -> throws ValidationError on the viewType<->field-selection invariant:
 *          - 'calendar': requires `dateField` set AND `startField`/`endField`
 *            BOTH absent.
 *          - 'timeline': requires BOTH `startField` and `endField` set AND
 *            `dateField` absent.
 *          - 'list'/'board'/'table': requires `dateField`/`startField`/
 *            `endField` ALL absent.
 *
 *   export interface UpdateSavedViewInput {
 *     name?: string; icon?: string; querySpec?: Omit<QuerySpec, 'cursor' | 'limit'>;
 *     dateField?: string; startField?: string; endField?: string;
 *   }
 *   (viewType/ownerId/objectType are NOT updatable and are not part of this
 *   input type at all.)
 *
 *   updateSavedView(state: SavedView, input: UpdateSavedViewInput): SavedViewEventDraft[]
 *     -> single draft, type 'SavedViewUpdated', payload = { savedViewId: state.id }
 *        plus ONLY the keys actually present (!== undefined) on `input` —
 *        mirrors `updateField`'s "undefined key = unchanged, omitted from
 *        payload" convention exactly.
 *     -> throws InvalidObjectStateError when `state.lifecycle === 'deleted'`.
 *     -> re-validates the viewType<->field-selection invariant against
 *        `state.viewType` whenever `dateField`/`startField`/`endField` is
 *        part of the update.
 *
 *   deleteSavedView(state: SavedView): SavedViewEventDraft[]
 *     -> single draft, type 'SavedViewDeleted', payload { savedViewId: state.id }.
 *     -> throws InvalidObjectStateError when `state.lifecycle === 'deleted'`.
 *
 * SavedViewEventDraft = { type: string; payload: Record<string, unknown> }
 * (same shape as F1-T1's ObjectEventDraft / F1-T2's FieldEventDraft / F1-T3's
 * RelationEventDraft).
 */

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const SAVED_VIEW_ID = 'saved-view-under-test';
const OWNER_ID = 'user-owner-1';

const BASE_QUERY_SPEC: Omit<QuerySpec, 'cursor' | 'limit'> = {
  objectType: 'task',
  filters: [],
};

function buildCreateInput(
  overrides: Partial<{
    savedViewId: string;
    workspaceId: string;
    objectType: string;
    name: string;
    icon: string;
    viewType: ViewType;
    querySpec: Omit<QuerySpec, 'cursor' | 'limit'>;
    dateField?: string;
    startField?: string;
    endField?: string;
    ownerId: string | null;
  }> = {},
) {
  return {
    savedViewId: SAVED_VIEW_ID,
    workspaceId: WORKSPACE_ID,
    objectType: 'task',
    name: 'Urgent this week',
    icon: 'flame',
    viewType: 'list' as ViewType,
    querySpec: BASE_QUERY_SPEC,
    ownerId: OWNER_ID,
    ...overrides,
  };
}

let savedViewCounter = 0;

function buildSavedView(overrides: Partial<SavedView> = {}): SavedView {
  savedViewCounter += 1;
  return {
    id: `existing-saved-view-${String(savedViewCounter)}`,
    workspaceId: WORKSPACE_ID,
    objectType: 'task',
    name: 'Existing view',
    icon: 'star',
    viewType: 'list',
    querySpec: BASE_QUERY_SPEC,
    ownerId: OWNER_ID,
    lifecycle: 'active',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('createSavedView', () => {
  it('returns a single SavedViewCreated draft carrying every field from the input', () => {
    const input = buildCreateInput();
    const drafts = createSavedView(input);

    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.type).toBe('SavedViewCreated');
    expect(drafts[0]?.payload).toEqual({
      savedViewId: input.savedViewId,
      workspaceId: input.workspaceId,
      objectType: input.objectType,
      name: input.name,
      icon: input.icon,
      viewType: input.viewType,
      querySpec: input.querySpec,
      ownerId: input.ownerId,
    });
  });

  it('a personal view (ownerId a real user id) round-trips ownerId in the payload', () => {
    const drafts = createSavedView(buildCreateInput({ ownerId: 'user-42' }));
    expect(drafts[0]?.payload.ownerId).toBe('user-42');
  });

  it('a shared view (ownerId: null) round-trips ownerId: null in the payload', () => {
    const drafts = createSavedView(buildCreateInput({ ownerId: null }));
    expect(drafts[0]?.payload.ownerId).toBeNull();
  });

  it('throws ValidationError when name is empty', () => {
    expect(() => createSavedView(buildCreateInput({ name: '' }))).toThrow(ValidationError);
  });

  it('throws ValidationError when name is whitespace-only', () => {
    expect(() => createSavedView(buildCreateInput({ name: '   ' }))).toThrow(ValidationError);
  });

  it('throws ValidationError for an unknown/invalid viewType', () => {
    expect(() => createSavedView(buildCreateInput({ viewType: 'bogus-view' as ViewType }))).toThrow(
      ValidationError,
    );
  });

  it('throws ValidationError when querySpec.objectType does not match the input objectType', () => {
    expect(() =>
      createSavedView(
        buildCreateInput({
          objectType: 'task',
          querySpec: { objectType: 'doc', filters: [] },
        }),
      ),
    ).toThrow(ValidationError);
  });

  describe('viewType <-> field-selection invariant', () => {
    it('accepts "calendar" with only dateField set', () => {
      expect(() =>
        createSavedView(buildCreateInput({ viewType: 'calendar', dateField: 'dueDate' })),
      ).not.toThrow();
    });

    it('rejects "calendar" with no dateField set', () => {
      expect(() => createSavedView(buildCreateInput({ viewType: 'calendar' }))).toThrow(
        ValidationError,
      );
    });

    it('rejects "calendar" when startField/endField are ALSO set alongside dateField', () => {
      expect(() =>
        createSavedView(
          buildCreateInput({
            viewType: 'calendar',
            dateField: 'dueDate',
            startField: 'startDate',
            endField: 'endDate',
          }),
        ),
      ).toThrow(ValidationError);
    });

    it('accepts "timeline" with both startField and endField set, no dateField', () => {
      expect(() =>
        createSavedView(
          buildCreateInput({ viewType: 'timeline', startField: 'startDate', endField: 'endDate' }),
        ),
      ).not.toThrow();
    });

    it('rejects "timeline" with only startField set (missing endField)', () => {
      expect(() =>
        createSavedView(buildCreateInput({ viewType: 'timeline', startField: 'startDate' })),
      ).toThrow(ValidationError);
    });

    it('rejects "timeline" with only endField set (missing startField)', () => {
      expect(() =>
        createSavedView(buildCreateInput({ viewType: 'timeline', endField: 'endDate' })),
      ).toThrow(ValidationError);
    });

    it('rejects "timeline" when dateField is ALSO set alongside startField/endField', () => {
      expect(() =>
        createSavedView(
          buildCreateInput({
            viewType: 'timeline',
            startField: 'startDate',
            endField: 'endDate',
            dateField: 'dueDate',
          }),
        ),
      ).toThrow(ValidationError);
    });

    it.each(['list', 'board', 'table'] as const)(
      'accepts "%s" with dateField/startField/endField all absent',
      (viewType) => {
        expect(() => createSavedView(buildCreateInput({ viewType }))).not.toThrow();
      },
    );

    it.each(['list', 'board', 'table'] as const)(
      'rejects "%s" when dateField is set',
      (viewType) => {
        expect(() => createSavedView(buildCreateInput({ viewType, dateField: 'dueDate' }))).toThrow(
          ValidationError,
        );
      },
    );

    it.each(['list', 'board', 'table'] as const)(
      'rejects "%s" when startField/endField are set',
      (viewType) => {
        expect(() =>
          createSavedView(
            buildCreateInput({ viewType, startField: 'startDate', endField: 'endDate' }),
          ),
        ).toThrow(ValidationError);
      },
    );
  });
});

describe('updateSavedView', () => {
  it('includes only the provided keys in the payload (undefined-means-unchanged convention)', () => {
    const state = buildSavedView();
    const drafts = updateSavedView(state, { name: 'Renamed' });

    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.type).toBe('SavedViewUpdated');
    expect(drafts[0]?.payload).toEqual({ savedViewId: state.id, name: 'Renamed' });
    // Explicitly not present: icon/querySpec/dateField/startField/endField.
    expect(Object.keys(drafts[0]?.payload ?? {})).toEqual(['savedViewId', 'name']);
  });

  it('carries every provided key at once (name, icon, querySpec)', () => {
    const state = buildSavedView();
    const newQuerySpec: Omit<QuerySpec, 'cursor' | 'limit'> = {
      objectType: 'task',
      filters: [{ field: 'priority', operator: 'equals', value: 'high' }],
    };

    const drafts = updateSavedView(state, {
      name: 'Renamed',
      icon: 'bolt',
      querySpec: newQuerySpec,
    });

    expect(drafts[0]?.payload).toEqual({
      savedViewId: state.id,
      name: 'Renamed',
      icon: 'bolt',
      querySpec: newQuerySpec,
    });
  });

  it('an empty update input produces a payload with only savedViewId', () => {
    const state = buildSavedView();
    const drafts = updateSavedView(state, {});

    expect(drafts[0]?.payload).toEqual({ savedViewId: state.id });
  });

  it('throws InvalidObjectStateError when the saved view is already deleted', () => {
    const state = buildSavedView({ lifecycle: 'deleted' });

    expect(() => updateSavedView(state, { name: 'Should not apply' })).toThrow(
      InvalidObjectStateError,
    );
  });

  describe('re-validates the viewType <-> field-selection invariant against state.viewType', () => {
    it('accepts setting dateField on a calendar view (startField/endField remain absent)', () => {
      const state = buildSavedView({ viewType: 'calendar', dateField: undefined });

      expect(() => updateSavedView(state, { dateField: 'dueDate' })).not.toThrow();
    });

    it('rejects setting startField on a calendar view (calendar must not carry startField/endField)', () => {
      const state = buildSavedView({ viewType: 'calendar', dateField: 'dueDate' });

      expect(() => updateSavedView(state, { startField: 'startDate' })).toThrow(ValidationError);
    });

    it('rejects setting dateField on a list view', () => {
      const state = buildSavedView({ viewType: 'list' });

      expect(() => updateSavedView(state, { dateField: 'dueDate' })).toThrow(ValidationError);
    });

    it('rejects setting only startField on a timeline view without endField (neither already present nor in this update)', () => {
      const state = buildSavedView({
        viewType: 'timeline',
        startField: undefined,
        endField: undefined,
      });

      expect(() => updateSavedView(state, { startField: 'startDate' })).toThrow(ValidationError);
    });

    it('does not re-validate the invariant when none of dateField/startField/endField is part of the update', () => {
      const state = buildSavedView({ viewType: 'calendar', dateField: 'dueDate' });

      expect(() => updateSavedView(state, { name: 'Renamed only' })).not.toThrow();
    });
  });
});

describe('deleteSavedView', () => {
  it('returns a single SavedViewDeleted draft with the expected payload when active', () => {
    const state = buildSavedView({ lifecycle: 'active' });
    const drafts = deleteSavedView(state);

    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.type).toBe('SavedViewDeleted');
    expect(drafts[0]?.payload).toEqual({ savedViewId: state.id });
  });

  it('throws InvalidObjectStateError when the saved view is already deleted', () => {
    const state = buildSavedView({ lifecycle: 'deleted' });

    expect(() => deleteSavedView(state)).toThrow(InvalidObjectStateError);
  });
});
