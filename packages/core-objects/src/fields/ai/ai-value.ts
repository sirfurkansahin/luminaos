import { z } from 'zod';

/**
 * The stored value of an `ai` field. An `ai` field's value is always
 * computed by the ai-gateway; it never throws on evaluation failure, it
 * instead stores an `AIFieldErrorValue` marker (the same "never throws,
 * represent failure as data" convention as F1-T4's `FormulaValue` /
 * `FormulaErrorValue`, but a separate, standalone type — `ai` fields do not
 * reuse `formula`'s error type).
 */
export interface AIFieldErrorValue {
  aiFieldError: true;
  message: string;
}

export type AIValue = string | AIFieldErrorValue;

export function isAIFieldError(value: AIValue): value is AIFieldErrorValue {
  return typeof value === 'object' && value.aiFieldError;
}

export const aiFieldErrorSchema = z
  .object({ aiFieldError: z.literal(true), message: z.string() })
  .strict();
