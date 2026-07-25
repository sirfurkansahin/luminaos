import { z } from 'zod';

/**
 * The 14 documented filter operators for the query DSL. Order matters here —
 * it is pinned by `query-spec.test.ts`'s "contains exactly the 14 documented
 * operator literals, in order" assertion.
 */
export const FILTER_OPERATORS = [
  'equals',
  'notEquals',
  'contains',
  'notContains',
  'gt',
  'gte',
  'lt',
  'lte',
  'between',
  'before',
  'after',
  'in',
  'notIn',
  'isEmpty',
  'isNotEmpty',
] as const;

export const filterOperatorSchema = z.enum(FILTER_OPERATORS);

export type FilterOperator = z.infer<typeof filterOperatorSchema>;

/**
 * A single filter condition against a field. `value`'s shape is intentionally
 * left unvalidated at this layer (`z.unknown()`, optional) — its expected
 * shape depends on `operator` (e.g. `between` wants a 2-tuple, `isEmpty`
 * wants none at all), and that per-operator validation belongs to the query
 * engine that consumes this spec, not this DTO.
 */
export const filterConditionSchema = z
  .object({
    field: z.string().min(1).max(200),
    operator: filterOperatorSchema,
    value: z.unknown().optional(),
  })
  .strict();

export type FilterCondition = z.infer<typeof filterConditionSchema>;

export const sortSpecSchema = z
  .object({
    field: z.string().min(1).max(200),
    direction: z.enum(['asc', 'desc']),
  })
  .strict();

export type SortSpec = z.infer<typeof sortSpecSchema>;

/**
 * The top-level query DSL spec. `filters` is required but may be an empty
 * array — "no filters" is itself a valid query (return everything, subject
 * to pagination). `cursor` is treated as an opaque, non-empty token; its
 * internal format is owned by whichever query engine issues it, not by this
 * schema.
 */
export const querySpecSchema = z
  .object({
    objectType: z.string().min(1).max(100),
    filters: z.array(filterConditionSchema).max(50),
    sort: z.array(sortSpecSchema).max(10).optional(),
    group: z.string().min(1).max(200).optional(),
    cursor: z.string().min(1).optional(),
    limit: z.number().int().positive().max(200).optional(),
  })
  .strict();

export type QuerySpec = z.infer<typeof querySpecSchema>;
