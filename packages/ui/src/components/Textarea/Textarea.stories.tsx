import { Textarea } from './Textarea.js';

export const Default = (): React.JSX.Element => <Textarea placeholder="Type something…" />;

export const Disabled = (): React.JSX.Element => <Textarea placeholder="Disabled" disabled />;
