import { SelectRoot, SelectTrigger, SelectValue, SelectContent, SelectItem } from './Select.js';

export const Default = (): React.JSX.Element => (
  <SelectRoot defaultValue="apple">
    <SelectTrigger aria-label="Fruit">
      <SelectValue placeholder="Select a fruit" />
    </SelectTrigger>
    <SelectContent>
      <SelectItem value="apple">Apple</SelectItem>
      <SelectItem value="banana">Banana</SelectItem>
      <SelectItem value="cherry">Cherry</SelectItem>
    </SelectContent>
  </SelectRoot>
);
