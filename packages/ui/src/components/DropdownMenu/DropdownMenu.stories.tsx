import {
  DropdownMenuRoot,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from './DropdownMenu.js';

export const Default = (): React.JSX.Element => (
  <DropdownMenuRoot>
    <DropdownMenuTrigger>Open menu</DropdownMenuTrigger>
    <DropdownMenuContent>
      <DropdownMenuItem>First item</DropdownMenuItem>
      <DropdownMenuItem>Second item</DropdownMenuItem>
      <DropdownMenuItem>Third item</DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenuRoot>
);
