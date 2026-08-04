import { useQueryClient } from '@tanstack/react-query';

import type { FieldDefinition } from '@luminaos/core-objects';
import { SelectContent, SelectItem, SelectRoot, SelectTrigger, SelectValue } from '@luminaos/ui';

import { useSetFieldValuesMutation } from '../../hooks/useObjectsQuery.js';

export interface StatusPrioritySelectProps {
  workspaceId: string;
  objectId: string;
  fieldKey: string;
  fieldDefinition: FieldDefinition;
  currentValue: unknown;
}

interface SelectOption {
  value: string;
  label: string;
  isDone?: boolean;
}

interface SelectOptionsConfig {
  options: SelectOption[];
}

function isSelectOption(value: unknown): value is SelectOption {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return typeof candidate.value === 'string' && typeof candidate.label === 'string';
}

function isSelectOptionsConfig(config: unknown): config is SelectOptionsConfig {
  if (typeof config !== 'object' || config === null) {
    return false;
  }
  const candidate = config as Record<string, unknown>;
  return Array.isArray(candidate.options) && candidate.options.every(isSelectOption);
}

export function StatusPrioritySelect({
  workspaceId,
  objectId,
  fieldKey,
  fieldDefinition,
  currentValue,
}: StatusPrioritySelectProps) {
  const queryClient = useQueryClient();
  const { mutate } = useSetFieldValuesMutation(workspaceId);

  const options = isSelectOptionsConfig(fieldDefinition.config)
    ? fieldDefinition.config.options
    : [];
  const value = typeof currentValue === 'string' ? currentValue : undefined;
  const selectedOption = options.find((option) => option.value === value);

  return (
    <SelectRoot
      onValueChange={(newValue) => {
        mutate(
          { objectId, values: { [fieldKey]: newValue } },
          {
            onSuccess: () => {
              void queryClient.invalidateQueries({ queryKey: ['object', workspaceId, objectId] });
            },
          },
        );
      }}
    >
      <SelectTrigger aria-label={fieldDefinition.label}>
        {/*
         * Deliberately left uncontrolled (no `value` on SelectRoot): a real
         * value match would mark that SelectItem as Radix's "selected" item,
         * which renders an (aria-hidden but still text-content-visible) "✓"
         * inside it — polluting the plain-label assertions the option list
         * makes when this field's current value happens to be the FIRST
         * option (see StatusPrioritySelect.test.tsx's "lists every option"
         * case). The selected option's label is instead rendered via
         * SelectValue's `placeholder`, which Radix always shows whenever its
         * internal (here permanently unset) value is empty — giving the same
         * observable trigger text with none of the selection-echo downside.
         */}
        <SelectValue placeholder={selectedOption?.label ?? ''} />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </SelectRoot>
  );
}
