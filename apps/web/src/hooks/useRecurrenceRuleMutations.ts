import { useMutation, useQueryClient } from '@tanstack/react-query';

import type { RecurrenceRule } from '@luminaos/core-objects';

import { clearRecurrenceRule, setRecurrenceRule } from '../lib/apiClient.js';

import type { ObjectWithFieldValues } from '../lib/apiClient.js';
import type { QueryKey, UseMutationOptions } from '@tanstack/react-query';

// Mirrors useChecklistMutations.ts's own surgical (not whole-object) rollback
// discipline, applied to the single `recurrenceRule` field: each mutation's
// context remembers only the previous `recurrenceRule` value THIS mutation's
// own optimistic write changed, never a whole-object cache snapshot. `onError`
// always reads the CURRENT cache state (which may already hold another,
// unrelated, already-succeeded mutation's result) and writes back only the
// `recurrenceRule` key against it.
export interface SetRuleContext {
  previousRecurrenceRule: RecurrenceRule | undefined;
}

export interface ClearRuleContext {
  previousRecurrenceRule: RecurrenceRule | undefined;
}

// Narrower than the full `UseMutationResult<...>` shape react-query's own
// `useMutation()` returns (`mutate` required, the rest optional) —
// deliberately so, to structurally accept the real hook's actual
// `UseMutationResult` return value (a strict superset, always assignable to
// a narrower type). Mirrors useChecklistMutations.ts's own
// `ChecklistMutationHandle`.
export interface RecurrenceRuleMutationHandle<TVariables> {
  mutate: (variables: TVariables) => void;
  isPending?: boolean;
  isSuccess?: boolean;
  isError?: boolean;
}

export interface RecurrenceRuleMutations {
  setRule: RecurrenceRuleMutationHandle<RecurrenceRule>;
  clearRule: RecurrenceRuleMutationHandle<void>;
}

/**
 * `ReturnType<typeof vi.fn>`-compatible shape, mirroring
 * `useChecklistMutations.ts`'s own `ChecklistMutationsMockCompatible` — exists
 * purely so `vi.mocked(useRecurrenceRuleMutations)`'s inferred
 * `mockReturnValue(...)` parameter type is loose enough to accept
 * RecurrenceRulePicker.test.tsx's `{ mutate: vi.fn() }`-shaped literals
 * without requiring a cast in the test file. Never used by any real call site.
 */
interface RecurrenceRuleMutationsMockCompatible {
  setRule: { mutate: unknown; isPending?: boolean; isSuccess?: boolean; isError?: boolean };
  clearRule: { mutate: unknown; isPending?: boolean; isSuccess?: boolean; isError?: boolean };
}

// Two overloads sharing an identical parameter list: real call expressions
// always resolve to the FIRST matching overload, so every actual caller sees
// the strict, directly-callable `RecurrenceRuleMutations` return type. The
// second overload only affects `ReturnType<>`-based type computations (see
// `RecurrenceRuleMutationsMockCompatible`'s own comment above).
export function useRecurrenceRuleMutations(
  workspaceId: string,
  objectId: string,
): RecurrenceRuleMutations;
export function useRecurrenceRuleMutations(
  workspaceId: string,
  objectId: string,
): RecurrenceRuleMutationsMockCompatible;
export function useRecurrenceRuleMutations(
  workspaceId: string,
  objectId: string,
): RecurrenceRuleMutations {
  const queryClient = useQueryClient();
  const queryKey: QueryKey = ['object', workspaceId, objectId];

  function getCurrentRecurrenceRule(): RecurrenceRule | undefined {
    const current = queryClient.getQueryData<{ object: ObjectWithFieldValues }>(queryKey);
    return current?.object.recurrenceRule;
  }

  // Builds the next object with `recurrenceRule` either set to the given
  // value or OMITTED entirely (never present-but-undefined) — mirrors
  // `setRecurrenceRuleSchema`'s own controller-side "only write the key if
  // defined" convention, and keeps `ObjectWithFieldValues['recurrenceRule']`
  // (a plain optional field, not `T | undefined`) valid under this repo's
  // `exactOptionalPropertyTypes`. `delete` is legal here because
  // `recurrenceRule` is declared as an OPTIONAL property.
  function updateRecurrenceRule(recurrenceRule: RecurrenceRule | undefined): void {
    queryClient.setQueryData<{ object: ObjectWithFieldValues }>(queryKey, (old) => {
      if (old === undefined) {
        return old;
      }
      const nextObject: ObjectWithFieldValues = { ...old.object };
      if (recurrenceRule !== undefined) {
        nextObject.recurrenceRule = recurrenceRule;
      } else {
        delete nextObject.recurrenceRule;
      }
      return { ...old, object: nextObject };
    });
  }

  const setRule = useMutation<
    { object: ObjectWithFieldValues },
    Error,
    RecurrenceRule,
    SetRuleContext
  >({
    mutationFn: (rule) => setRecurrenceRule(workspaceId, objectId, rule),
    onMutate: async (rule) => {
      await queryClient.cancelQueries({ queryKey });
      const previousRecurrenceRule = getCurrentRecurrenceRule();
      updateRecurrenceRule(rule);
      return { previousRecurrenceRule };
    },
    onError: (_error, _variables, context) => {
      if (context === undefined) {
        return;
      }
      updateRecurrenceRule(context.previousRecurrenceRule);
    },
    onSuccess: (result) => {
      queryClient.setQueryData(queryKey, result);
    },
  });

  // `void` is deliberately used as `TVariables` here (react-query's own
  // default for "no variables", enabling the zero-argument `mutate()` call
  // this file's own contract promises) — typed via a standalone
  // `UseMutationOptions<...>`-annotated variable rather than an explicit
  // `useMutation<...>(...)` call-site generic, because
  // `@typescript-eslint/no-invalid-void-type` (this repo's strict lint
  // config) only recognizes `void` as a valid generic type argument in a
  // TYPE position (e.g. this annotation), not in a call expression's type
  // arguments.
  const clearRuleOptions: UseMutationOptions<
    { object: ObjectWithFieldValues },
    Error,
    void,
    ClearRuleContext
  > = {
    mutationFn: () => clearRecurrenceRule(workspaceId, objectId),
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey });
      const previousRecurrenceRule = getCurrentRecurrenceRule();
      updateRecurrenceRule(undefined);
      return { previousRecurrenceRule };
    },
    onError: (_error, _variables, context) => {
      if (context === undefined) {
        return;
      }
      updateRecurrenceRule(context.previousRecurrenceRule);
    },
    onSuccess: (result) => {
      queryClient.setQueryData(queryKey, result);
    },
  };
  const clearRule = useMutation(clearRuleOptions);

  return { setRule, clearRule };
}
