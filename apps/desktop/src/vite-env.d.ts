/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Absolute base URL of `apps/server` the desktop webview talks to (F2-T3 PR4, ADR-0020). Absent -> `http://localhost:3000`, matching `apps/server/src/main.ts`'s `app.listen(3000)` default. */
  readonly VITE_SERVER_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
