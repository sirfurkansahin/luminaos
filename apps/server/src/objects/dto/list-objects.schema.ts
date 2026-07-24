import { z } from 'zod';

import type { AggregateFn } from '@luminaos/core-objects';

/**
 * The 7 known `AggregateFn` values, redeclared here as a zod enum (rather
 * than imported, since `@luminaos/core-objects` only exports the TypeScript
 * union, not a zod schema for it — same reasoning as `define-field.schema.ts`'s
 * `FIELD_TYPES`). `satisfies readonly AggregateFn[]` keeps this list in sync
 * with `core-objects`' own `AggregateFn` union at compile time.
 */
const AGGREGATE_FNS = [
  'sum',
  'avg',
  'min',
  'max',
  'count',
  'countUnique',
  'countEmpty',
] as const satisfies readonly AggregateFn[];

const aggregateFnSchema = z.enum(AGGREGATE_FNS);

export interface AggregateSpec {
  fieldKey: string;
  fn: AggregateFn;
}

/**
 * Parses the raw `?aggregate=` query string into a structured list of
 * `{ fieldKey, fn }` specs, or reports a validation issue via `ctx` and
 * returns `z.NEVER` on any malformed input (missing `:`, empty `fieldKey`/
 * `fn`, unknown `fn`, or an empty segment from an empty string / trailing
 * comma). A single `ctx.addIssue` call is enough — `ZodValidationPipe`
 * surfaces the resulting `ZodError` as a 400 `ValidationError` regardless of
 * how many issues were recorded.
 */
function parseAggregateParam(raw: string, ctx: z.RefinementCtx): AggregateSpec[] {
  const segments = raw.split(',');
  const specs: AggregateSpec[] = [];

  for (const segment of segments) {
    const parts = segment.split(':');

    if (parts.length !== 2) {
      ctx.addIssue({
        code: 'custom',
        message: `Invalid "aggregate" segment "${segment}": expected exactly one "fieldKey:fn" pair`,
      });
      return z.NEVER;
    }

    const [fieldKey, fn] = parts;

    if (!fieldKey || !fn) {
      ctx.addIssue({
        code: 'custom',
        message: `Invalid "aggregate" segment "${segment}": fieldKey and fn must both be non-empty`,
      });
      return z.NEVER;
    }

    const fnResult = aggregateFnSchema.safeParse(fn);

    if (!fnResult.success) {
      ctx.addIssue({
        code: 'custom',
        message: `Unknown aggregate function "${fn}"`,
      });
      return z.NEVER;
    }

    specs.push({ fieldKey, fn: fnResult.data });
  }

  return specs;
}

/**
 * Validates a `GET /workspaces/:workspaceId/objects?aggregate=...` request's
 * query parameters. `aggregate` is optional; when present it's a raw
 * comma-separated `fieldKey:fn` list, parsed/validated by
 * `parseAggregateParam` above. `.strict()` rejects unknown query keys,
 * matching this codebase's other DTO conventions.
 */
export const listObjectsQuerySchema = z
  .object({
    aggregate: z
      .string()
      .transform((raw, ctx) => parseAggregateParam(raw, ctx))
      .optional(),
  })
  .strict();

export type ListObjectsQuery = z.infer<typeof listObjectsQuerySchema>;
