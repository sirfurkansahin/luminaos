import { TooltipRoot, TooltipTrigger, TooltipContent } from './Tooltip.js';

// `TooltipProvider` is mounted once globally by `.ladle/components.tsx`, so
// stories only need to compose `TooltipRoot`/`TooltipTrigger`/`TooltipContent`.
export const Default = (): React.JSX.Element => (
  <TooltipRoot>
    <TooltipTrigger>Hover me</TooltipTrigger>
    <TooltipContent>Helpful hint</TooltipContent>
  </TooltipRoot>
);
