/**
 * Substitutes every `{fieldKey}` placeholder in `promptTemplate` with the
 * corresponding entry from `fieldValues`, stringified. An unknown
 * placeholder (no matching key in `fieldValues`) is left as-is, verbatim --
 * `assertAIFieldRules` (`packages/core-objects`) already guarantees every
 * `sourceFields` entry is a known field at DEFINE time, so this is a
 * defensive fallback, not an expected path.
 *
 * Extracted out of `ObjectsService` (F1-T5 PR-D) so it can be exercised as a
 * pure, DB-free unit -- the seed for F1-T17's full eval infrastructure
 * (`docs/evals/ai-fields.md`, `ai-fields.eval.test.ts`) needs to run under
 * plain `pnpm test`, without Testcontainers.
 */
export function renderAIPrompt(
  promptTemplate: string,
  fieldValues: Record<string, unknown>,
): string {
  return promptTemplate.replace(/\{([a-zA-Z0-9_]+)\}/g, (placeholder, key: string) => {
    if (!(key in fieldValues)) {
      return placeholder;
    }

    return stringifyFieldValueForPrompt(fieldValues[key]);
  });
}

function stringifyFieldValueForPrompt(value: unknown): string {
  if (value === undefined || value === null) {
    return '';
  }

  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'object') {
    return JSON.stringify(value);
  }

  if (typeof value === 'number') {
    return String(value);
  }

  if (typeof value === 'boolean') {
    return String(value);
  }

  // `bigint`/`symbol`/`function` -- not a shape any real field value ever
  // takes (`validateFieldValue` at DEFINE time already rejects these), but
  // covered defensively with a fixed, safe placeholder rather than an
  // unsafe default-`Object.prototype.toString` stringification.
  return '[unsupported value]';
}
