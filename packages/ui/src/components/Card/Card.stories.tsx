import { Card } from './Card.js';

export const Default = (): React.JSX.Element => (
  <Card style={{ padding: '1rem', maxWidth: '20rem' }}>
    <h3 style={{ margin: 0 }}>Card title</h3>
    <p style={{ margin: '0.5rem 0 0' }}>Some supporting body text lives inside the card.</p>
  </Card>
);
