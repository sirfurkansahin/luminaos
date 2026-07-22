declare module '*.module.css' {
  const classes: { readonly [key: string]: string };
  export default classes;
}

// Plain (non-Module) stylesheet side-effect imports, e.g. `import
// './tokens.css'` — Vite (both the app build and Ladle's own Vite-based dev
// server) handles these natively; this only satisfies `tsc`.
declare module '*.css';
