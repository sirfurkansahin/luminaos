/**
 * The Nest DI token for the workspace's `EmbeddingProvider` (F1-T13 PR4,
 * ADR-0013 §(c)/(e)). Deliberately factored out of `embedding-provider.module.ts`
 * into its own zero-dependency module — mirrors `ai-provider.token.ts`'s exact
 * reasoning: a consumer that only needs this token for
 * `@Inject(EMBEDDING_PROVIDER)` must not be forced to transitively pull in
 * `embedding-provider.module.ts`'s own imports.
 */
export const EMBEDDING_PROVIDER = 'EMBEDDING_PROVIDER';
