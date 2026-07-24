import { z } from 'zod';

/**
 * The result of evaluating a formula. `evaluateFormula` never throws — any
 * runtime failure (type mismatch, division by zero, missing field, etc.) is
 * represented as a `FormulaErrorValue` instead.
 */
export interface FormulaErrorValue {
  formulaError: true;
  message: string;
}

export type FormulaValue = number | string | boolean | null | FormulaErrorValue;

export function isFormulaError(value: FormulaValue): value is FormulaErrorValue {
  return typeof value === 'object' && value !== null && value.formulaError;
}

export const formulaValueSchema = z.union([
  z.number(),
  z.string(),
  z.boolean(),
  z.null(),
  z.object({ formulaError: z.literal(true), message: z.string() }).strict(),
]);
