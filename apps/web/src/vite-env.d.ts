/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Optional absolute production API origin for static deployments. */
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_LEGAL_CONTROLLER_NAME?: string;
  readonly VITE_LEGAL_CONTACT_EMAIL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
