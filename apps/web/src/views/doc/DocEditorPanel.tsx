import { DialogRoot, DialogContent, DialogTitle, DialogClose } from '@luminaos/ui';

import { DocEditor } from './DocEditor.js';

export interface DocEditorPanelProps {
  docId: string;
  title: string;
  onClose: () => void;
}

export function DocEditorPanel({ docId, title, onClose }: DocEditorPanelProps) {
  return (
    <DialogRoot
      open={true}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <DialogContent>
        <DialogTitle>{title}</DialogTitle>
        <DocEditor docId={docId} />
        <DialogClose data-testid="doc-editor-panel-close">Kapat</DialogClose>
      </DialogContent>
    </DialogRoot>
  );
}
