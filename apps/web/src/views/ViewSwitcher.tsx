import { TabsList, TabsRoot, TabsTrigger } from '@luminaos/ui';

import { useViewParam } from '../hooks/useViewParam.js';

import type { ViewKind } from '../hooks/useViewParam.js';

export function ViewSwitcher() {
  const { view, setView } = useViewParam();

  return (
    <TabsRoot
      value={view}
      onValueChange={(next) => {
        setView(next as ViewKind);
      }}
    >
      <TabsList aria-label="Görünüm seç">
        <TabsTrigger value="list" data-testid="view-tab-list">
          Liste
        </TabsTrigger>
        <TabsTrigger value="board" data-testid="view-tab-board">
          Pano
        </TabsTrigger>
        <TabsTrigger value="table" data-testid="view-tab-table">
          Tablo
        </TabsTrigger>
      </TabsList>
    </TabsRoot>
  );
}
