declare module '*.module.css' {
  const classes: { readonly [key: string]: string };
  export default classes;
}

// Plain (non-Module) stylesheet side-effect imports — Vite handles these
// natively; this only satisfies `tsc`.
declare module '*.css';
