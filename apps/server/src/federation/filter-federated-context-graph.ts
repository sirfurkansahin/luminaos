import type { ContextResponse } from '../context/context.service.js';

/**
 * F3-T14 PR2, ADR-0048 §"filterFederatedContextGraph" -- komşu-nesne
 * sızıntısı önlemi. `ContextResponse.edges`'teki HER `entity` tipi komşu
 * düğüm, `allowedObjectIds` kümesinde (AYNI linkin aktif kapsam nesneleri)
 * YOKSA TAMAMEN ELENİR -- yalnızca `title`/`fieldValues` gizlenmez, KENDİSİ
 * hiç dönmez. `person`/`time`/`topic` düğümleri filtrelenmez (bunlar
 * paylaşılan kök nesnenin KENDİ alanlarından türetilir, İnsan kararı 2'nin
 * "tam içerik" kapsamında ZATEN granted).
 *
 * Saf, DB'siz, birim test edilebilir -- `FederationMcpController` tarafından
 * çağrılır.
 */
export function filterFederatedContextGraph(
  response: ContextResponse,
  allowedObjectIds: ReadonlySet<string>,
): ContextResponse {
  return {
    ...response,
    edges: response.edges.filter((edge) => {
      if (edge.node.nodeType !== 'entity') return true;
      return edge.node.entityId !== undefined && allowedObjectIds.has(edge.node.entityId);
    }),
  };
}
