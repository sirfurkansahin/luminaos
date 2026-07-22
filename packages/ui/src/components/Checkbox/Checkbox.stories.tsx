import { Checkbox } from './Checkbox.js';

export const Default = (): React.JSX.Element => <Checkbox aria-label="Accept terms" />;

export const Checked = (): React.JSX.Element => (
  <Checkbox aria-label="Accept terms" defaultChecked />
);
