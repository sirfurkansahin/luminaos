import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ObjectDetailHost } from './ObjectDetailHost.js';
import { useObjectIdParam } from '../../hooks/useObjectIdParam.js';
import { useObjectQuery } from '../../hooks/useObjectsQuery.js';

import type { ObjectWithFieldValues } from '../../lib/apiClient.js';

/**
 * F1-T11 PR7 (RED step) — the dispatcher that decides, for the currently-open
 * object, whether to show the collaborative doc editor or the existing task
 * detail panel. This file pins the contract of a component that does NOT exist
 * yet (apps/web/src/views/detail/ObjectDetailHost.tsx), so every case here
 * fails purely because `./ObjectDetailHost.js` cannot be resolved until the
 * implementer creates it. That is the intended TDD red state.
 *
 * Contract under test (implementer must build to satisfy):
 *
 *   export interface ObjectDetailHostProps {
 *     workspaceId: string;
 *   }
 *   export function ObjectDetailHost(props: ObjectDetailHostProps): React.JSX.Element;
 *
 * Behaviour pinned (reads the open object id itself via `useObjectIdParam()`,
 * ../../hooks/useObjectIdParam.js, mocked wholesale below, and fetches it via
 * `useObjectQuery(workspaceId, objectId)`, ../../hooks/useObjectsQuery.js,
 * mocked wholesale below):
 *
 *   - objectId defined AND data?.object.type === 'doc'  -> renders
 *     `<DocEditorPanel docId={objectId} title={data.object.title}
 *     onClose={closeObject} />` (../doc/DocEditorPanel.js, mocked wholesale
 *     below) and does NOT render TaskDetailPanel.
 *   - otherwise (task type, loading/`data` undefined, error, or no objectId)
 *     -> renders `<TaskDetailPanel workspaceId={workspaceId} />`
 *     (./TaskDetailPanel.js, mocked wholesale below — it internally handles its
 *     own objectId/loading/error/closed states) and NOT the doc panel.
 *
 * Children are mocked wholesale (the "mock the child wholesale" style
 * TaskDetailPanel.test.tsx uses for StatusPrioritySelect) so this file
 * exercises only ObjectDetailHost's dispatch logic, not the children's
 * internals (which are pinned by DocEditorPanel.test.tsx and
 * TaskDetailPanel.test.tsx).
 */

vi.mock('../../hooks/useObjectIdParam.js', () => ({
  useObjectIdParam: vi.fn(),
}));

vi.mock('../../hooks/useObjectsQuery.js', () => ({
  useObjectQuery: vi.fn(),
}));

interface CapturedDocEditorPanelProps {
  docId: string;
  title: string;
  onClose: () => void;
}

const docEditorPanelState = vi.hoisted(() => ({
  calls: [] as CapturedDocEditorPanelProps[],
}));

vi.mock('../doc/DocEditorPanel.js', () => ({
  DocEditorPanel: (props: CapturedDocEditorPanelProps) => {
    docEditorPanelState.calls.push(props);
    return <div data-testid="doc-editor-panel-mock" data-docid={props.docId} />;
  },
}));

vi.mock('./TaskDetailPanel.js', () => ({
  TaskDetailPanel: () => <div data-testid="task-detail-panel-mock" />,
}));

const mockedUseObjectIdParam = vi.mocked(useObjectIdParam);
const mockedUseObjectQuery = vi.mocked(useObjectQuery);

const workspaceId = 'ws-1';

function makeObject(overrides: Partial<ObjectWithFieldValues> = {}): ObjectWithFieldValues {
  return {
    id: 'obj-1',
    type: 'task',
    workspaceId,
    title: 'Some object',
    createdBy: 'user-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    lifecycle: 'active',
    fieldValues: {},
    ...overrides,
  } as unknown as ObjectWithFieldValues;
}

beforeEach(() => {
  docEditorPanelState.calls = [];
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('ObjectDetailHost', () => {
  it('renders DocEditorPanel (and not TaskDetailPanel) when the open object is a doc', () => {
    const closeObject = vi.fn();
    mockedUseObjectIdParam.mockReturnValue({
      objectId: 'doc-1',
      openObject: vi.fn(),
      closeObject,
    });
    mockedUseObjectQuery.mockReturnValue({
      data: { object: makeObject({ id: 'doc-1', type: 'doc', title: 'Product spec' }) },
      isLoading: false,
      isError: false,
      error: null,
    });

    render(<ObjectDetailHost workspaceId={workspaceId} />);

    const panel = screen.getByTestId('doc-editor-panel-mock');
    expect(panel).toBeInTheDocument();
    expect(panel).toHaveAttribute('data-docid', 'doc-1');
    expect(screen.queryByTestId('task-detail-panel-mock')).not.toBeInTheDocument();

    const call = docEditorPanelState.calls.at(-1);
    expect(call?.title).toBe('Product spec');
    expect(typeof call?.onClose).toBe('function');
  });

  it('renders TaskDetailPanel (and not DocEditorPanel) when the open object is a task', () => {
    mockedUseObjectIdParam.mockReturnValue({
      objectId: 'task-1',
      openObject: vi.fn(),
      closeObject: vi.fn(),
    });
    mockedUseObjectQuery.mockReturnValue({
      data: { object: makeObject({ id: 'task-1', type: 'task' }) },
      isLoading: false,
      isError: false,
      error: null,
    });

    render(<ObjectDetailHost workspaceId={workspaceId} />);

    expect(screen.getByTestId('task-detail-panel-mock')).toBeInTheDocument();
    expect(screen.queryByTestId('doc-editor-panel-mock')).not.toBeInTheDocument();
  });

  it('renders TaskDetailPanel (generic fallback) while the object is still loading (data undefined)', () => {
    mockedUseObjectIdParam.mockReturnValue({
      objectId: 'obj-1',
      openObject: vi.fn(),
      closeObject: vi.fn(),
    });
    mockedUseObjectQuery.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
      error: null,
    });

    render(<ObjectDetailHost workspaceId={workspaceId} />);

    expect(screen.getByTestId('task-detail-panel-mock')).toBeInTheDocument();
    expect(screen.queryByTestId('doc-editor-panel-mock')).not.toBeInTheDocument();
  });

  it('renders TaskDetailPanel (which shows nothing when closed) when no object is open', () => {
    mockedUseObjectIdParam.mockReturnValue({
      objectId: undefined,
      openObject: vi.fn(),
      closeObject: vi.fn(),
    });
    mockedUseObjectQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
      error: null,
    });

    render(<ObjectDetailHost workspaceId={workspaceId} />);

    expect(screen.getByTestId('task-detail-panel-mock')).toBeInTheDocument();
    expect(screen.queryByTestId('doc-editor-panel-mock')).not.toBeInTheDocument();
  });

  it('passes closeObject from useObjectIdParam as DocEditorPanel onClose', () => {
    const closeObject = vi.fn();
    mockedUseObjectIdParam.mockReturnValue({
      objectId: 'doc-1',
      openObject: vi.fn(),
      closeObject,
    });
    mockedUseObjectQuery.mockReturnValue({
      data: { object: makeObject({ id: 'doc-1', type: 'doc', title: 'Product spec' }) },
      isLoading: false,
      isError: false,
      error: null,
    });

    render(<ObjectDetailHost workspaceId={workspaceId} />);

    const call = docEditorPanelState.calls.at(-1);
    expect(call).toBeDefined();
    call?.onClose();
    expect(closeObject).toHaveBeenCalledTimes(1);
  });
});
