import { useState } from 'react';

import {
  Badge,
  Button,
  Card,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogRoot,
  DialogTitle,
  DialogTrigger,
  Input,
  useTheme,
} from '@luminaos/ui';

export function App() {
  const { theme, toggleTheme } = useTheme();
  const [name, setName] = useState('');

  return (
    <main>
      <h1>LuminaOS</h1>

      <Button data-testid="theme-toggle" variant="ghost" onClick={toggleTheme}>
        Toggle theme ({theme})
      </Button>

      <Card>
        <h2>Welcome</h2>
        <p>This is a design-system preview surface for the LuminaOS web app.</p>

        <Badge variant="success">v0</Badge>

        <Input
          value={name}
          onChange={(event) => {
            setName(event.target.value);
          }}
          placeholder="Your name"
          aria-label="Your name"
        />

        <div>
          <Button variant="primary">Primary action</Button>
          <Button variant="secondary">Secondary action</Button>
        </div>

        <DialogRoot>
          <DialogTrigger asChild>
            <Button variant="destructive">Open dialog</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogTitle>Confirm action</DialogTitle>
            <DialogDescription>
              This is a demo dialog showing the design system&apos;s Radix-based Dialog component.
            </DialogDescription>
            <DialogClose asChild>
              <Button variant="secondary">Close</Button>
            </DialogClose>
          </DialogContent>
        </DialogRoot>
      </Card>
    </main>
  );
}
