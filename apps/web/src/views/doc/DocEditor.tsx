import { withCollaboration } from '@blocknote/core/yjs';
import { BlockNoteView } from '@blocknote/mantine';
import { useCreateBlockNote } from '@blocknote/react';
import { useEffect, useMemo } from 'react';
import * as Y from 'yjs';

import { buildDocWsUrl, DocGatewayProvider } from '../../lib/gateway-provider.js';

import type { CollaborationOptions } from '@blocknote/core/yjs';

/**
 * F1-T11 PR6 — the collaborative block-based document editor view. Owns exactly
 * one `Y.Doc` + one `DocGatewayProvider` per `docId`, wiring them into
 * BlockNote's realtime collaboration. The provider is destroyed (and both
 * recreated) whenever `docId` changes or the component unmounts.
 */

export interface DocEditorProps {
  docId: string;
}

// The Yjs XML fragment key BlockNote reads/writes its document into.
const FRAGMENT_KEY = 'document-store';

// Placeholder awareness palette until real user identity lands (mirrors the
// app's DEV_WORKSPACE_ID stopgap — real identity/auth wiring is future work).
const CURSOR_COLORS = ['#f97316', '#22c55e', '#3b82f6', '#a855f7', '#ec4899', '#14b8a6'] as const;

function randomIdentity(): { name: string; color: string } {
  const suffix = Math.floor(Math.random() * 10_000)
    .toString()
    .padStart(4, '0');
  const color = CURSOR_COLORS[Math.floor(Math.random() * CURSOR_COLORS.length)] ?? CURSOR_COLORS[0];
  return { name: `User ${suffix}`, color };
}

export function DocEditor({ docId }: DocEditorProps) {
  // One Y.Doc + provider per docId, stable across re-renders and recreated when
  // docId changes (the useEffect cleanup below tears the previous pair down).
  const { ydoc, provider } = useMemo(() => {
    const doc = new Y.Doc();
    return { ydoc: doc, provider: new DocGatewayProvider(buildDocWsUrl(docId), doc) };
  }, [docId]);

  useEffect(() => {
    return () => {
      provider.destroy();
      ydoc.destroy();
    };
  }, [ydoc, provider]);

  // Placeholder local identity — regenerated only if it hadn't been created yet.
  const user = useMemo(() => randomIdentity(), []);

  // BlockNote 0.52 activates realtime collaboration via `withCollaboration`,
  // which injects the Yjs collaboration extension (cursors from the provider's
  // awareness, edits synced through the shared XML fragment). Passing a bare
  // `collaboration` option to `useCreateBlockNote` is a no-op in 0.52 — the
  // extension is only wired through this wrapper (backed by `y-prosemirror`).
  const collaboration: CollaborationOptions = {
    provider,
    fragment: ydoc.getXmlFragment(FRAGMENT_KEY),
    user,
  };

  const editor = useCreateBlockNote(withCollaboration({ collaboration }));

  return (
    <div data-testid="doc-editor">
      <BlockNoteView
        // BlockNote 0.52's editor type does not satisfy BlockNoteView's own
        // editor-prop schema constraint under `exactOptionalPropertyTypes`; this
        // reproduces even for a bare `useCreateBlockNote()` editor and is a
        // purely-structural upstream typing quirk (the runtime schemas match).
        // @ts-expect-error upstream BlockNote 0.52 <-> exactOptionalPropertyTypes incompatibility
        editor={editor}
      />
    </div>
  );
}
