import { Inject, Injectable } from '@nestjs/common';
import { and, eq, ne, sql } from 'drizzle-orm';

import type { EmbeddingProvider } from '@luminaos/ai-gateway';

import { EMBEDDING_PROVIDER } from '../ai/embedding-provider.token.js';
import { DATABASE_CONNECTION } from '../db/database-connection.token.js';
import { DEFAULT_LIMIT } from './dto/search-workspace.schema.js';
import { objectsView } from '../db/schema/objects-view.js';
import { searchIndex } from '../db/schema/search-index.js';

import type { Database } from '../db/client.js';

export interface SearchResult {
  objectId: string;
  title: string;
  type: string;
  score: number;
}

/**
 * Top-N candidates pulled from EACH retrieval axis before the union/rescore
 * step (ADR-0013 §b) — deliberately larger than any caller-facing `limit`
 * (capped at `MAX_LIMIT` in `search-workspace.schema.ts`) so the final
 * fixed-weight rescore has a wide-enough pool to actually re-rank over.
 */
const KEYWORD_CANDIDATE_LIMIT = 50;
const SEMANTIC_CANDIDATE_LIMIT = 50;

/**
 * Defense-in-depth cap on how many `search_index.embedding` rows a single
 * search request will brute-force cosine-compare against in Node. ADR-0013
 * §c justifies brute-force at all on a "small workspace volume" assumption —
 * this cap does not change that assumption, it just stops a pathologically
 * large workspace from making one request scan unboundedly. A real
 * approximate-nearest-neighbor index (pgvector or similar) is the documented
 * future-scale follow-up once workspaces regularly exceed this.
 */
const MAX_BRUTE_FORCE_ROWS = 2000;

const KEYWORD_WEIGHT = 0.5;
const SEMANTIC_WEIGHT = 0.5;

interface KeywordCandidate {
  objectId: string;
  title: string;
  type: string;
  rank: number;
}

interface SemanticCandidate {
  objectId: string;
  title: string;
  type: string;
  cosine: number;
}

function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  const length = Math.min(a.length, b.length);
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < length; i += 1) {
    const valueA = a[i] ?? 0;
    const valueB = b[i] ?? 0;
    dotProduct += valueA * valueB;
    normA += valueA * valueA;
    normB += valueB * valueB;
  }

  if (normA === 0 || normB === 0) {
    return 0;
  }

  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * F1-T13 PR5 (ADR-0013 §b/§f): the search API's ranking core. RBAC is
 * query-time (`workspace_id = :workspaceId` inside the WHERE clause of both
 * candidate queries) — never fetch-then-filter — so a workspace-B row is
 * never even fetched while serving workspace A's search. Every candidate
 * query also joins `objects_view` and excludes `lifecycle = 'deleted'`,
 * mirroring `ObjectsService`'s own `ne(objectsView.lifecycle, 'deleted')`
 * convention.
 */
@Injectable()
export class SearchService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly db: Database,
    @Inject(EMBEDDING_PROVIDER) private readonly embeddingProvider: EmbeddingProvider,
  ) {}

  async search(
    workspaceId: string,
    query: string,
    limit: number = DEFAULT_LIMIT,
  ): Promise<SearchResult[]> {
    const [keywordCandidates, semanticCandidates] = await Promise.all([
      this.fetchKeywordCandidates(workspaceId, query),
      this.fetchSemanticCandidates(workspaceId, query),
    ]);

    const maxRawRank = keywordCandidates.reduce(
      (max, candidate) => Math.max(max, candidate.rank),
      0,
    );

    interface Combined {
      objectId: string;
      title: string;
      type: string;
      keywordNorm: number;
      cosine: number;
    }

    const combined = new Map<string, Combined>();

    for (const candidate of keywordCandidates) {
      combined.set(candidate.objectId, {
        objectId: candidate.objectId,
        title: candidate.title,
        type: candidate.type,
        keywordNorm: maxRawRank > 0 ? candidate.rank / maxRawRank : 0,
        cosine: 0,
      });
    }

    for (const candidate of semanticCandidates) {
      const existing = combined.get(candidate.objectId);
      if (existing) {
        existing.cosine = candidate.cosine;
      } else {
        combined.set(candidate.objectId, {
          objectId: candidate.objectId,
          title: candidate.title,
          type: candidate.type,
          keywordNorm: 0,
          cosine: candidate.cosine,
        });
      }
    }

    const scored: SearchResult[] = Array.from(combined.values()).map((entry) => ({
      objectId: entry.objectId,
      title: entry.title,
      type: entry.type,
      score: KEYWORD_WEIGHT * entry.keywordNorm + SEMANTIC_WEIGHT * entry.cosine,
    }));

    scored.sort((a, b) => b.score - a.score);

    return scored.slice(0, limit);
  }

  private async fetchKeywordCandidates(
    workspaceId: string,
    query: string,
  ): Promise<KeywordCandidate[]> {
    const rankExpression = sql<number>`ts_rank(${searchIndex.tsv}, plainto_tsquery('simple', ${query}))`;

    const rows = await this.db
      .select({
        objectId: searchIndex.objectId,
        title: searchIndex.title,
        type: objectsView.type,
        rank: rankExpression,
      })
      .from(searchIndex)
      .innerJoin(objectsView, eq(searchIndex.objectId, objectsView.id))
      .where(
        and(
          eq(searchIndex.workspaceId, workspaceId),
          ne(objectsView.lifecycle, 'deleted'),
          sql`${searchIndex.tsv} @@ plainto_tsquery('simple', ${query})`,
        ),
      )
      .orderBy(sql`${rankExpression} DESC`)
      .limit(KEYWORD_CANDIDATE_LIMIT);

    return rows.map((row) => ({
      objectId: row.objectId,
      title: row.title,
      type: row.type,
      rank: row.rank,
    }));
  }

  private async fetchSemanticCandidates(
    workspaceId: string,
    query: string,
  ): Promise<SemanticCandidate[]> {
    const { vector: queryVector } = await this.embeddingProvider.embed({ text: query });

    const rows = await this.db
      .select({
        objectId: searchIndex.objectId,
        title: searchIndex.title,
        type: objectsView.type,
        embedding: searchIndex.embedding,
      })
      .from(searchIndex)
      .innerJoin(objectsView, eq(searchIndex.objectId, objectsView.id))
      .where(
        and(
          eq(searchIndex.workspaceId, workspaceId),
          ne(objectsView.lifecycle, 'deleted'),
          sql`${searchIndex.embedding} IS NOT NULL`,
        ),
      )
      .limit(MAX_BRUTE_FORCE_ROWS);

    const scored = rows
      .filter(
        (row): row is typeof row & { embedding: number[] } =>
          row.embedding !== null && row.embedding.length > 0,
      )
      .map((row) => ({
        objectId: row.objectId,
        title: row.title,
        type: row.type,
        cosine: cosineSimilarity(queryVector, row.embedding),
      }));

    scored.sort((a, b) => b.cosine - a.cosine);

    return scored.slice(0, SEMANTIC_CANDIDATE_LIMIT);
  }
}
