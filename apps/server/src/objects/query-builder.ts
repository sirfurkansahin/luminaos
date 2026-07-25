import {
  and,
  asc,
  between,
  desc,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  notIlike,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';

import type { FieldType } from '@luminaos/core-objects';
import { ValidationError } from '@luminaos/shared';
import type { FilterCondition, FilterOperator, SortSpec } from '@luminaos/shared';

import { objectsView } from '../db/schema/objects-view.js';

import type { SQL } from 'drizzle-orm';

/**
 * F1-T6 PR-C: server-side SQL compilation for the query/filter/sort/group
 * endpoint. Every dynamic value here (field keys, filter values, cursor
 * values) is interpolated ONLY through drizzle-orm's `sql` tagged template's
 * own `${...}` bound-parameter mechanism -- never `sql.raw()`, never string
 * concatenation. This mirrors `objects-view.projection.ts`'s `jsonb_set`
 * doc-comment reasoning exactly: an untrusted string becomes a real,
 * type-cast query PARAMETER, not text spliced into the query itself. The
 * `::text`/`::text[]` casts scattered throughout exist only to disambiguate
 * Postgres operator overload resolution for an otherwise-untyped bound
 * parameter (e.g. jsonb's `->`/`->>` each have both an `int` and a `text`
 * right-hand overload) -- they are NOT part of the SQL-injection defense
 * itself, which is the parameter binding alone.
 */

type ObjectsViewRow = typeof objectsView.$inferSelect;

export const FIXED_COLUMN_KEYS = ['title', 'createdAt', 'updatedAt'] as const;

export type FixedColumnKey = (typeof FIXED_COLUMN_KEYS)[number];

export function isFixedColumnKey(field: string): field is FixedColumnKey {
  return (FIXED_COLUMN_KEYS as readonly string[]).includes(field);
}

/**
 * Fixed columns have no `FieldDefinition`/permission concept -- their valid
 * operator sets are pinned directly here, per the F1-T6 PR-C contract (see
 * `object-query.integration.test.ts`'s header comment).
 */
export const FIXED_COLUMN_OPERATORS: Record<FixedColumnKey, readonly FilterOperator[]> = {
  title: ['equals', 'notEquals', 'contains', 'notContains', 'isEmpty', 'isNotEmpty'],
  createdAt: ['equals', 'before', 'after', 'between', 'isEmpty', 'isNotEmpty'],
  updatedAt: ['equals', 'before', 'after', 'between', 'isEmpty', 'isNotEmpty'],
};

export type ResolvedField =
  { kind: 'fixed'; key: FixedColumnKey } | { kind: 'custom'; key: string; fieldType: FieldType };

/** Caps an `in`/`notIn` filter's array length -- an uncapped array would let a single filter condition drive an arbitrarily large parameterized `IN (...)`/`?|` list (security review finding, F1-T6 PR-C; mirrors every other bounded-count constant `packages/shared/src/query/query-spec.ts` already applies at the `QuerySpec` level). */
const MAX_FILTER_ARRAY_LENGTH = 100;

/**
 * Operator-driven `value` shape rules -- independent of the field's type,
 * purely a function of the operator itself. Throws `ValidationError` on any
 * violation; returns normally on success.
 */
export function assertOperatorValueShape(operator: FilterOperator, value: unknown): void {
  if (operator === 'isEmpty' || operator === 'isNotEmpty') {
    if (value !== undefined) {
      throw new ValidationError(`"${operator}" does not accept a value`, { operator });
    }
    return;
  }

  if (operator === 'between') {
    if (!Array.isArray(value) || value.length !== 2) {
      throw new ValidationError('"between" requires an array of exactly 2 values', { operator });
    }
    return;
  }

  if (operator === 'in' || operator === 'notIn') {
    if (!Array.isArray(value)) {
      throw new ValidationError(`"${operator}" requires an array value`, { operator });
    }

    if (value.length > MAX_FILTER_ARRAY_LENGTH) {
      throw new ValidationError(
        `"${operator}" array value exceeds the maximum of ${String(MAX_FILTER_ARRAY_LENGTH)} entries`,
        { operator },
      );
    }

    return;
  }

  if (value === undefined) {
    throw new ValidationError(`"${operator}" requires a value`, { operator });
  }

  if (Array.isArray(value)) {
    throw new ValidationError(`"${operator}" does not accept an array value`, { operator });
  }
}

// --- per-operator VALUE TYPE assertions (field-type-aware) -----------------
//
// `assertOperatorValueShape` (above) only checks operator-driven ARITY
// (array-vs-scalar, presence/absence, `between`'s 2-element requirement) --
// it has no knowledge of the target field's TYPE, so it cannot check that,
// say, a `number` field's `equals` value is actually a JS number. Without
// this, a malformed value (e.g. a string where a number is expected) would
// reach a `::numeric`/`::timestamptz`/`::boolean` SQL cast unchecked,
// surfacing as a raw, uncontrolled Postgres cast error (never a SQL
// injection or data leak -- `AppErrorFilter` already prevents any raw driver
// message from reaching the client/logs -- but a worse-than-necessary,
// un-actionable `500` instead of a clean `400 ValidationError`). These
// helpers close that gap (security review finding, F1-T6 PR-C).

function assertStringValue(value: unknown, operator: FilterOperator): string {
  if (typeof value !== 'string') {
    throw new ValidationError(`"${operator}" requires a string value`, { operator });
  }

  return value;
}

function assertNumberValue(value: unknown, operator: FilterOperator): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ValidationError(`"${operator}" requires a numeric value`, { operator });
  }

  return value;
}

function assertBooleanValue(value: unknown, operator: FilterOperator): boolean {
  if (typeof value !== 'boolean') {
    throw new ValidationError(`"${operator}" requires a boolean value`, { operator });
  }

  return value;
}

function assertDateValue(value: unknown, operator: FilterOperator): Date {
  const raw = assertStringValue(value, operator);
  const date = new Date(raw);

  if (Number.isNaN(date.getTime())) {
    throw new ValidationError(`"${operator}" requires a valid date/datetime string value`, {
      operator,
    });
  }

  return date;
}

function assertStringArrayValue(value: unknown, operator: FilterOperator): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new ValidationError(`"${operator}" requires an array of string values`, { operator });
  }

  return value;
}

/** `assertOperatorValueShape` already guarantees `value` is a 2-element array for `between` -- this only validates each element's type. */
function assertNumberPair(value: unknown, operator: FilterOperator): [number, number] {
  const [first, second] = value as [unknown, unknown];
  return [assertNumberValue(first, operator), assertNumberValue(second, operator)];
}

/** Same arity guarantee as `assertNumberPair`, for date-shaped `between` bounds. */
function assertDatePair(value: unknown, operator: FilterOperator): [Date, Date] {
  const [first, second] = value as [unknown, unknown];
  return [assertDateValue(first, operator), assertDateValue(second, operator)];
}

// --- jsonb access helpers ---------------------------------------------------

/**
 * `(field_values ->> key)` -- text extraction of a custom field's raw stored
 * value. `key` is cast to `::text` solely to disambiguate the `->>`
 * operator's `(jsonb, text)` vs `(jsonb, int)` overloads for an otherwise
 * untyped bound parameter -- `key` itself is always a bound parameter,
 * never spliced into the query text.
 */
function fieldTextExpr(key: string): SQL {
  return sql`(${objectsView.fieldValues} ->> ${key}::text)`;
}

/**
 * `(field_values -> key)` -- jsonb extraction, used where the raw jsonb
 * shape matters (array-valued fields, or an `IS NULL` emptiness check that
 * must cover both "key absent" and "value is JSON null", both of which `->`
 * resolves to SQL NULL for).
 */
function fieldJsonbExpr(key: string): SQL {
  return sql`(${objectsView.fieldValues} -> ${key}::text)`;
}

/**
 * Escapes a raw string's own literal `\`/`%`/`_` characters before it is
 * wrapped as an ILIKE pattern -- a functional-correctness concern (so a
 * value containing a literal `%`/`_` doesn't act as an unintended
 * wildcard), not a SQL-injection concern (the value is bound as a
 * parameter regardless). The backslash itself MUST be escaped FIRST: `\`
 * is ILIKE's own default escape character, so escaping `%`/`_` before `\`
 * would let a caller's own pre-existing backslash "consume" the escape we
 * just inserted (e.g. `a\_b` -> naively escaping `_` first gives `a\\_b`,
 * which Postgres reads as an escaped literal backslash followed by an
 * UNESCAPED, live `_` wildcard -- not the literal underscore the caller
 * intended). Escaping `\` first (`a\_b` -> `a\\_b` at THIS step, then
 * `%`/`_` escaping sees no bare `_` left to touch) closes that gap
 * (security review finding, F1-T6 PR-C).
 */
function likePattern(raw: string): string {
  const escaped = raw.replace(/\\/g, '\\\\').replace(/[%_]/g, (match) => `\\${match}`);
  return `%${escaped}%`;
}

function invalidOperatorError(operator: FilterOperator): ValidationError {
  return new ValidationError('operator is not valid for this field type', { operator });
}

// --- fixed-column predicates -------------------------------------------------

function buildFixedColumnPredicate(key: FixedColumnKey, condition: FilterCondition): SQL {
  const { operator, value } = condition;

  if (key === 'title') {
    const column = objectsView.title;

    switch (operator) {
      case 'equals':
        return eq(column, assertStringValue(value, operator));
      case 'notEquals':
        return ne(column, assertStringValue(value, operator));
      case 'contains':
        return ilike(column, likePattern(assertStringValue(value, operator)));
      case 'notContains':
        return notIlike(column, likePattern(assertStringValue(value, operator)));
      case 'isEmpty':
        return sql`false`;
      case 'isNotEmpty':
        return sql`true`;
      default:
        throw invalidOperatorError(operator);
    }
  }

  const column = key === 'createdAt' ? objectsView.createdAt : objectsView.updatedAt;

  switch (operator) {
    case 'equals':
      return eq(column, assertDateValue(value, operator));
    case 'before':
      return lt(column, assertDateValue(value, operator));
    case 'after':
      return gt(column, assertDateValue(value, operator));
    case 'between': {
      const [min, max] = assertDatePair(value, operator);
      return between(column, min, max);
    }
    case 'isEmpty':
      return sql`false`;
    case 'isNotEmpty':
      return sql`true`;
    default:
      throw invalidOperatorError(operator);
  }
}

// --- custom-field predicates -------------------------------------------------

function buildTextLikePredicate(key: string, operator: FilterOperator, value: unknown): SQL {
  const textExpr = fieldTextExpr(key);

  switch (operator) {
    case 'equals':
      return eq(textExpr, assertStringValue(value, operator));
    case 'notEquals':
      return ne(textExpr, assertStringValue(value, operator));
    case 'contains':
      return ilike(textExpr, likePattern(assertStringValue(value, operator)));
    case 'notContains':
      return notIlike(textExpr, likePattern(assertStringValue(value, operator)));
    case 'isEmpty':
      return isNull(fieldJsonbExpr(key));
    case 'isNotEmpty':
      return isNotNull(fieldJsonbExpr(key));
    default:
      throw invalidOperatorError(operator);
  }
}

function buildNumericPredicate(key: string, operator: FilterOperator, value: unknown): SQL {
  const numericExpr = sql`(${fieldTextExpr(key)})::numeric`;

  switch (operator) {
    case 'equals':
      return eq(numericExpr, assertNumberValue(value, operator));
    case 'notEquals':
      return ne(numericExpr, assertNumberValue(value, operator));
    case 'gt':
      return gt(numericExpr, assertNumberValue(value, operator));
    case 'gte':
      return gte(numericExpr, assertNumberValue(value, operator));
    case 'lt':
      return lt(numericExpr, assertNumberValue(value, operator));
    case 'lte':
      return lte(numericExpr, assertNumberValue(value, operator));
    case 'between': {
      const [min, max] = assertNumberPair(value, operator);
      return between(numericExpr, min, max);
    }
    default:
      throw invalidOperatorError(operator);
  }
}

function buildDatePredicate(key: string, operator: FilterOperator, value: unknown): SQL {
  const timestampExpr = sql`(${fieldTextExpr(key)})::timestamptz`;

  switch (operator) {
    case 'equals':
      return eq(timestampExpr, assertDateValue(value, operator));
    case 'before':
      return lt(timestampExpr, assertDateValue(value, operator));
    case 'after':
      return gt(timestampExpr, assertDateValue(value, operator));
    case 'between': {
      const [min, max] = assertDatePair(value, operator);
      return between(timestampExpr, min, max);
    }
    case 'isEmpty':
      return isNull(fieldJsonbExpr(key));
    case 'isNotEmpty':
      return isNotNull(fieldJsonbExpr(key));
    default:
      throw invalidOperatorError(operator);
  }
}

function buildCheckboxPredicate(key: string, operator: FilterOperator, value: unknown): SQL {
  const booleanExpr = sql`(${fieldTextExpr(key)})::boolean`;

  switch (operator) {
    case 'equals':
      return eq(booleanExpr, assertBooleanValue(value, operator));
    default:
      throw invalidOperatorError(operator);
  }
}

function buildSelectPredicate(key: string, operator: FilterOperator, value: unknown): SQL {
  const textExpr = fieldTextExpr(key);

  switch (operator) {
    case 'equals':
      return eq(textExpr, assertStringValue(value, operator));
    case 'notEquals':
      return ne(textExpr, assertStringValue(value, operator));
    case 'in':
      return inArray(textExpr, assertStringArrayValue(value, operator));
    case 'notIn':
      return notInArray(textExpr, assertStringArrayValue(value, operator));
    default:
      throw invalidOperatorError(operator);
  }
}

function buildMultiSelectPredicate(key: string, operator: FilterOperator, value: unknown): SQL {
  const arrayExpr = fieldJsonbExpr(key);

  switch (operator) {
    case 'in':
      return sql`${arrayExpr} ?| ${assertStringArrayValue(value, operator)}::text[]`;
    case 'notIn':
      return sql`NOT (${arrayExpr} ?| ${assertStringArrayValue(value, operator)}::text[])`;
    case 'isEmpty':
      return isNull(arrayExpr);
    case 'isNotEmpty':
      return isNotNull(arrayExpr);
    default:
      throw invalidOperatorError(operator);
  }
}

function buildPeoplePredicate(key: string, operator: FilterOperator, value: unknown): SQL {
  const arrayExpr = fieldJsonbExpr(key);

  switch (operator) {
    case 'contains':
      return sql`${arrayExpr} ? ${assertStringValue(value, operator)}::text`;
    case 'isEmpty':
      return isNull(arrayExpr);
    case 'isNotEmpty':
      return isNotNull(arrayExpr);
    default:
      throw invalidOperatorError(operator);
  }
}

/**
 * `formula`/`ai` fields' result type is opaque to this query layer (see
 * `filter-operators.ts`'s own `FORMULA_OPERATORS`/`getAIOperators` doc
 * comments) -- `equals`/`notEquals` compare the raw stored jsonb scalar
 * directly (works uniformly for a string/number/boolean result without
 * needing to know which), `contains`/`notContains`/`in`/`notIn` (only
 * reachable for an `ai` field with a text/select `outputType`) fall back to
 * the same text/array-membership primitives as `text`/`select`.
 */
function buildGenericScalarPredicate(key: string, operator: FilterOperator, value: unknown): SQL {
  const jsonbExpr = fieldJsonbExpr(key);
  const textExpr = fieldTextExpr(key);

  switch (operator) {
    case 'equals':
      return sql`${jsonbExpr} = ${JSON.stringify(value)}::jsonb`;
    case 'notEquals':
      return sql`${jsonbExpr} != ${JSON.stringify(value)}::jsonb`;
    case 'contains':
      return ilike(textExpr, likePattern(assertStringValue(value, operator)));
    case 'notContains':
      return notIlike(textExpr, likePattern(assertStringValue(value, operator)));
    case 'in':
      return inArray(textExpr, assertStringArrayValue(value, operator));
    case 'notIn':
      return notInArray(textExpr, assertStringArrayValue(value, operator));
    case 'isEmpty':
      return isNull(jsonbExpr);
    case 'isNotEmpty':
      return isNotNull(jsonbExpr);
    default:
      throw invalidOperatorError(operator);
  }
}

function buildCustomFieldPredicate(
  fieldType: FieldType,
  key: string,
  condition: FilterCondition,
): SQL {
  const { operator, value } = condition;

  switch (fieldType) {
    case 'text':
    case 'longText':
    case 'url':
    case 'email':
      return buildTextLikePredicate(key, operator, value);
    case 'number':
    case 'currency':
      return buildNumericPredicate(key, operator, value);
    case 'date':
    case 'datetime':
      return buildDatePredicate(key, operator, value);
    case 'checkbox':
      return buildCheckboxPredicate(key, operator, value);
    case 'select':
      return buildSelectPredicate(key, operator, value);
    case 'multiSelect':
      return buildMultiSelectPredicate(key, operator, value);
    case 'people':
      return buildPeoplePredicate(key, operator, value);
    case 'formula':
    case 'ai':
      return buildGenericScalarPredicate(key, operator, value);
  }
}

export function buildFilterPredicate(field: ResolvedField, condition: FilterCondition): SQL {
  if (field.kind === 'fixed') {
    return buildFixedColumnPredicate(field.key, condition);
  }

  return buildCustomFieldPredicate(field.fieldType, field.key, condition);
}

/** Excludes rows whose group field has no value set at all (absent key OR JSON null) -- per the group-mode contract, such a row belongs to no group and must not inflate any group's count. */
export function buildGroupNotNullPredicate(groupField: string): SQL {
  return isNotNull(fieldJsonbExpr(groupField));
}

export function extractGroupValue(row: ObjectsViewRow, groupField: string): unknown {
  const fieldValues = (row.fieldValues ?? {}) as Record<string, unknown>;
  return fieldValues[groupField];
}

// --- sorting + cursor pagination ---------------------------------------------

type SortKind = 'text' | 'numeric' | 'timestamp' | 'boolean';

export interface ResolvedSortColumn {
  field: string;
  direction: 'asc' | 'desc';
  expr: SQL;
  kind: SortKind;
}

function sortKindForFieldType(fieldType: FieldType): SortKind {
  switch (fieldType) {
    case 'number':
    case 'currency':
      return 'numeric';
    case 'date':
    case 'datetime':
      return 'timestamp';
    case 'checkbox':
      return 'boolean';
    default:
      // text, longText, url, email, select -- the only other sortable
      // custom field types (`assertSortableField` already rejects
      // multiSelect/people/formula/ai before this is ever reached).
      return 'text';
  }
}

function resolveSortColumn(
  field: string,
  direction: 'asc' | 'desc',
  fieldType?: FieldType,
): ResolvedSortColumn {
  if (field === 'title') {
    return { field, direction, expr: sql`${objectsView.title}`, kind: 'text' };
  }

  if (field === 'createdAt') {
    return { field, direction, expr: sql`${objectsView.createdAt}`, kind: 'timestamp' };
  }

  if (field === 'updatedAt') {
    return { field, direction, expr: sql`${objectsView.updatedAt}`, kind: 'timestamp' };
  }

  if (field === 'id') {
    return { field, direction, expr: sql`${objectsView.id}`, kind: 'text' };
  }

  const kind = sortKindForFieldType(fieldType as FieldType);
  const textExpr = fieldTextExpr(field);

  const expr =
    kind === 'numeric'
      ? sql`(${textExpr})::numeric`
      : kind === 'timestamp'
        ? sql`(${textExpr})::timestamptz`
        : kind === 'boolean'
          ? sql`(${textExpr})::boolean`
          : textExpr;

  return { field, direction, expr, kind };
}

/**
 * Builds the effective, total-order sort-column list: the caller's own
 * `sort` (defaulting to `[{ field: 'createdAt', direction: 'asc' }]` when
 * absent/empty), ALWAYS followed by a trailing, hidden `id` tiebreaker
 * (same direction as the last explicit sort entry, `asc` if there was none)
 * -- guarantees a deterministic, gap-free total order for cursor pagination.
 */
export function buildSortColumns(
  sort: SortSpec[] | undefined,
  resolveFieldType: (field: string) => FieldType | undefined,
): ResolvedSortColumn[] {
  const effectiveSort: SortSpec[] =
    sort && sort.length > 0 ? sort : [{ field: 'createdAt', direction: 'asc' }];

  const columns = effectiveSort.map((sortEntry) =>
    resolveSortColumn(sortEntry.field, sortEntry.direction, resolveFieldType(sortEntry.field)),
  );

  const lastEntry = effectiveSort[effectiveSort.length - 1];
  const tiebreakDirection = lastEntry ? lastEntry.direction : 'asc';

  columns.push(resolveSortColumn('id', tiebreakDirection));

  return columns;
}

export function buildOrderBy(sortColumns: ResolvedSortColumn[]): SQL[] {
  return sortColumns.map((column) =>
    column.direction === 'asc' ? asc(column.expr) : desc(column.expr),
  );
}

function extractRawFieldValue(row: ObjectsViewRow, field: string): unknown {
  if (field === 'id') {
    return row.id;
  }

  if (field === 'title') {
    return row.title;
  }

  if (field === 'createdAt') {
    return row.createdAt;
  }

  if (field === 'updatedAt') {
    return row.updatedAt;
  }

  const fieldValues = (row.fieldValues ?? {}) as Record<string, unknown>;
  return fieldValues[field];
}

/** The exact value tuple (one per effective sort column, including the trailing `id`) `encodeCursor` should be called with for `row`. */
export function extractCursorValues(
  row: ObjectsViewRow,
  sortColumns: ResolvedSortColumn[],
): unknown[] {
  return sortColumns.map((column) => extractRawFieldValue(row, column.field));
}

export function encodeCursor(values: unknown[]): string {
  return Buffer.from(JSON.stringify(values), 'utf8').toString('base64url');
}

/**
 * Reverses `encodeCursor`. Throws `ValidationError` (never lets a decode
 * failure propagate as an uncaught exception) on ANY malformed input --
 * invalid base64, invalid JSON, or a value that isn't a JSON array.
 */
export function decodeCursor(cursor: string): unknown[] {
  let json: string;

  try {
    json = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    throw new ValidationError('malformed cursor');
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(json);
  } catch {
    throw new ValidationError('malformed cursor');
  }

  if (!Array.isArray(parsed)) {
    throw new ValidationError('malformed cursor');
  }

  return parsed;
}

function bindComparableValue(kind: SortKind, value: unknown): SQL {
  switch (kind) {
    case 'numeric':
      return sql`${value}::numeric`;
    case 'timestamp':
      return sql`${value}::timestamptz`;
    case 'boolean':
      return sql`${value}::boolean`;
    case 'text':
      return sql`${value}::text`;
  }
}

/**
 * The standard general keyset-pagination "seek" predicate for sort keys
 * `(C1,dir1), (C2,dir2), ..., (Cn,dirn)` and cursor values `(V1..Vn)`:
 * `(C1 op1 V1) OR (C1=V1 AND C2 op2 V2) OR ... OR (C1=V1 AND ... AND Cn
 * opn Vn)`, where `opX` is `>` for `asc`, `<` for `desc`. Built
 * incrementally (an `AND`-chain accumulator carried across iterations)
 * rather than with nested indexed access, so it naturally handles both the
 * common single-sort-key case and true multi-key sorts.
 */
export function buildKeysetPredicate(
  sortColumns: ResolvedSortColumn[],
  cursorValues: unknown[],
): SQL {
  if (cursorValues.length !== sortColumns.length) {
    throw new ValidationError("cursor does not match this query's sort columns");
  }

  const orClauses: SQL[] = [];
  const equalitySoFar: SQL[] = [];

  sortColumns.forEach((column, index) => {
    const boundValue = bindComparableValue(column.kind, cursorValues[index]);
    const comparison =
      column.direction === 'asc'
        ? sql`${column.expr} > ${boundValue}`
        : sql`${column.expr} < ${boundValue}`;

    const clause = and(...equalitySoFar, comparison);

    if (clause) {
      orClauses.push(clause);
    }

    equalitySoFar.push(sql`${column.expr} = ${boundValue}`);
  });

  const result = or(...orClauses);

  if (!result) {
    // Unreachable: `sortColumns` always has at least one entry (the
    // trailing `id` tiebreaker `buildSortColumns` always appends).
    throw new ValidationError('unable to build cursor predicate');
  }

  return result;
}
