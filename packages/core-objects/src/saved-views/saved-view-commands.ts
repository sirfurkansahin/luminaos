import { InvalidObjectStateError, ValidationError } from '@luminaos/shared';
import type { QuerySpec } from '@luminaos/shared';

import type { SavedView, SavedViewEventDraft, ViewType } from './saved-view.js';

const KNOWN_VIEW_TYPES: readonly ViewType[] = ['list', 'board', 'table', 'calendar', 'timeline'];

function isKnownViewType(viewType: string): viewType is ViewType {
  return (KNOWN_VIEW_TYPES as readonly string[]).includes(viewType);
}

/**
 * Per F1-T9 plan: `calendar` views persist only a `dateField` selection,
 * `timeline` views persist only a `startField`+`endField` pair, and
 * `list`/`board`/`table` views persist none of the three — a saved view
 * never freezes a live navigable date range, only which field(s) feed it.
 * Shared by `createSavedView` and `updateSavedView` (the latter re-validates
 * against the *effective* — merged state + update — field selection).
 */
function assertFieldSelectionInvariant(
  viewType: ViewType,
  dateField: string | undefined,
  startField: string | undefined,
  endField: string | undefined,
): void {
  if (viewType === 'calendar') {
    if (dateField === undefined || startField !== undefined || endField !== undefined) {
      throw new ValidationError(
        'calendar views require dateField to be set and startField/endField to be absent',
        { viewType, dateField, startField, endField },
      );
    }
    return;
  }

  if (viewType === 'timeline') {
    if (startField === undefined || endField === undefined || dateField !== undefined) {
      throw new ValidationError(
        'timeline views require startField and endField to be set and dateField to be absent',
        { viewType, dateField, startField, endField },
      );
    }
    return;
  }

  if (dateField !== undefined || startField !== undefined || endField !== undefined) {
    throw new ValidationError(
      'list/board/table views must not carry dateField/startField/endField',
      { viewType, dateField, startField, endField },
    );
  }
}

export interface CreateSavedViewInput {
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
}

export function createSavedView(input: CreateSavedViewInput): SavedViewEventDraft[] {
  if (input.name.trim().length === 0) {
    throw new ValidationError('saved view name must not be empty', { name: input.name });
  }

  const viewType: string = input.viewType;

  if (!isKnownViewType(viewType)) {
    throw new ValidationError('unknown view type', { viewType });
  }

  if (input.querySpec.objectType !== input.objectType) {
    throw new ValidationError("querySpec.objectType must match the saved view's objectType", {
      objectType: input.objectType,
      querySpecObjectType: input.querySpec.objectType,
    });
  }

  assertFieldSelectionInvariant(input.viewType, input.dateField, input.startField, input.endField);

  return [
    {
      type: 'SavedViewCreated',
      payload: {
        savedViewId: input.savedViewId,
        workspaceId: input.workspaceId,
        objectType: input.objectType,
        name: input.name,
        icon: input.icon,
        viewType: input.viewType,
        querySpec: input.querySpec,
        dateField: input.dateField,
        startField: input.startField,
        endField: input.endField,
        ownerId: input.ownerId,
      },
    },
  ];
}

export interface UpdateSavedViewInput {
  name?: string;
  icon?: string;
  querySpec?: Omit<QuerySpec, 'cursor' | 'limit'>;
  dateField?: string;
  startField?: string;
  endField?: string;
}

export function updateSavedView(
  state: SavedView,
  input: UpdateSavedViewInput,
): SavedViewEventDraft[] {
  if (state.lifecycle === 'deleted') {
    throw new InvalidObjectStateError('cannot update a deleted saved view', {
      savedViewId: state.id,
      lifecycle: state.lifecycle,
      attemptedAction: 'update',
    });
  }

  const touchesFieldSelection =
    input.dateField !== undefined || input.startField !== undefined || input.endField !== undefined;

  if (touchesFieldSelection) {
    const effectiveDateField = input.dateField !== undefined ? input.dateField : state.dateField;
    const effectiveStartField =
      input.startField !== undefined ? input.startField : state.startField;
    const effectiveEndField = input.endField !== undefined ? input.endField : state.endField;

    assertFieldSelectionInvariant(
      state.viewType,
      effectiveDateField,
      effectiveStartField,
      effectiveEndField,
    );
  }

  const payload: Record<string, unknown> = { savedViewId: state.id };

  if (input.name !== undefined) {
    payload.name = input.name;
  }

  if (input.icon !== undefined) {
    payload.icon = input.icon;
  }

  if (input.querySpec !== undefined) {
    payload.querySpec = input.querySpec;
  }

  if (input.dateField !== undefined) {
    payload.dateField = input.dateField;
  }

  if (input.startField !== undefined) {
    payload.startField = input.startField;
  }

  if (input.endField !== undefined) {
    payload.endField = input.endField;
  }

  return [{ type: 'SavedViewUpdated', payload }];
}

export function deleteSavedView(state: SavedView): SavedViewEventDraft[] {
  if (state.lifecycle === 'deleted') {
    throw new InvalidObjectStateError('saved view is already deleted', {
      savedViewId: state.id,
      lifecycle: state.lifecycle,
      attemptedAction: 'delete',
    });
  }

  return [{ type: 'SavedViewDeleted', payload: { savedViewId: state.id } }];
}
