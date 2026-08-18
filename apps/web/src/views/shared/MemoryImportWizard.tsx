import { useState } from 'react';

import { Button, DialogContent, DialogRoot, DialogTitle } from '@luminaos/ui';

import { useCreateMemoryRecordMutation } from '../../hooks/useMemoryRecordsQuery.js';
import { parseImportInput } from '../../lib/parseImportInput.js';

export interface MemoryImportWizardProps {
  workspaceId: string;
}

type WizardStep = 'paste' | 'preview' | 'result';

interface ImportOutcome {
  content: string;
  success: boolean;
}

/**
 * F2-T7 PR2 (ADR-0023 §a/f) — generic-format memory import wizard. 3-step
 * flow: paste raw text/JSON -> preview parsed items -> import each item via
 * `useCreateMemoryRecordMutation`, showing per-item success/failure so a
 * partial failure is never silently swallowed.
 */
export function MemoryImportWizard({ workspaceId }: MemoryImportWizardProps) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<WizardStep>('paste');
  const [pastedText, setPastedText] = useState('');
  const [parsedItems, setParsedItems] = useState<string[]>([]);
  const [outcomes, setOutcomes] = useState<ImportOutcome[]>([]);

  const createMutation = useCreateMemoryRecordMutation(workspaceId);

  function resetWizard(): void {
    setStep('paste');
    setPastedText('');
    setParsedItems([]);
    setOutcomes([]);
  }

  function handleContinue(): void {
    const items = parseImportInput(pastedText);
    setParsedItems(items);
    setStep('preview');
  }

  async function handleConfirm(): Promise<void> {
    const settled = await Promise.allSettled(
      parsedItems.map((content) => createMutation.mutateAsync({ content })),
    );

    setOutcomes(
      settled.map((result, index) => ({
        content: parsedItems[index] ?? '',
        success: result.status === 'fulfilled',
      })),
    );
    setStep('result');
  }

  function renderPasteStep(): React.JSX.Element {
    const isContinueDisabled = pastedText.trim().length === 0;

    return (
      <div>
        <textarea
          data-testid="memory-import-textarea"
          value={pastedText}
          onChange={(event) => {
            setPastedText(event.target.value);
          }}
        />
        <Button
          type="button"
          data-testid="memory-import-continue"
          disabled={isContinueDisabled}
          onClick={handleContinue}
        >
          Devam Et
        </Button>
      </div>
    );
  }

  function renderPreviewStep(): React.JSX.Element {
    return (
      <div data-testid="memory-import-preview">
        <p data-testid="memory-import-preview-count">{parsedItems.length} kayıt bulundu</p>
        <ul>
          {parsedItems.map((item, index) => (
            <li
              key={`${String(index)}-${item}`}
              data-testid={`memory-import-preview-item-${String(index)}`}
            >
              {item}
            </li>
          ))}
        </ul>
        <Button
          type="button"
          data-testid="memory-import-confirm"
          onClick={() => {
            void handleConfirm();
          }}
        >
          İçe Aktar
        </Button>
      </div>
    );
  }

  function renderResultStep(): React.JSX.Element {
    const successCount = outcomes.filter((outcome) => outcome.success).length;
    const failureCount = outcomes.length - successCount;

    return (
      <div data-testid="memory-import-result">
        <p data-testid="memory-import-result-summary">
          {successCount} başarılı, {failureCount} başarısız
        </p>
        <ul>
          {outcomes.map((outcome, index) =>
            outcome.success ? (
              <li
                key={`${String(index)}-${outcome.content}`}
                data-testid={`memory-import-result-success-${String(index)}`}
              >
                {outcome.content}
              </li>
            ) : (
              <li
                key={`${String(index)}-${outcome.content}`}
                data-testid={`memory-import-result-failure-${String(index)}`}
              >
                {outcome.content}
              </li>
            ),
          )}
        </ul>
      </div>
    );
  }

  function renderStep(): React.JSX.Element {
    if (step === 'preview') {
      return renderPreviewStep();
    }
    if (step === 'result') {
      return renderResultStep();
    }
    return renderPasteStep();
  }

  return (
    <>
      <Button
        type="button"
        data-testid="memory-import-trigger"
        onClick={() => {
          resetWizard();
          setOpen(true);
        }}
      >
        Bellek Kayıtlarını İçe Aktar
      </Button>
      <DialogRoot open={open} onOpenChange={setOpen}>
        <DialogContent data-testid="memory-import-dialog">
          <DialogTitle>Bellek Kayıtlarını İçe Aktar</DialogTitle>
          {renderStep()}
          <Button
            type="button"
            variant="secondary"
            data-testid="memory-import-close"
            onClick={() => {
              setOpen(false);
            }}
          >
            Kapat
          </Button>
        </DialogContent>
      </DialogRoot>
    </>
  );
}
