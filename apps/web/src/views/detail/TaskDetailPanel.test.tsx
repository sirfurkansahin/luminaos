import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FieldDefinition } from '@luminaos/core-objects';

import { TaskDetailPanel } from './TaskDetailPanel.js';
import { useFieldDefinitionsQuery } from '../../hooks/useFieldDefinitionsQuery.js';
import { useObjectIdParam } from '../../hooks/useObjectIdParam.js';
import { useObjectQuery } from '../../hooks/useObjectsQuery.js';

import type { ObjectWithFieldValues } from '../../lib/apiClient.js';

/**
 * Contract under test (not yet implemented — implementer must build
 * apps/web/src/views/detail/TaskDetailPanel.tsx (new directory) to satisfy
 * these tests, plus the two things it depends on that also don't exist yet:
 * apps/web/src/hooks/useObjectIdParam.ts (pinned separately by
 * useObjectIdParam.test.ts) and a new `useObjectQuery(workspaceId, objectId)`
 * export added to apps/web/src/hooks/useObjectsQuery.ts (queryKey
 * `['object', workspaceId, objectId]`, `queryFn: () => getObject(workspaceId,
 * objectId)` — `getObject` itself is a new apps/web/src/lib/apiClient.ts
 * export calling `GET /workspaces/:workspaceId/objects/:objectId`). That's
 * the expected TDD red state — this file fails to even resolve its own
 * `./TaskDetailPanel.js` import until the component exists.
 *
 *   export interface TaskDetailPanelProps {
 *     workspaceId: string;
 *   }
 *   export function TaskDetailPanel(props: TaskDetailPanelProps): React.JSX.Element;
 *
 * A SINGLE top-level instance is mounted once in apps/web/src/App.tsx,
 * alongside (not inside) the List/Table/Board view components — it does NOT
 * take an `objectId` prop; it reads the currently-open object id itself via
 * `useObjectIdParam()` (../../hooks/useObjectIdParam.ts, mocked wholesale
 * below) and fetches it via `useObjectQuery(workspaceId, objectId)`
 * (../../hooks/useObjectsQuery.ts, mocked wholesale below).
 *
 * Built on `@luminaos/ui`'s real (non-mocked) `DialogRoot`/`DialogContent`/
 * `DialogTitle`/`DialogClose` (packages/ui/src/components/Dialog/Dialog.tsx)
 * — `DialogRoot`'s `open` prop is controlled by `objectId !== undefined`, and
 * its `onOpenChange` calls `closeObject()` whenever Radix itself wants to
 * close the dialog (Escape key, or a pointerdown outside the dialog content
 * — both are Radix-owned behaviors we only prove flow through unbroken, the
 * same way packages/ui/src/components/Dialog/Dialog.test.tsx does).
 *
 * States, keyed off `useObjectIdParam()`'s `objectId` and
 * `useObjectQuery(...)`'s `{ data, isLoading, isError }`:
 *
 *   - objectId === undefined        -> dialog stays closed: no
 *                                      `role="dialog"` anywhere in the
 *                                      document.
 *   - objectId defined, isLoading   -> dialog open, content shows a loading
 *                                      skeleton, root discoverable via
 *                                      data-testid="task-detail-panel-loading".
 *   - objectId defined, isError     -> dialog open, content shows a
 *                                      `@luminaos/ui` `EmptyState` "not
 *                                      found" state, discoverable via
 *                                      data-testid="task-detail-panel-not-found".
 *   - objectId defined, success     -> dialog open, the fetched object's
 *                                      `title` (from `data.object.title`) is
 *                                      rendered as text (e.g. inside
 *                                      `DialogTitle`).
 *
 * A close affordance (data-testid="task-detail-panel-close", likely built on
 * `DialogClose`) calls `closeObject()` when clicked. Pressing Escape while
 * the dialog is open, and clicking outside the dialog content (this file
 * clicks `document.body`, which is guaranteed to be outside
 * `DialogContent`'s subtree — Radix's dismissable-layer treats any
 * pointerdown outside the content as an "outside click"), each also
 * ultimately call `closeObject()` via the same `onOpenChange` wiring — no
 * field editors or any other panel content are exercised here (PR6c is
 * infrastructure-only; field editors are a later PR).
 *
 * PR6e ADDENDUM — status/priority field-selector wiring (not exercised by
 * the PR6c tests above, which predate this and are left unmodified): once
 * `useObjectQuery` has resolved successfully, TaskDetailPanel additionally
 * calls `useFieldDefinitionsQuery(workspaceId, data.object.type)`
 * (../../hooks/useFieldDefinitionsQuery.ts, a NEW hook, mocked wholesale
 * below — this file does not exercise its real react-query internals, that
 * is useFieldDefinitionsQuery.test.ts's job) — per that hook's own
 * `objectType: string | undefined` + `enabled` contract, TaskDetailPanel
 * must call it on EVERY render (rules of hooks), passing `undefined` for
 * `objectType` whenever `data` is not yet available (loading/error states),
 * so the hook itself stays disabled until an object has loaded.
 *
 * Once BOTH `useObjectQuery` and `useFieldDefinitionsQuery` have
 * successfully resolved, TaskDetailPanel renders one
 * `StatusPrioritySelect` (./StatusPrioritySelect.js, a NEW component, mocked
 * wholesale below — this file only proves TaskDetailPanel wires it
 * correctly, not its internals, which are separately pinned by
 * StatusPrioritySelect.test.tsx, the same "mock the child wholesale" style
 * BoardView.test.tsx uses for BoardColumn) for the `status` field and one
 * for the `priority` field, each looked up from
 * `fieldDefinitionsQuery.data.fieldDefinitions` by `key`, and given props:
 *
 *   { workspaceId, objectId: data.object.id, fieldKey: 'status' | 'priority',
 *     fieldDefinition: <the matching FieldDefinition>,
 *     currentValue: data.object.fieldValues['status' | 'priority'] }
 *
 * No `StatusPrioritySelect` is rendered while either query has not yet
 * resolved (object loading/error, or field definitions still loading) —
 * PR6c's existing loading/not-found states are otherwise unaffected.
 *
 * PR6f ADDENDUM — checklist widget wiring (not exercised by the PR6c/PR6e
 * tests above, which predate this and are left unmodified): once
 * `useObjectQuery` has resolved successfully, TaskDetailPanel additionally
 * renders one `ChecklistWidget` (./ChecklistWidget.js, a NEW component,
 * mocked wholesale below — this file only proves TaskDetailPanel wires it
 * correctly, not its internals, which are separately pinned by
 * ChecklistWidget.test.tsx, the same "mock the child wholesale" style used
 * for `StatusPrioritySelect` above), given props:
 *
 *   { workspaceId, objectId: data.object.id, items: data.object.checklist }
 *
 * Unlike `StatusPrioritySelect`, `ChecklistWidget` does NOT depend on
 * `useFieldDefinitionsQuery` at all (checklist is embedded object state, not
 * a custom field) — it renders as soon as the object itself has loaded,
 * independent of the field-definitions query's own loading state. No
 * `ChecklistWidget` is rendered while the object is still loading or in the
 * not-found (isError) state — PR6c's existing loading/not-found states are
 * otherwise unaffected.
 */

vi.mock('../../hooks/useObjectIdParam.js', () => ({
  useObjectIdParam: vi.fn(),
}));

vi.mock('../../hooks/useObjectsQuery.js', () => ({
  useObjectQuery: vi.fn(),
}));

vi.mock('../../hooks/useFieldDefinitionsQuery.js', () => ({
  useFieldDefinitionsQuery: vi.fn(),
}));

interface CapturedStatusPrioritySelectProps {
  workspaceId: string;
  objectId: string;
  fieldKey: string;
  fieldDefinition: FieldDefinition;
  currentValue: unknown;
}

const statusPrioritySelectState = vi.hoisted(() => ({
  calls: [] as CapturedStatusPrioritySelectProps[],
}));

vi.mock('./StatusPrioritySelect.js', () => ({
  StatusPrioritySelect: (props: CapturedStatusPrioritySelectProps) => {
    statusPrioritySelectState.calls.push(props);
    return <div data-testid={`status-priority-select-${props.fieldKey}`} />;
  },
}));

interface CapturedChecklistWidgetProps {
  workspaceId: string;
  objectId: string;
  items: ObjectWithFieldValues['checklist'];
}

const checklistWidgetState = vi.hoisted(() => ({
  calls: [] as CapturedChecklistWidgetProps[],
}));

vi.mock('./ChecklistWidget.js', () => ({
  ChecklistWidget: (props: CapturedChecklistWidgetProps) => {
    checklistWidgetState.calls.push(props);
    return <div data-testid="checklist-widget" />;
  },
}));

const mockedUseObjectIdParam = vi.mocked(useObjectIdParam);
const mockedUseObjectQuery = vi.mocked(useObjectQuery);
const mockedUseFieldDefinitionsQuery = vi.mocked(useFieldDefinitionsQuery);

const workspaceId = 'ws-1';

function makeFieldDefinitionFixture(overrides: Partial<FieldDefinition> = {}): FieldDefinition {
  return {
    id: 'field-status',
    workspaceId,
    objectType: 'task',
    key: 'status',
    label: 'Durum',
    fieldType: 'select',
    config: {
      options: [
        { value: 'todo', label: 'Yapılacak' },
        { value: 'done', label: 'Tamamlandı', isDone: true },
      ],
    },
    permissions: { owner: 'edit', admin: 'edit', member: 'edit', guest: 'view' },
    lifecycle: 'active',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

const statusFieldDefinition = makeFieldDefinitionFixture();
const priorityFieldDefinition = makeFieldDefinitionFixture({
  id: 'field-priority',
  key: 'priority',
  label: 'Öncelik',
  config: {
    options: [
      { value: 'low', label: 'Düşük' },
      { value: 'high', label: 'Yüksek' },
    ],
  },
});

function mockFieldDefinitionsNotLoaded(): void {
  mockedUseFieldDefinitionsQuery.mockReturnValue({
    data: undefined,
    isLoading: false,
    isError: false,
    error: null,
  });
}

function mockFieldDefinitionsLoaded(): void {
  mockedUseFieldDefinitionsQuery.mockReturnValue({
    data: { fieldDefinitions: [statusFieldDefinition, priorityFieldDefinition] },
    isLoading: false,
    isError: false,
    error: null,
  });
}

function makeObject(overrides: Partial<ObjectWithFieldValues> = {}): ObjectWithFieldValues {
  return {
    id: 'obj-1',
    type: 'task',
    workspaceId,
    title: 'Design the detail panel',
    createdBy: 'user-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    lifecycle: 'active',
    fieldValues: {},
    ...overrides,
  } as unknown as ObjectWithFieldValues;
}

function mockClosedPanel(): void {
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
}

beforeEach(() => {
  // Safe default for every pre-existing PR6c test below, none of which set
  // up useFieldDefinitionsQuery themselves — without this, the mocked hook
  // would return `undefined` by default and TaskDetailPanel's real
  // implementation (which always calls it, per rules of hooks) would throw
  // trying to destructure it. Mirrors BoardView.test.tsx's beforeEach
  // default-mock pattern.
  mockFieldDefinitionsNotLoaded();
  statusPrioritySelectState.calls = [];
  checklistWidgetState.calls = [];
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('TaskDetailPanel', () => {
  it('renders nothing (no dialog) when useObjectIdParam returns objectId: undefined', () => {
    mockClosedPanel();

    render(<TaskDetailPanel workspaceId={workspaceId} />);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByTestId('task-detail-panel-loading')).not.toBeInTheDocument();
  });

  it('renders a loading skeleton (data-testid="task-detail-panel-loading") while useObjectQuery is loading', async () => {
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

    render(<TaskDetailPanel workspaceId={workspaceId} />);

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByTestId('task-detail-panel-loading')).toBeInTheDocument();
  });

  it("renders the fetched object's title once loaded", async () => {
    mockedUseObjectIdParam.mockReturnValue({
      objectId: 'obj-1',
      openObject: vi.fn(),
      closeObject: vi.fn(),
    });
    mockedUseObjectQuery.mockReturnValue({
      data: { object: makeObject({ title: 'Design the detail panel' }) },
      isLoading: false,
      isError: false,
      error: null,
    });

    render(<TaskDetailPanel workspaceId={workspaceId} />);

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Design the detail panel')).toBeInTheDocument();
  });

  it('renders a not-found EmptyState (data-testid="task-detail-panel-not-found") when the fetch errors (e.g. 404)', async () => {
    mockedUseObjectIdParam.mockReturnValue({
      objectId: 'missing-obj',
      openObject: vi.fn(),
      closeObject: vi.fn(),
    });
    mockedUseObjectQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: Object.assign(new Error('Not found'), { code: 'NOT_FOUND', status: 404 }),
    });

    render(<TaskDetailPanel workspaceId={workspaceId} />);

    expect(await screen.findByTestId('task-detail-panel-not-found')).toBeInTheDocument();
  });

  it('calls closeObject() when the close button (data-testid="task-detail-panel-close") is clicked', async () => {
    const closeObject = vi.fn();
    const user = userEvent.setup();
    mockedUseObjectIdParam.mockReturnValue({
      objectId: 'obj-1',
      openObject: vi.fn(),
      closeObject,
    });
    mockedUseObjectQuery.mockReturnValue({
      data: { object: makeObject() },
      isLoading: false,
      isError: false,
      error: null,
    });

    render(<TaskDetailPanel workspaceId={workspaceId} />);
    await screen.findByRole('dialog');

    await user.click(screen.getByTestId('task-detail-panel-close'));

    expect(closeObject).toHaveBeenCalledTimes(1);
  });

  it('calls closeObject() when Escape is pressed while the panel is open', async () => {
    const closeObject = vi.fn();
    const user = userEvent.setup();
    mockedUseObjectIdParam.mockReturnValue({
      objectId: 'obj-1',
      openObject: vi.fn(),
      closeObject,
    });
    mockedUseObjectQuery.mockReturnValue({
      data: { object: makeObject() },
      isLoading: false,
      isError: false,
      error: null,
    });

    render(<TaskDetailPanel workspaceId={workspaceId} />);
    await screen.findByRole('dialog');

    await user.keyboard('{Escape}');

    expect(closeObject).toHaveBeenCalledTimes(1);
  });

  it('calls closeObject() when clicking outside the dialog content (e.g. the overlay)', async () => {
    const closeObject = vi.fn();
    const user = userEvent.setup();
    mockedUseObjectIdParam.mockReturnValue({
      objectId: 'obj-1',
      openObject: vi.fn(),
      closeObject,
    });
    mockedUseObjectQuery.mockReturnValue({
      data: { object: makeObject() },
      isLoading: false,
      isError: false,
      error: null,
    });

    render(<TaskDetailPanel workspaceId={workspaceId} />);
    await screen.findByRole('dialog');

    // document.body is guaranteed to be outside DialogContent's subtree —
    // Radix's dismissable layer treats any pointerdown outside the content
    // as an "outside click" and fires onOpenChange(false).
    await user.click(document.body);

    expect(closeObject).toHaveBeenCalledTimes(1);
  });

  describe('status/priority field-selector wiring (PR6e)', () => {
    function mockOpenPanel(objectOverrides: Partial<ObjectWithFieldValues> = {}): void {
      mockedUseObjectIdParam.mockReturnValue({
        objectId: 'obj-1',
        openObject: vi.fn(),
        closeObject: vi.fn(),
      });
      mockedUseObjectQuery.mockReturnValue({
        data: {
          object: makeObject({
            fieldValues: { status: 'todo', priority: 'high' },
            ...objectOverrides,
          }),
        },
        isLoading: false,
        isError: false,
        error: null,
      });
    }

    it('does not render any StatusPrioritySelect while the object itself is still loading', () => {
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
      mockFieldDefinitionsLoaded();

      render(<TaskDetailPanel workspaceId={workspaceId} />);

      expect(screen.queryByTestId('status-priority-select-status')).not.toBeInTheDocument();
      expect(screen.queryByTestId('status-priority-select-priority')).not.toBeInTheDocument();
    });

    it('does not render any StatusPrioritySelect while field definitions have not finished loading (object already loaded)', async () => {
      mockOpenPanel();
      mockedUseFieldDefinitionsQuery.mockReturnValue({
        data: undefined,
        isLoading: true,
        isError: false,
        error: null,
      });

      render(<TaskDetailPanel workspaceId={workspaceId} />);
      await screen.findByRole('dialog');

      expect(screen.queryByTestId('status-priority-select-status')).not.toBeInTheDocument();
      expect(screen.queryByTestId('status-priority-select-priority')).not.toBeInTheDocument();
    });

    it('calls useFieldDefinitionsQuery with the workspace id and the loaded object type', async () => {
      mockOpenPanel();
      mockFieldDefinitionsLoaded();

      render(<TaskDetailPanel workspaceId={workspaceId} />);
      await screen.findByRole('dialog');

      expect(mockedUseFieldDefinitionsQuery).toHaveBeenCalledWith(workspaceId, 'task');
    });

    it('renders one StatusPrioritySelect for "status" and one for "priority" once both queries have loaded', async () => {
      mockOpenPanel();
      mockFieldDefinitionsLoaded();

      render(<TaskDetailPanel workspaceId={workspaceId} />);
      await screen.findByRole('dialog');

      expect(await screen.findByTestId('status-priority-select-status')).toBeInTheDocument();
      expect(screen.getByTestId('status-priority-select-priority')).toBeInTheDocument();
    });

    it('wires the "status" StatusPrioritySelect with the correct props (workspaceId, objectId, fieldKey, fieldDefinition, currentValue)', async () => {
      mockOpenPanel();
      mockFieldDefinitionsLoaded();

      render(<TaskDetailPanel workspaceId={workspaceId} />);
      await screen.findByTestId('status-priority-select-status');

      const statusCall = statusPrioritySelectState.calls.find((call) => call.fieldKey === 'status');
      expect(statusCall).toEqual({
        workspaceId,
        objectId: 'obj-1',
        fieldKey: 'status',
        fieldDefinition: statusFieldDefinition,
        currentValue: 'todo',
      });
    });

    it('wires the "priority" StatusPrioritySelect with the correct props (workspaceId, objectId, fieldKey, fieldDefinition, currentValue)', async () => {
      mockOpenPanel();
      mockFieldDefinitionsLoaded();

      render(<TaskDetailPanel workspaceId={workspaceId} />);
      await screen.findByTestId('status-priority-select-priority');

      const priorityCall = statusPrioritySelectState.calls.find(
        (call) => call.fieldKey === 'priority',
      );
      expect(priorityCall).toEqual({
        workspaceId,
        objectId: 'obj-1',
        fieldKey: 'priority',
        fieldDefinition: priorityFieldDefinition,
        currentValue: 'high',
      });
    });

    it('does not render any StatusPrioritySelect in the not-found (isError) state, even if field definitions happen to be cached', async () => {
      mockedUseObjectIdParam.mockReturnValue({
        objectId: 'missing-obj',
        openObject: vi.fn(),
        closeObject: vi.fn(),
      });
      mockedUseObjectQuery.mockReturnValue({
        data: undefined,
        isLoading: false,
        isError: true,
        error: Object.assign(new Error('Not found'), { code: 'NOT_FOUND', status: 404 }),
      });
      mockFieldDefinitionsLoaded();

      render(<TaskDetailPanel workspaceId={workspaceId} />);
      await screen.findByTestId('task-detail-panel-not-found');

      expect(screen.queryByTestId('status-priority-select-status')).not.toBeInTheDocument();
      expect(screen.queryByTestId('status-priority-select-priority')).not.toBeInTheDocument();
    });
  });

  describe('checklist widget wiring (PR6f)', () => {
    const checklist: ObjectWithFieldValues['checklist'] = [
      { id: 'item-1', text: 'Write tests', done: false, order: 0 },
      { id: 'item-2', text: 'Ship it', done: true, order: 1 },
    ];

    function mockOpenPanelWithChecklist(): void {
      mockedUseObjectIdParam.mockReturnValue({
        objectId: 'obj-1',
        openObject: vi.fn(),
        closeObject: vi.fn(),
      });
      mockedUseObjectQuery.mockReturnValue({
        data: { object: makeObject({ checklist }) },
        isLoading: false,
        isError: false,
        error: null,
      });
    }

    it('does not render a ChecklistWidget while the object itself is still loading', () => {
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

      render(<TaskDetailPanel workspaceId={workspaceId} />);

      expect(screen.queryByTestId('checklist-widget')).not.toBeInTheDocument();
    });

    it('does not render a ChecklistWidget in the not-found (isError) state', async () => {
      mockedUseObjectIdParam.mockReturnValue({
        objectId: 'missing-obj',
        openObject: vi.fn(),
        closeObject: vi.fn(),
      });
      mockedUseObjectQuery.mockReturnValue({
        data: undefined,
        isLoading: false,
        isError: true,
        error: Object.assign(new Error('Not found'), { code: 'NOT_FOUND', status: 404 }),
      });

      render(<TaskDetailPanel workspaceId={workspaceId} />);
      await screen.findByTestId('task-detail-panel-not-found');

      expect(screen.queryByTestId('checklist-widget')).not.toBeInTheDocument();
    });

    it('renders a ChecklistWidget once the object has loaded, independent of field-definitions loading state', async () => {
      mockOpenPanelWithChecklist();
      // Deliberately left NOT loaded (mockFieldDefinitionsNotLoaded, the
      // beforeEach default) — ChecklistWidget must not wait on
      // useFieldDefinitionsQuery the way StatusPrioritySelect does, since
      // checklist is embedded object state, not a custom field.

      render(<TaskDetailPanel workspaceId={workspaceId} />);

      expect(await screen.findByTestId('checklist-widget')).toBeInTheDocument();
    });

    it('wires ChecklistWidget with the correct props (workspaceId, objectId, items)', async () => {
      mockOpenPanelWithChecklist();

      render(<TaskDetailPanel workspaceId={workspaceId} />);
      await screen.findByTestId('checklist-widget');

      expect(checklistWidgetState.calls.at(-1)).toEqual({
        workspaceId,
        objectId: 'obj-1',
        items: checklist,
      });
    });
  });
});
