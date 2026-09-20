/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Optional absolute production API origin for static deployments. */
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
