import type { FieldDefinition, LuminaObject, SavedView } from '@luminaos/core-objects';
import { AppError } from '@luminaos/shared';
import type { QuerySpec } from '@luminaos/shared';

export class ApiError extends AppError {}

/**
 * Create input for `POST /workspaces/:workspaceId/views` (mirrors
 * apps/server's `create-saved-view.schema.ts`). Deliberately has NO
 * `ownerId` key at the type level — the server always derives ownership
 * from the session (`shared: true` -> null, `shared: false` -> caller's own
 * id); the client must be structurally incapable of forwarding one (F1-T9
 * plan's security decision).
 */
export interface SavedViewCreateInput {
  name: string;
  icon: string;
  viewType: SavedView['viewType'];
  objectType: string;
  querySpec: SavedView['querySpec'];
  dateField?: string;
  startField?: string;
  endField?: string;
  shared: boolean;
}

/**
 * Update input for `PATCH /workspaces/:workspaceId/views/:savedViewId`
 * (mirrors apps/server's `update-saved-view.schema.ts`) — objectType/
 * shared/ownerId/viewType are NOT patchable.
 */
export type SavedViewUpdateInput = Partial<
  Pick<
    SavedViewCreateInput,
    'name' | 'icon' | 'querySpec' | 'dateField' | 'startField' | 'endField'
  >
>;

export interface ObjectWithFieldValues extends LuminaObject {
  fieldValues: Record<string, unknown>;
}

export type QueryResult =
  | { objects: ObjectWithFieldValues[]; nextCursor?: string }
  | { groups: { groupValue: string; count: number; items: ObjectWithFieldValues[] }[] };

interface ServerErrorBody {
  error: { code: string; message: string };
}

const HTTP_STATUS_NO_CONTENT = 204;

function isServerErrorBody(value: unknown): value is ServerErrorBody {
  if (typeof value !== 'object' || value === null || !('error' in value)) {
    return false;
  }
  const { error } = value;
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { code: unknown }).code === 'string' &&
    typeof (error as { message: unknown }).message === 'string'
  );
}

async function request<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
  });

  if (!response.ok) {
    const body: unknown = await response.json().catch(() => undefined);
    if (isServerErrorBody(body)) {
      throw new ApiError(body.error.message, body.error.code, response.status);
    }
    throw new ApiError('Beklenmeyen bir sunucu hatası oluştu', 'UNKNOWN_ERROR', response.status);
  }

  // 204 No Content (e.g. deleteSavedView) has no body to parse — calling
  // response.json() on it would reject. Every other caller of request<T>()
  // always gets a body-bearing response, so this early return never affects
  // them.
  if (response.status === HTTP_STATUS_NO_CONTENT) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

export function postObjectsQuery(workspaceId: string, querySpec: QuerySpec): Promise<QueryResult> {
  return request<QueryResult>(`/workspaces/${encodeURIComponent(workspaceId)}/objects/query`, {
    method: 'POST',
    body: JSON.stringify(querySpec),
  });
}

export function patchFieldValues(
  workspaceId: string,
  objectId: string,
  values: Record<string, unknown>,
): Promise<{ object: ObjectWithFieldValues }> {
  return request<{ object: ObjectWithFieldValues }>(
    `/workspaces/${encodeURIComponent(workspaceId)}/objects/${encodeURIComponent(objectId)}/fields`,
    {
      method: 'PATCH',
      body: JSON.stringify({ values }),
    },
  );
}

export function createObject(
  workspaceId: string,
  input: { objectType: string; title: string },
): Promise<{ object: ObjectWithFieldValues }> {
  return request<{ object: ObjectWithFieldValues }>(
    `/workspaces/${encodeURIComponent(workspaceId)}/objects`,
    {
      method: 'POST',
      body: JSON.stringify(input),
    },
  );
}

export function getSavedViews(
  workspaceId: string,
  objectType: string,
): Promise<{ savedViews: SavedView[] }> {
  return request<{ savedViews: SavedView[] }>(
    `/workspaces/${encodeURIComponent(workspaceId)}/views?objectType=${encodeURIComponent(objectType)}`,
    { method: 'GET' },
  );
}

export function createSavedView(
  workspaceId: string,
  input: SavedViewCreateInput,
): Promise<{ savedView: SavedView }> {
  return request<{ savedView: SavedView }>(`/workspaces/${encodeURIComponent(workspaceId)}/views`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function updateSavedView(
  workspaceId: string,
  savedViewId: string,
  input: SavedViewUpdateInput,
): Promise<{ savedView: SavedView }> {
  return request<{ savedView: SavedView }>(
    `/workspaces/${encodeURIComponent(workspaceId)}/views/${encodeURIComponent(savedViewId)}`,
    {
      method: 'PATCH',
      body: JSON.stringify(input),
    },
  );
}

export function getObject(
  workspaceId: string,
  objectId: string,
): Promise<{ object: ObjectWithFieldValues }> {
  return request<{ object: ObjectWithFieldValues }>(
    `/workspaces/${encodeURIComponent(workspaceId)}/objects/${encodeURIComponent(objectId)}`,
    { method: 'GET' },
  );
}

export function getFieldDefinitions(
  workspaceId: string,
  objectType: string,
): Promise<{ fieldDefinitions: FieldDefinition[] }> {
  return request<{ fieldDefinitions: FieldDefinition[] }>(
    `/workspaces/${encodeURIComponent(workspaceId)}/object-types/${encodeURIComponent(objectType)}/fields`,
    { method: 'GET' },
  );
}

export function addChecklistItem(
  workspaceId: string,
  objectId: string,
  text: string,
): Promise<{ object: ObjectWithFieldValues }> {
  return request<{ object: ObjectWithFieldValues }>(
    `/workspaces/${encodeURIComponent(workspaceId)}/objects/${encodeURIComponent(objectId)}/checklist/items`,
    {
      method: 'POST',
      body: JSON.stringify({ text }),
    },
  );
}

export function toggleChecklistItem(
  workspaceId: string,
  objectId: string,
  itemId: string,
): Promise<{ object: ObjectWithFieldValues }> {
  return request<{ object: ObjectWithFieldValues }>(
    `/workspaces/${encodeURIComponent(workspaceId)}/objects/${encodeURIComponent(objectId)}/checklist/items/${encodeURIComponent(itemId)}/toggle`,
    { method: 'POST' },
  );
}

export function removeChecklistItem(
  workspaceId: string,
  objectId: string,
  itemId: string,
): Promise<{ object: ObjectWithFieldValues }> {
  return request<{ object: ObjectWithFieldValues }>(
    `/workspaces/${encodeURIComponent(workspaceId)}/objects/${encodeURIComponent(objectId)}/checklist/items/${encodeURIComponent(itemId)}`,
    { method: 'DELETE' },
  );
}

export function reorderChecklistItem(
  workspaceId: string,
  objectId: string,
  orderedItemIds: string[],
): Promise<{ object: ObjectWithFieldValues }> {
  return request<{ object: ObjectWithFieldValues }>(
    `/workspaces/${encodeURIComponent(workspaceId)}/objects/${encodeURIComponent(objectId)}/checklist/reorder`,
    {
      method: 'POST',
      body: JSON.stringify({ orderedItemIds }),
    },
  );
}

export function deleteSavedView(workspaceId: string, savedViewId: string): Promise<void> {
  // No explicit `<void>` type argument (would trip
  // `@typescript-eslint/no-invalid-void-type` on the call-site generic) —
  // `T` is inferred as `void` from this function's own declared return type.
  return request(
    `/workspaces/${encodeURIComponent(workspaceId)}/views/${encodeURIComponent(savedViewId)}`,
    { method: 'DELETE' },
  );
}
