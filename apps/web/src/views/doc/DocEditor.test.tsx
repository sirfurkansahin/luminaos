import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

import { DocEditor } from './DocEditor.js';
import { buildDocWsUrl } from '../../lib/gateway-provider.js';

/**
 * F1-T11 PR6 (RED step) — the collaborative block-based document editor view.
 * This file pins the contract of a component that does NOT exist yet
 * (apps/web/src/views/doc/DocEditor.tsx), so every case here is expected to
 * fail purely because `./DocEditor.js` cannot be resolved until the implementer
 * creates it. That is the intended TDD red state.
 *
 * Contract under test (implementer must build to satisfy):
 *
 *   export interface DocEditorProps { docId: string }
 *   export function DocEditor(props: DocEditorProps): React.JSX.Element;
 *
 * Behaviour pinned:
 *   - Creates ONE `Y.Doc` per `docId` and ONE
 *     `DocGatewayProvider(buildDocWsUrl(docId), ydoc)`
 *     (../../lib/gateway-provider.js, mocked wholesale below). Both are stable
 *     across re-renders for the same docId, and are DESTROYED (provider first)
 *     and recreated whenever `docId` changes or the component unmounts.
 *   - Derives a local awareness identity `user: { name: string; color: string }`
 *     — a placeholder (no real auth yet, matching the app's DEV_WORKSPACE_ID
 *     stopgap).
 *   - Calls BlockNote's `useCreateBlockNote` (`@blocknote/react`, mocked) with
 *     `{ collaboration: { provider, fragment: ydoc.getXmlFragment('document-store'),
 *     user } }` and renders `<BlockNoteView editor={editor} />`
 *     (`@blocknote/mantine`, mocked) inside a container with
 *     data-testid="doc-editor".
 *
 * Everything the component composes is mocked wholesale (the provider — pinned
 * separately by gateway-provider.test.ts — and both BlockNote packages), so
 * this file exercises only DocEditor's own wiring/lifecycle. `yjs` is REAL, so
 * the `fragment` passed into the collaboration option is a genuine
 * `Y.XmlFragment`.
 */

interface ProviderInstance {
  wsUrl: string;
  doc: unknown;
  awareness: Record<string, unknown>;
  destroy: ReturnType<typeof vi.fn>;
}

const providerState = vi.hoisted(() => ({
  constructorCalls: [] as Array<{ wsUrl: string; doc: unknown }>,
  instances: [] as ProviderInstance[],
}));

const blockNoteState = vi.hoisted(() => ({
  calls: [] as Array<Record<string, unknown>>,
  editor: { __sentinel: 'blocknote-editor' },
}));

// BlockNote 0.52 only activates collaboration through `withCollaboration`
// (`@blocknote/core/yjs`); a bare `collaboration` option is ignored. Mock it as
// a pass-through spy so we can assert the collaboration config genuinely flows
// through the REAL wiring path (not the no-op static option).
const collabState = vi.hoisted(() => ({
  calls: [] as Array<Record<string, unknown>>,
}));

vi.mock('@blocknote/core/yjs', () => ({
  withCollaboration: vi.fn((options: Record<string, unknown>) => {
    collabState.calls.push(options);
    return options;
  }),
}));

vi.mock('../../lib/gateway-provider.js', () => {
  const buildDocWsUrlMock = vi.fn(
    (docId: string): string => `ws://mock/ws/docs?docId=${encodeURIComponent(docId)}`,
  );

  class DocGatewayProviderMock {
    readonly wsUrl: string;
    readonly doc: unknown;
    readonly awareness: Record<string, unknown> = { setLocalStateField: vi.fn() };
    readonly destroy = vi.fn();

    constructor(wsUrl: string, doc: unknown) {
      this.wsUrl = wsUrl;
      this.doc = doc;
      providerState.constructorCalls.push({ wsUrl, doc });
      providerState.instances.push(this);
    }
  }

  return { buildDocWsUrl: buildDocWsUrlMock, DocGatewayProvider: DocGatewayProviderMock };
});

vi.mock('@blocknote/react', () => ({
  useCreateBlockNote: vi.fn((options: Record<string, unknown>) => {
    blockNoteState.calls.push(options);
    return blockNoteState.editor;
  }),
}));

vi.mock('@blocknote/mantine', () => ({
  BlockNoteView: vi.fn(() => <div data-testid="blocknote-view" />),
}));

const mockedBuildDocWsUrl = vi.mocked(buildDocWsUrl);

const DOC_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

beforeEach(() => {
  providerState.constructorCalls = [];
  providerState.instances = [];
  blockNoteState.calls = [];
  collabState.calls = [];
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('DocEditor', () => {
  it('renders a doc-editor container wrapping the (mocked) BlockNoteView', () => {
    render(<DocEditor docId={DOC_ID} />);

    expect(screen.getByTestId('doc-editor')).toBeInTheDocument();
    expect(screen.getByTestId('blocknote-view')).toBeInTheDocument();
  });

  it('constructs a DocGatewayProvider with buildDocWsUrl(docId)', () => {
    render(<DocEditor docId={DOC_ID} />);

    expect(mockedBuildDocWsUrl).toHaveBeenCalledWith(DOC_ID);
    expect(providerState.constructorCalls).toHaveLength(1);
    expect(providerState.constructorCalls[0]?.wsUrl).toBe(
      `ws://mock/ws/docs?docId=${encodeURIComponent(DOC_ID)}`,
    );
  });

  it('activates collaboration via withCollaboration with (provider, XmlFragment, user)', () => {
    render(<DocEditor docId={DOC_ID} />);

    // The collaboration config must flow through withCollaboration — the ONLY
    // path that actually activates BlockNote 0.52 collaboration at runtime.
    const wrapped = collabState.calls.at(-1);
    expect(wrapped).toBeDefined();

    const collaboration = wrapped?.collaboration as
      { provider: unknown; fragment: unknown; user: { name: unknown; color: unknown } } | undefined;
    expect(collaboration).toBeDefined();

    // provider passed to BlockNote is the very instance DocEditor created.
    expect(collaboration?.provider).toBe(providerState.instances[0]);
    // fragment is a real Y.XmlFragment (from ydoc.getXmlFragment('document-store')).
    expect(collaboration?.fragment).toBeInstanceOf(Y.XmlFragment);
    // placeholder identity — name/color are strings.
    expect(typeof collaboration?.user.name).toBe('string');
    expect(typeof collaboration?.user.color).toBe('string');

    // useCreateBlockNote receives withCollaboration's (wrapped) result.
    expect(blockNoteState.calls.at(-1)).toBe(wrapped);
  });

  it('destroys the provider on unmount', () => {
    const { unmount } = render(<DocEditor docId={DOC_ID} />);
    const provider = providerState.instances[0];
    expect(provider).toBeDefined();

    unmount();

    expect(provider?.destroy).toHaveBeenCalledTimes(1);
  });

  it('tears down the old provider and constructs a new one when docId changes', () => {
    const { rerender } = render(<DocEditor docId={DOC_ID} />);
    const firstProvider = providerState.instances[0];
    expect(firstProvider).toBeDefined();

    const nextDocId = '01BX5ZZKBKACTAV9WEVGEMMVRZ';
    rerender(<DocEditor docId={nextDocId} />);

    expect(firstProvider?.destroy).toHaveBeenCalledTimes(1);
    expect(providerState.constructorCalls).toHaveLength(2);
    expect(mockedBuildDocWsUrl).toHaveBeenCalledWith(nextDocId);
    expect(providerState.constructorCalls[1]?.wsUrl).toBe(
      `ws://mock/ws/docs?docId=${encodeURIComponent(nextDocId)}`,
    );
  });
});
