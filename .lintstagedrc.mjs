export default {
  '*.{ts,tsx,js,jsx,json,md}': ['prettier --write'],
  '*.{ts,tsx}': ['eslint --fix'],
  '**/*.{ts,tsx}': () => 'turbo run typecheck --filter=...[HEAD]',
};
