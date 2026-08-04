import type { FieldDefinition } from '@luminaos/core-objects';

/**
 * The shape `status`'s active `select` `FieldDefinition.config` is guaranteed
 * to carry by construction (`@luminaos/core-objects`'s `optionSchema`, F1-T10
 * PR1) once it reaches here -- mirrors `ObjectsService`'s own
 * `AIFieldConfig`/`formulaExpression` "single place this assumption is
 * documented and asserted" convention.
 */
interface SelectOption {
  value: string;
  label: string;
  isDone?: boolean;
}

interface SelectFieldConfig {
  options: SelectOption[];
}

/**
 * Resolves a (possibly unmatched/`undefined`) `status` value against the
 * active `status` field definition's `config.options`, returning the
 * matching option's `isDone` flag -- an unmatched value (including
 * `undefined`, a brand-new object that never had `status` set) is treated as
 * `isDone: false` (absence of completion, not an error), per ADR-0010 §(f).
 */
function resolveIsDone(value: unknown, options: SelectOption[]): boolean {
  const match = options.find((option) => option.value === value);
  return match?.isDone === true;
}

/**
 * Pure detection of a genuine `status`/`isDone` false->true transition
 * (ADR-0010 §"(f) Tetikleyici tespiti"). See
 * `./status-done-transition.test.ts`'s header comment for the exhaustively
 * pinned contract this implements.
 */
export function detectStatusDoneTransition(input: {
  fieldKey: string;
  definitions: FieldDefinition[];
  previousValue: unknown;
  newValue: unknown;
}): boolean {
  if (input.fieldKey !== 'status') {
    return false;
  }

  const statusDefinition = input.definitions.find(
    (definition) =>
      definition.key === 'status' &&
      definition.fieldType === 'select' &&
      definition.lifecycle === 'active',
  );

  if (!statusDefinition) {
    return false;
  }

  const { options } = statusDefinition.config as SelectFieldConfig;

  const wasDone = resolveIsDone(input.previousValue, options);
  const isDone = resolveIsDone(input.newValue, options);

  return !wasDone && isDone;
}
