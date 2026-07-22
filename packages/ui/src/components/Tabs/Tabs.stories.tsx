import { TabsRoot, TabsList, TabsTrigger, TabsContent } from './Tabs.js';

export const Default = (): React.JSX.Element => (
  <TabsRoot defaultValue="tab1">
    <TabsList aria-label="Example tabs">
      <TabsTrigger value="tab1">Tab One</TabsTrigger>
      <TabsTrigger value="tab2">Tab Two</TabsTrigger>
      <TabsTrigger value="tab3">Tab Three</TabsTrigger>
    </TabsList>
    <TabsContent value="tab1">Content one</TabsContent>
    <TabsContent value="tab2">Content two</TabsContent>
    <TabsContent value="tab3">Content three</TabsContent>
  </TabsRoot>
);
