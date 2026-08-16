/**
 * F2-T4 (ADR-0021): pure, deterministic relevance-scoring functions for
 * `ContextService.getContext`'s opt-in `sort=relevance` behavior. Skor
 * hiçbir yerde saklanmaz -- her çağrıda `now` enjekte edilerek sorgu-zamanında
 * hesaplanır (Karar a). `Date.now()`'a bağımlılık YOK, I/O YOK, girdi
 * mutasyonu YOK (Karar g).
 */

/** Karar (b): üstel sönümleme, 14 günlük yarı-ömür. */
const HALF_LIFE_DAYS = 14;
const DAY_MS = 86_400_000;

/**
 * Karar (c): kenar-türü temel ağırlıkları (insan onaylı, KESİN). `Map`
 * kullanılıyor (düz obje DEĞİL) -- security-reviewer bulgusu: `edgeType`
 * bugün yalnızca `ContextGraphProjection`'ın sabit enum'undan geliyor ve
 * saldırgan-kontrollü değil, ama düz bir `Record`/obje üzerinde `["constructor"]`
 * gibi bir prototip-zinciri anahtarının `undefined` yerine bir fonksiyon
 * döndürüp `null` yerine `NaN` skor üretmesi mümkün olurdu -- `Map`
 * prototip zincirinden tamamen izole, bu sınıf hatayı kökten önlüyor.
 */
const BASE_WEIGHTS: ReadonlyMap<string, number> = new Map([
  ['entity-time', 1.0],
  ['entity-topic', 0.8],
  ['person-topic', 0.6],
  ['person-time', 0.4],
]);

/**
 * Karar (b)/(c): `score(edge, now) = baseWeight(edge.edgeType) *
 * dampingFactor(edge.createdAt, now)`. `entity-entity`/`entity-person`
 * kenarları (Karar d) skorlamaya dahil değildir -- bu iki tür için `null`
 * döner, `sortEdgesByRelevance`'ın "sona ekle" mantığının ayırt edicisi.
 */
export function computeRelevanceScore(edgeType: string, createdAt: Date, now: Date): number | null {
  const baseWeight = BASE_WEIGHTS.get(edgeType);

  if (baseWeight === undefined) {
    return null;
  }

  const ageInDays = (now.getTime() - createdAt.getTime()) / DAY_MS;
  const dampingFactor = 0.5 ** (ageInDays / HALF_LIFE_DAYS);

  return baseWeight * dampingFactor;
}

/**
 * Karar (d): önce skorlanan 4 tür azalan skora göre sıralanır, SONRA
 * skorlanmayan türler (`computeRelevanceScore` -> `null`) kendi ORİJİNAL
 * göreli sırasını koruyarak listenin SONUNA eklenir. Girdi dizisi mutasyona
 * uğramaz, yeni bir dizi döner (Karar g).
 */
export function sortEdgesByRelevance<T extends { edgeType: string; createdAt: Date }>(
  edges: readonly T[],
  now: Date,
): T[] {
  const scored: { edge: T; score: number }[] = [];
  const unscored: T[] = [];

  for (const edge of edges) {
    const score = computeRelevanceScore(edge.edgeType, edge.createdAt, now);

    if (score === null) {
      unscored.push(edge);
    } else {
      scored.push({ edge, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);

  return [...scored.map((entry) => entry.edge), ...unscored];
}
