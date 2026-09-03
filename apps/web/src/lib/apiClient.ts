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

// F2-T11 (ADR-0027 §f) — connected search: a "Dış Kaynaklar" (external
// sources) block in the command palette, fed from the workspace's connected
// integrations. `degraded` lists connectorTypes that failed/timed out and
// were excluded from `results` rather than failing the whole request.
export interface ExternalSearchResult {
  connectorType: string;
  title: string;
  snippet: string;
}

export interface ConnectedSearchResponse {
  results: ExternalSearchResult[];
  degraded: string[];
}

export function searchExternalWorkspace(
  workspaceId: string,
  query: string,
): Promise<ConnectedSearchResponse> {
  return request<ConnectedSearchResponse>(
    `/workspaces/${encodeURIComponent(workspaceId)}/search/external`,
    {
      method: 'POST',
      body: JSON.stringify({ query }),
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

/** F2-T10 PR1 (ADR-0026 §c/§n) -- one entry per connectorType this deployment
 * knows an OAuth provider config for, `connected` = whether the caller
 * (workspaceId, userId) has stored credentials for it. */
export interface IntegrationConnectorStatus {
  connectorType: string;
  connected: boolean;
}

export function getIntegrations(
  workspaceId: string,
): Promise<{ connectors: IntegrationConnectorStatus[] }> {
  return request<{ connectors: IntegrationConnectorStatus[] }>(
    `/workspaces/${encodeURIComponent(workspaceId)}/integrations`,
    { method: 'GET' },
  );
}

/** Starts the OAuth authorize flow for `connectorType` -- the caller is
 * expected to navigate the browser to the returned `authorizeUrl`. */
export function connectIntegration(
  workspaceId: string,
  connectorType: string,
): Promise<{ authorizeUrl: string }> {
  return request<{ authorizeUrl: string }>(
    `/workspaces/${encodeURIComponent(workspaceId)}/integrations/${encodeURIComponent(connectorType)}/oauth/authorize`,
    { method: 'POST' },
  );
}

export function disconnectIntegration(workspaceId: string, connectorType: string): Promise<void> {
  // No explicit `<void>` type argument, matching deleteMemoryRecord's/
  // deleteSavedView's rationale above.
  return request(
    `/workspaces/${encodeURIComponent(workspaceId)}/integrations/${encodeURIComponent(connectorType)}`,
    { method: 'DELETE' },
  );
}

/**
 * F2-T12 PR2 (ADR-0028 §k/§l) -- MCP client access-token grants. Only the
 * user-facing fields are surfaced here (`id`/`name`/`tokenPrefix`/
 * `createdAt`/`expiresAt`/`revokedAt`) -- `tokenHash`/`workspaceId`/`userId`
 * are deliberately omitted from this type even though the raw server
 * response includes them, so nothing in the frontend can accidentally render
 * them.
 */
export interface McpClientGrant {
  id: string;
  name: string;
  tokenPrefix: string;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
}

export interface CreateMcpClientGrantResult {
  grant: McpClientGrant;
  rawToken: string;
}

export function listMcpGrants(workspaceId: string): Promise<{ grants: McpClientGrant[] }> {
  return request<{ grants: McpClientGrant[] }>(
    `/workspaces/${encodeURIComponent(workspaceId)}/mcp/grants`,
    { method: 'GET' },
  );
}

export function createMcpGrant(
  workspaceId: string,
  name: string,
  expiresAtDays: 30 | 90 | 365,
): Promise<CreateMcpClientGrantResult> {
  return request<CreateMcpClientGrantResult>(
    `/workspaces/${encodeURIComponent(workspaceId)}/mcp/grants`,
    {
      method: 'POST',
      body: JSON.stringify({ name, expiresAtDays }),
    },
  );
}

export function revokeMcpGrant(workspaceId: string, grantId: string): Promise<void> {
  // No explicit `<void>` type argument, matching disconnectIntegration's/
  // deleteMemoryRecord's rationale above.
  return request(
    `/workspaces/${encodeURIComponent(workspaceId)}/mcp/grants/${encodeURIComponent(grantId)}`,
    { method: 'DELETE' },
  );
}

/**
 * F2-T13 PR5 (ADR-0030 §e/§h/§i) -- ad hoc "invite a notetaker bot" flow.
 * Mirrors `apps/server`'s `MeetingInviteController.invite` response shape
 * exactly (`meetingUrl` is the ONLY input -- the provider is auto-detected
 * server-side from the URL, Karar i -- the client never declares one).
 */
export interface InviteMeetingBotResult {
  object: { id: string; objectType: string; title: string };
  meetingDetails: {
    id: string;
    objectId: string;
    meetingUrl: string;
    provider: string;
    status: string;
    providerMeetingRef: string;
    providerRecordingUrl: string | null;
    transcriptText?: string | null;
    createdAt: string;
  };
}

export function inviteMeetingBot(
  workspaceId: string,
  meetingUrl: string,
): Promise<InviteMeetingBotResult> {
  return request<InviteMeetingBotResult>(
    `/workspaces/${encodeURIComponent(workspaceId)}/meetings`,
    {
      method: 'POST',
      body: JSON.stringify({ meetingUrl }),
    },
  );
}

/**
 * F2-T16 PR4 (ADR-0033 §g) -- reusable webhook subscriptions CRUD client.
 * Mirrors `listMcpGrants`/`createMcpGrant`/`revokeMcpGrant`'s exact
 * request-shape convention. `signingSecret` is present ONLY on
 * `CreatedWebhookSubscription` (the create response) -- never on the plain
 * `WebhookSubscription` shape returned by `list`, so the list view is
 * structurally incapable of rendering it.
 */
export interface WebhookSubscription {
  id: string;
  targetUrl: string;
  eventTypes: string[];
  createdAt: string;
}

export interface CreatedWebhookSubscription extends WebhookSubscription {
  signingSecret: string;
}

export function listWebhookSubscriptions(
  workspaceId: string,
): Promise<{ subscriptions: WebhookSubscription[] }> {
  return request<{ subscriptions: WebhookSubscription[] }>(
    `/workspaces/${encodeURIComponent(workspaceId)}/webhooks`,
    { method: 'GET' },
  );
}

export function createWebhookSubscription(
  workspaceId: string,
  input: { targetUrl: string; eventTypes: string[] },
): Promise<{ subscription: CreatedWebhookSubscription }> {
  return request<{ subscription: CreatedWebhookSubscription }>(
    `/workspaces/${encodeURIComponent(workspaceId)}/webhooks`,
    {
      method: 'POST',
      body: JSON.stringify(input),
    },
  );
}

export function deleteWebhookSubscription(
  workspaceId: string,
  subscriptionId: string,
): Promise<void> {
  // No explicit `<void>` type argument, matching deleteMemoryRecord's/
  // disconnectIntegration's rationale above.
  return request(
    `/workspaces/${encodeURIComponent(workspaceId)}/webhooks/${encodeURIComponent(subscriptionId)}`,
    { method: 'DELETE' },
  );
}

/**
 * F2-T16 PR4 (ADR-0033 §g/§h) -- command-proposal read/decide client, feeding
 * `AutomationHistoryPanel`. Mirrors the already-merged server-side
 * `CommandProposalSummary`/`DecideActionResult` shapes exactly
 * (`apps/server/src/commands/commands.service.ts`).
 */
export interface ProposedActionSummary {
  actionId: string;
  type: string;
  intent: string;
  rationale: string;
  resources: string[];
  rollbackNote: string;
  params: Record<string, unknown>;
}

export interface DecideActionResult {
  actionId: string;
  status: 'executed' | 'rejected' | 'failed' | 'partially_executed';
  createdCount?: number;
  totalCount?: number;
  failedAtStep?: number;
  error?: string;
}

export interface CommandProposalSummary {
  id: string;
  workspaceId: string;
  command: string;
  sourceObjectId: string | null;
  actions: ProposedActionSummary[];
  decisions: DecideActionResult[] | null;
  createdAt: string;
  decidedAt: string | null;
}

export function listProposals(
  workspaceId: string,
  filter?: { pendingOnly?: boolean; limit?: number; cursor?: string },
): Promise<{ proposals: CommandProposalSummary[]; nextCursor?: string }> {
  const params = new URLSearchParams();
  if (filter?.pendingOnly !== undefined) {
    params.set('pendingOnly', String(filter.pendingOnly));
  }
  if (filter?.limit !== undefined) {
    params.set('limit', String(filter.limit));
  }
  if (filter?.cursor !== undefined) {
    params.set('cursor', filter.cursor);
  }
  const queryString = params.toString();
  const suffix = queryString.length > 0 ? `?${queryString}` : '';

  return request<{ proposals: CommandProposalSummary[]; nextCursor?: string }>(
    `/workspaces/${encodeURIComponent(workspaceId)}/commands/proposals${suffix}`,
    { method: 'GET' },
  );
}

export function decideProposal(
  workspaceId: string,
  proposalId: string,
  decisions: { actionId: string; decision: 'approved' | 'rejected' }[],
): Promise<{ results: DecideActionResult[] }> {
  return request<{ results: DecideActionResult[] }>(
    `/workspaces/${encodeURIComponent(workspaceId)}/commands/${encodeURIComponent(proposalId)}/decide`,
    {
      method: 'POST',
      body: JSON.stringify({ decisions }),
    },
  );
}

/**
 * F2-T17 PR3 (ADR-0034) -- trigger-template-suggestion read/analyze/decide
 * client, feeding `TriggerSuggestionsPanel`. Mirrors the already-merged
 * server-side `TriggerTemplateSuggestionSummary` shape exactly
 * (`apps/server/src/trigger-suggestions/trigger-suggestions.controller.ts`,
 * `trigger-suggestions.service.ts`); not imported from the server, per this
 * file's convention of locally re-declaring every shape.
 */
export type TriggerSpecSummary =
  | { kind: 'scheduled'; intervalMinutes: number; actionTemplate: { title: string } }
  | {
      kind: 'condition';
      objectType: string;
      fieldKey: string;
      pattern: string;
      flags: string;
      actionTemplate: { title: string };
    };

export interface TriggerTemplateSuggestionSummary {
  id: string;
  workspaceId: string;
  name: string;
  kind: 'scheduled' | 'condition';
  spec: TriggerSpecSummary;
  rationale: string;
  status: 'pending' | 'approved' | 'rejected';
  createdTriggerId: string | null;
  createdAt: string;
  decidedAt: string | null;
}

export function listTriggerSuggestions(
  workspaceId: string,
): Promise<{ suggestions: TriggerTemplateSuggestionSummary[] }> {
  return request<{ suggestions: TriggerTemplateSuggestionSummary[] }>(
    `/workspaces/${encodeURIComponent(workspaceId)}/trigger-suggestions`,
    { method: 'GET' },
  );
}

export function runTriggerSuggestionsAnalysis(
  workspaceId: string,
): Promise<{ suggestions: TriggerTemplateSuggestionSummary[] }> {
  return request<{ suggestions: TriggerTemplateSuggestionSummary[] }>(
    `/workspaces/${encodeURIComponent(workspaceId)}/trigger-suggestions/analyze`,
    { method: 'POST' },
  );
}

export function decideTriggerSuggestion(
  workspaceId: string,
  suggestionId: string,
  decision: 'approve' | 'reject',
): Promise<{ suggestion: TriggerTemplateSuggestionSummary }> {
  return request<{ suggestion: TriggerTemplateSuggestionSummary }>(
    `/workspaces/${encodeURIComponent(workspaceId)}/trigger-suggestions/${encodeURIComponent(suggestionId)}/decide`,
    {
      method: 'POST',
      body: JSON.stringify({ decision }),
    },
  );
}
