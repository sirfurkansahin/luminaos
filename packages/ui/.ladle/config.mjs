// Ladle config — see https://ladle.dev/docs/config for the full schema.
// `stories`/CSS-Module handling both already match Ladle's own defaults
// (`src/**/*.stories.{js,jsx,ts,tsx,mdx}`, Vite's native `.module.css`
// support), so this file only needs to exist to anchor the `.ladle/`
// config folder — kept explicit for discoverability.

/** @type {import('@ladle/react').UserConfig} */
export default {
  stories: 'src/**/*.stories.tsx',
};
