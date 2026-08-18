import type {
  FieldDefinition,
  LuminaObject,
  RecurrenceRule,
  SavedView,
} from '@luminaos/core-objects';
import type { MemoryRecord, MemoryRecordJsonLd } from '@luminaos/memory';
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

// `recurrenceRule` is re-declared here (rather than inherited as-is from
// `LuminaObject`, which types it as a plain optional `recurrenceRule?:
// RecurrenceRule`) to explicitly include `| undefined` — under this repo's
// `exactOptionalPropertyTypes`, a plain optional property rejects an EXPLICIT
// `undefined` assignment (only omitting the key entirely is allowed), which
// TaskDetailPanel.test.tsx's own `mockOpenPanelWithRecurrenceAndReminder({
// recurrenceRule: undefined })` override relies on to simulate "object loaded,
// no recurrence rule set".
export interface ObjectWithFieldValues extends Omit<LuminaObject, 'recurrenceRule'> {
  fieldValues: Record<string, unknown>;
  recurrenceRule?: RecurrenceRule | undefined;
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

export function setRecurrenceRule(
  workspaceId: string,
  objectId: string,
  rule: RecurrenceRule,
): Promise<{ object: ObjectWithFieldValues }> {
  return request<{ object: ObjectWithFieldValues }>(
    `/workspaces/${encodeURIComponent(workspaceId)}/objects/${encodeURIComponent(objectId)}/recurrence-rule`,
    {
      method: 'POST',
      body: JSON.stringify(rule),
    },
  );
}

export function clearRecurrenceRule(
  workspaceId: string,
  objectId: string,
): Promise<{ object: ObjectWithFieldValues }> {
  return request<{ object: ObjectWithFieldValues }>(
    `/workspaces/${encodeURIComponent(workspaceId)}/objects/${encodeURIComponent(objectId)}/recurrence-rule`,
    { method: 'DELETE' },
  );
}

// F1-T12 PR8a — read-only external-calendar sync (ADR-0012 §a/§b): external
// events and conflict pairs are surfaced for display only, never mutated
// from LuminaOS.
export interface ExternalCalendarEvent {
  externalId: string;
  title: string;
  start: string;
  end: string;
}

export interface ConflictInterval {
  kind: 'timeblock' | 'external';
  id: string;
  title: string;
  start: string;
  end: string;
}

export interface ConflictPair {
  a: ConflictInterval;
  b: ConflictInterval;
}

export async function listExternalCalendarEvents(
  workspaceId: string,
  range: { start: string; end: string },
): Promise<ExternalCalendarEvent[]> {
  const params = new URLSearchParams({ start: range.start, end: range.end });
  const { events } = await request<{ events: ExternalCalendarEvent[] }>(
    `/workspaces/${encodeURIComponent(workspaceId)}/calendar/events?${params.toString()}`,
    { method: 'GET' },
  );
  return events;
}

export async function listCalendarConflicts(
  workspaceId: string,
  range: { start: string; end: string },
): Promise<ConflictPair[]> {
  const params = new URLSearchParams({ start: range.start, end: range.end });
  const { conflicts } = await request<{ conflicts: ConflictPair[] }>(
    `/workspaces/${encodeURIComponent(workspaceId)}/calendar/conflicts?${params.toString()}`,
    { method: 'GET' },
  );
  return conflicts;
}

// F1-T12 PR8b — click-day-to-create-timeblock modal + header Odak/OOO
// selector (ADR-0012 companion). `scheduleTimeBlock`/`clearTimeBlockSchedule`
// set/clear a timeblock object's start/end window; `getAvailability`/
// `setAvailability` read/write the workspace-wide "current status" snapshot
// surfaced in the header.
export interface TimeBlockSchedule {
  start: string;
  end: string;
}

export function scheduleTimeBlock(
  workspaceId: string,
  objectId: string,
  schedule: TimeBlockSchedule,
): Promise<{ object: ObjectWithFieldValues }> {
  return request<{ object: ObjectWithFieldValues }>(
    `/workspaces/${encodeURIComponent(workspaceId)}/objects/${encodeURIComponent(objectId)}/timeblock`,
    {
      method: 'POST',
      body: JSON.stringify(schedule),
    },
  );
}

export function clearTimeBlockSchedule(
  workspaceId: string,
  objectId: string,
): Promise<{ object: ObjectWithFieldValues }> {
  return request<{ object: ObjectWithFieldValues }>(
    `/workspaces/${encodeURIComponent(workspaceId)}/objects/${encodeURIComponent(objectId)}/timeblock`,
    { method: 'DELETE' },
  );
}

export type AvailabilityStatus = 'available' | 'focus' | 'ooo';

export interface AvailabilitySnapshot {
  status: AvailabilityStatus;
  until?: string;
  updatedAt: string;
}

export async function getAvailability(workspaceId: string): Promise<AvailabilitySnapshot | null> {
  const { availability } = await request<{ availability: AvailabilitySnapshot | null }>(
    `/workspaces/${encodeURIComponent(workspaceId)}/availability`,
    { method: 'GET' },
  );
  return availability;
}

export async function setAvailability(
  workspaceId: string,
  status: AvailabilityStatus,
  until?: string,
): Promise<AvailabilitySnapshot> {
  const { availability } = await request<{ availability: AvailabilitySnapshot }>(
    `/workspaces/${encodeURIComponent(workspaceId)}/availability`,
    {
      method: 'PUT',
      body: JSON.stringify({ status, ...(until !== undefined ? { until } : {}) }),
    },
  );
  return availability;
}

export interface SearchResult {
  objectId: string;
  title: string;
  type: string;
  score: number;
}

export function searchWorkspace(
  workspaceId: string,
  query: string,
  limit?: number,
): Promise<{ results: SearchResult[] }> {
  return request<{ results: SearchResult[] }>(
    `/workspaces/${encodeURIComponent(workspaceId)}/search`,
    {
      method: 'POST',
      body: JSON.stringify({ query, ...(limit !== undefined ? { limit } : {}) }),
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

// F2-T6 — Memory Passport CRUD client (apps/server's F2-T5
// memory.controller.ts). Mirrors the getSavedViews/createSavedView/
// updateSavedView/deleteSavedView precedent above, including the
// 204-no-content handling for delete.
export interface MemoryRecordCreateInput {
  content: string;
}

export type MemoryRecordUpdateInput = MemoryRecordCreateInput;

export function getMemoryRecords(workspaceId: string): Promise<{ records: MemoryRecord[] }> {
  return request<{ records: MemoryRecord[] }>(
    `/workspaces/${encodeURIComponent(workspaceId)}/memory`,
    { method: 'GET' },
  );
}

export function getMemoryRecordsJsonLdExport(
  workspaceId: string,
): Promise<{ records: MemoryRecordJsonLd[] }> {
  return request<{ records: MemoryRecordJsonLd[] }>(
    `/workspaces/${encodeURIComponent(workspaceId)}/memory/export?format=json-ld`,
    { method: 'GET' },
  );
}

export function createMemoryRecord(
  workspaceId: string,
  input: MemoryRecordCreateInput,
): Promise<{ record: MemoryRecord }> {
  return request<{ record: MemoryRecord }>(
    `/workspaces/${encodeURIComponent(workspaceId)}/memory`,
    {
      method: 'POST',
      body: JSON.stringify(input),
    },
  );
}

export function updateMemoryRecord(
  workspaceId: string,
  recordId: string,
  input: MemoryRecordUpdateInput,
): Promise<{ record: MemoryRecord }> {
  return request<{ record: MemoryRecord }>(
    `/workspaces/${encodeURIComponent(workspaceId)}/memory/${encodeURIComponent(recordId)}`,
    {
      method: 'PATCH',
      body: JSON.stringify(input),
    },
  );
}

export function deleteMemoryRecord(workspaceId: string, recordId: string): Promise<void> {
  // No explicit `<void>` type argument, matching deleteSavedView's rationale
  // above.
  return request(
    `/workspaces/${encodeURIComponent(workspaceId)}/memory/${encodeURIComponent(recordId)}`,
    { method: 'DELETE' },
  );
}
