import type { AIProvider, AITokenUsage } from '@luminaos/ai-gateway';
import { MAX_WIDGET_TABLE_ROWS } from '@luminaos/artifacts';
import type { FieldDefinition, ObjectType } from '@luminaos/core-objects';
import { querySpecSchema } from '@luminaos/shared';
import type { QuerySpec } from '@luminaos/shared';

/**
 * The provider-facing, DB-free "turn a natural-language widget request into a
 * validated `QuerySpec`" orchestrator (F3-T8 PR2, ADR-0042 Karar c): sibling
 * of `parseCommand` (`../ai/parse-command.ts`)/`generateArtifact`
 * (`./generate-artifact.ts`) -- provider/model/recordUsage all injected, no
 * Postgres/EventStore.
 *
 * Per ADR-0042 Karar (c), the model's JSON response is first validated
 * SCHEMA-wise by `querySpecSchema` (structural shape only), then passed
 * through `validateCompiledQuerySpec` below -- a business-rule allowlist
 * layer that rejects a schema-VALID-but-semantically-wrong response, exactly
 * like `parseCommand`'s `ALLOWED_PARSE_COMMAND_TYPES` allowlist rejects a
 * schema-valid-but-wrong-`type` action:
 *
 *   - `objectType` must match the requested `objectType` exactly.
 *   - `group` is forbidden (v0 is flat-table-only widgets).
 *   - every `filters`/`sort` `field` must reference either `"title"` (the
 *     object shell's own field, not a custom `FieldDefinition`) or a key
 *     present in the caller-supplied `availableFields` (already filtered by
 *     the caller's own role upstream, in `FieldDefinitionsService.list`) --
 *     this prevents a hallucinated/prompt-injected reference to a hidden or
 *     nonexistent field.
 *
 * An oversized `limit` is NOT treated as a rejection signal -- it is benign
 * and safely narrowed by clamping it down to `MAX_WIDGET_TABLE_ROWS`.
 */
export interface CompileWidgetQueryInput {
  provider: AIProvider;
  prompt: string;
  objectType: ObjectType;
  availableFields: FieldDefinition[];
  model?: string;
  recordUsage: (usage: AITokenUsage) => Promise<void> | void;
}

export interface CompileWidgetQueryResult {
  querySpec: QuerySpec | undefined;
  parseError: boolean;
  message?: string;
}

const COMPILE_EXHAUSTED_MESSAGE =
  'AI response could not be compiled into a valid, referenceable query after retry';

/** `"title"` always refers to the object shell's own title field, never a
 * custom `FieldDefinition` -- it is always allowed regardless of which
 * custom fields exist/are visible for the requested `objectType`. */
const ALWAYS_ALLOWED_FIELD_KEYS: ReadonlySet<string> = new Set(['title']);

function renderCompileWidgetQueryPrompt(
  prompt: string,
  objectType: ObjectType,
  availableFields: FieldDefinition[],
): string {
  const fieldList = availableFields.map((field) => `"${field.key}"`).join(', ') || '(none)';

  return [
    'Compile the natural-language widget request below into a JSON QuerySpec.',
    'Respond with ONLY a JSON object (no surrounding text, no markdown fences) with exactly these fields:',
    `- objectType: MUST be exactly "${objectType}"`,
    '- filters: an array of { field, operator, value } objects (may be empty)',
    '- sort: an OPTIONAL array of { field, direction: "asc"|"desc" } objects',
    '- limit: an OPTIONAL positive integer',
    'Do NOT include a "group" key -- grouped/aggregated queries are not supported.',
    `Every "field" referenced in "filters"/"sort" MUST be either "title" or one of: ${fieldList}.`,
    '',
    `Request: ${prompt}`,
  ].join('\n');
}

function isAllowedField(field: string, allowedFieldKeys: ReadonlySet<string>): boolean {
  return ALWAYS_ALLOWED_FIELD_KEYS.has(field) || allowedFieldKeys.has(field);
}

/** Business-rule allowlist layer (ADR-0042 Karar c) -- see this module's own
 * doc comment above for the exact 3 rules enforced here. Returns a
 * (possibly limit-clamped) `QuerySpec` on success, or `undefined` if any
 * allowlist rule is violated. */
function validateCompiledQuerySpec(
  querySpec: QuerySpec,
  objectType: ObjectType,
  allowedFieldKeys: ReadonlySet<string>,
): QuerySpec | undefined {
  if (querySpec.objectType !== objectType) {
    return undefined;
  }

  if (querySpec.group !== undefined) {
    return undefined;
  }

  const allFiltersAllowed = querySpec.filters.every((filter) =>
    isAllowedField(filter.field, allowedFieldKeys),
  );

  if (!allFiltersAllowed) {
    return undefined;
  }

  const allSortAllowed = (querySpec.sort ?? []).every((sort) =>
    isAllowedField(sort.field, allowedFieldKeys),
  );

  if (!allSortAllowed) {
    return undefined;
  }

  if (querySpec.limit !== undefined && querySpec.limit > MAX_WIDGET_TABLE_ROWS) {
    return { ...querySpec, limit: MAX_WIDGET_TABLE_ROWS };
  }

  return querySpec;
}

function tryCompileQuerySpec(
  text: string,
  objectType: ObjectType,
  allowedFieldKeys: ReadonlySet<string>,
): QuerySpec | undefined {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }

  const result = querySpecSchema.safeParse(parsed);

  if (!result.success) {
    return undefined;
  }

  return validateCompiledQuerySpec(result.data, objectType, allowedFieldKeys);
}

export async function compileWidgetQuery(
  input: CompileWidgetQueryInput,
): Promise<CompileWidgetQueryResult> {
  const prompt = renderCompileWidgetQueryPrompt(
    input.prompt,
    input.objectType,
    input.availableFields,
  );
  const allowedFieldKeys = new Set(input.availableFields.map((field) => field.key));

  const complete = async (): Promise<string> => {
    const result = await input.provider.complete({
      prompt,
      ...(input.model !== undefined ? { model: input.model } : {}),
    });
    await input.recordUsage(result.usage);
    return result.text;
  };

  const firstResponse = await complete();
  const firstQuerySpec = tryCompileQuerySpec(firstResponse, input.objectType, allowedFieldKeys);

  if (firstQuerySpec !== undefined) {
    return { querySpec: firstQuerySpec, parseError: false };
  }

  const retryResponse = await complete();
  const retryQuerySpec = tryCompileQuerySpec(retryResponse, input.objectType, allowedFieldKeys);

  if (retryQuerySpec !== undefined) {
    return { querySpec: retryQuerySpec, parseError: false };
  }

  return { querySpec: undefined, parseError: true, message: COMPILE_EXHAUSTED_MESSAGE };
}
