# F3-T14 — Kurumlar Arası Paylaşılan Proje Alanı: Federatif Bağlam Paylaşımı v0

**Epik:** F3-E6 (Federatif Beyin v0 [Kapsam Q]) · **Durum:** Mimari onaylandı, uygulama bekliyor — Epiğin TEK görevi. Mimari karar `docs/adr/ADR-0048-federatif-baglam-paylasimi-v0.md`'de tam resmileşti — bu spec o ADR'yi görev kapsamına (amaç/kapsam/PR bölünmesi/kabul kriterleri) çevirir, yeniden türetmez.
**Bağımlılık:** F2-T12/ADR-0028 (`McpTokenAuthGuard`/`mcp_client_grants`'ın PAT deseni, `ContextService.getContext` sözleşimi — bu görev bunları OKUR/TAKLİT EDER, DEĞİŞTİRMEZ). ADR-0018 (`ContextResponse`/`ContextEdgeSummary` şekli, alan-bazlı `canViewField` süzgeci). ADR-0016 (export/okuma rol-gate yasağı). ADR-0029 (dört kademeli hassasiyet sınıflandırması — bu görev ÜÇÜNCÜ bir eksen açıyor, ADR-0029'u değiştirmiyor).

## Amaç

`docs/PLAN.md` satır 303'ün vaadi: "Kurumlar arası paylaşılan proje alanı: yalnız o kapsamda ortak bellek/bağlam; çift taraflı denetim günlüğü." §7 madde 8'in (satır 316) teknik notu: "LuminaOS'in kendi MCP sunucusu, kapsam-sınırlı belirteçlerle karşı kuruma bağlam servis eder; veri kopyalanmaz, yerinde sorgulanır." ADR-0048 Karar (a)-(k)'de tam sabitlendi.

## Kapsam

1. `apps/server/src/db/schema/federation-links.ts` / `federation-link-credentials.ts` / `federation-scope-objects.ts` (YENİ) + migration `0047_federation_links_and_scope.sql` + down script (ADR-0048 Karar b/d/e/k).
2. `apps/server/src/federation/federation-link-state.ts` (YENİ) — saf durum-makinesi fonksiyonları (`canTransition`, `computePairKey`), DB'siz (ADR-0048 Karar b).
3. `apps/server/src/federation/federation-links.service.ts` (YENİ) — `initiate`/`accept`/`revoke`, `admin+` RBAC, `pairKey` çakışma kontrolü (ADR-0048 Karar b/c).
4. `apps/server/src/federation/federation-scope.service.ts` (YENİ) — kapsam nesnesi ekleme/çıkarma, `assertObjectExists` emsali (ADR-0048 Karar e).
5. `apps/server/src/federation/federation-link-credentials.service.ts` (YENİ) — `mcp-client-grants.service.ts`'in PAT üretim/hash/prefix/revoke deseninin `federationLinkId`+`granteeWorkspaceId` imzasıyla kopyası, sabit 30/90/365 gün menüsü, varsayılan 90 (ADR-0048 Karar d).
6. `apps/server/src/federation/federation-token-auth.guard.ts` (YENİ) — `McpTokenAuthGuard`'ın paralel kopyası, `request.federationGrant` doldurur (ADR-0048 Karar f).
7. `apps/server/src/federation/filter-federated-context-graph.ts` (YENİ) — saf fonksiyon, paylaşılmayan komşu-nesne düğümlerini eler (ADR-0048 Karar g'nin komşu-sızıntı önlemi).
8. `apps/server/src/federation/federation-audit.service.ts` (YENİ) — çift-taraflı event yazımı: host-tarafı fail-closed `FederatedContextAccessed`, grantee-tarafı best-effort `FederatedContextRequested` (ADR-0048 Karar h).
9. `apps/server/src/federation/federation-mcp.controller.ts` (YENİ) — `POST /federation-mcp`, tek tool `get_federated_context(objectId)`, `FederationTokenAuthGuard` arkasında (ADR-0048 Karar g).
10. `apps/server/src/federation/federation-links.controller.ts` / `federation-scope.controller.ts` (YENİ) — insan-tarafı REST uç noktaları (initiate/accept/revoke/list, kapsam ekle/çıkar/listele, credential oluştur/iptal, audit-log görüntüleme), `SessionAuthGuard`+`WorkspaceMembershipGuard` arkasında.
11. `apps/server/src/federation/federation-rate-limit.service.ts` (YENİ) — `checkRateLimit` yeniden kullanımı, `(hostWorkspaceId, credentialId)` anahtarlı, `mcp-rate-limit-buckets`'ın AYNI varsayılan sabitleri (ADR-0028 Karar h emsali).
12. `apps/web`'e YENİ federasyon yönetim paneli (link oluştur/kabul et/iptal et, kapsam nesnesi ekle/çıkar — admin+ gate'li) + denetim günlüğü görüntüleme paneli (member+).

## Bağlayıcı İnsan Kararları (ADR-0048'den, AYNEN kayıtlı — tekrar tartışılmaz)

1. **Federasyon birimi: BİLATERAL WORKSPACE EŞLEŞMESİ** — yeni bir `Organization` varlığı YOK. `FederationLink` iki workspace'i her iki tarafın da onayıyla eşleştirir.
2. **İçerik görünürlüğü: TAM İÇERİK, OPT-IN ALLOWLIST İLE** — güvenlik sınırı KAPSAMDADIR (hangi nesneler paylaşılan alana dahil edildi), kapsam İÇİNDEKİ içerik REDAKTE EDİLMEZ (Google Docs "harici paylaş" modeli). Paylaşılmayan HER ŞEY tamamen görünmez.
3. **v0 kapsamı: YALNIZCA BAĞLAM (`ContextService`)** — `packages/memory` paylaşımı KAPSAM DIŞI, sonraki görev önerisi.
4. **[Bu oturumda kapatıldı] Federasyon credential süresi: SONLU 30/90/365 gün, varsayılan 90** — "süresiz" seçeneği hiç sunulmaz (ADR-0028 Karar l'nin bu görev için ayırdığı uzatma noktası bilinçli olarak kullanılmadı).

## Mimari Özet

(Tam gerekçe/kod için `docs/adr/ADR-0048-federatif-baglam-paylasimi-v0.md` Karar (a)-(k) referans alınmalı — burada yalnızca özetlenir.)

- **(a) Federasyon birimi:** `FederationLink(initiatorWorkspaceId, counterpartWorkspaceId)` — yeni `Organization` YOK.
- **(b) Durum makinesi:** `pending → active → revoked` (terminal), `pairKey` (yön-bağımsız, sıralı `min:max`) partial-unique-index ile aynı iki workspace arasında birden fazla pending/active linki engeller. İki AYRI audit-stream-id (`initiatorAuditStreamId`/`counterpartAuditStreamId`) — `events` tablosunun `(streamId, version)` UNIQUE kısıtının workspace'i içermediği bulgusu gereği, `linkId`'yi iki tarafta paylaşmak version-çakışması yaratırdı.
- **(c) RBAC:** başlatma/kabul/iptal yalnızca `admin+`; initiator kendi teklifini kabul edemez; iptal her iki taraftan, her durumda.
- **(d) Credential süresi:** `mcp_client_grants`'ın AYNI 30/90/365/varsayılan-90 politikası, süresiz YOK (İnsan kararı 4).
- **(e) Kapsam:** `federation_scope_objects(linkId, objectId, ownerWorkspaceId, addedByUserId, addedAt, removedAt-tombstone)` — tek-tek ekleme, toplu paylaşım YOK.
- **(f) Guard:** `FederationTokenAuthGuard`, `McpTokenAuthGuard`'ın PARALEL kopyası (genişletmesi DEĞİL) — `request.federationGrant = {linkId, credentialId, granteeWorkspaceId, hostWorkspaceId}`, canlı `status==='active'` kontrolü.
- **(g) Tool + sızıntı önlemi:** `POST /federation-mcp` → `get_federated_context(objectId)` — fail-closed kapsam kontrolü, sentetik `'owner'` rolüyle `ContextService.getContext` çağrısı (alan-bazlı redaksiyon bypass, İnsan kararı 2), `filterFederatedContextGraph` ile paylaşılmayan `entity` komşularının TAMAMEN elenmesi (yalnızca title değil, düğümün kendisi).
- **(h) Çift-taraflı audit:** host-tarafı `FederatedContextAccessed` FAIL-CLOSED (yazım başarısızsa okuma hiç olmaz), grantee-tarafı `FederatedContextRequested` BEST-EFFORT (başarısızsa yalnızca loglanır, yanıt yine döner). Tek cross-workspace transaction YOK (gerekçe: `EventStoreService.append`'in API'si tx-enjeksiyonu desteklemiyor + orantısız kilit-çekişme riski).
- **(i) ADR-0016 ilişkisi:** federasyon kapsamı yalnızca EKLENEN dış görünürlük — host workspace'in kendi üyelerinin mevcut okuma/export hakkını ASLA kısıtlamaz.
- **(j) ADR-0029 ilişkisi:** üçüncü, ele alınmamış eksen (kurumlar-arası) — ADR-0029 DEĞİŞMEDİ; Kademe-bazlı redaksiyon bu ADR'de UYGULANMAZ (İnsan kararı 2 gereği).
- **(k) Migration:** `0047_federation_links_and_scope.sql` + down script, üç tablo tek migration'da.

**RBAC özeti:** link kurma/kabul/iptal + kapsam yönetimi + credential oluşturma = `admin+`. Kendi workspace'inin federasyon denetim günlüğünü görüntüleme = `member+` (ADR-0016 §a'nın "okuma rol-gate'lenmez" ilkesi).

## PR Bölünmesi (3 PR, tek plan onayı hepsini kapsar — mimari-kritik, ±400 satır sınırı gözetilir)

1. **PR1 — Domain modeli, migration, saf servis mantığı (backend, framework-minimal).** `federation-links.ts`/`federation-link-credentials.ts`/`federation-scope-objects.ts` şemaları, migration 0047 + down; `federation-link-state.ts` (saf `canTransition`/`computePairKey`); `federation-links.service.ts` (`initiate`/`accept`/`revoke`, `InvalidObjectStateError`/`ConflictError`/`ForbiddenError`); `federation-scope.service.ts` (ekle/çıkar, `assertObjectExists`); `federation-link-credentials.service.ts` (`mcp-client-grants.service.ts`'in PAT deseninin kopyası). Testler: durum-makinesi geçiş matrisi (birim, DB'siz); `initiate`/`accept`/`revoke` DB entegrasyon testleri (yetkisiz `admin`-altı rol → `ForbiddenError`; initiator kendi teklifini kabul → `ForbiddenError`; geçersiz geçiş → `InvalidObjectStateError`; aynı iki workspace arasında ikinci pending link → `ConflictError`; `revoke` sonrası yeniden link kurulabildiği); kapsam ekleme/çıkarma (var olmayan `objectId` → `NotFoundError`; yanlış `ownerWorkspaceId` → `ForbiddenError`; tombstone sonrası aynı `objectId`'nin yeniden eklenebildiği); credential oluşturma (`expiresAtDays` yalnızca 30/90/365 kabul, varsayılan 90, `NULL` asla yazılmadığının regresyonu).
2. **PR2 — Guard + MCP tool + REST controller'lar + çift-taraflı audit (backend, entegrasyon).** `federation-token-auth.guard.ts`, `federation-mcp.controller.ts` (`POST /federation-mcp`), `filter-federated-context-graph.ts`, `federation-audit.service.ts`, `federation-rate-limit.service.ts`, `federation-links.controller.ts`/`federation-scope.controller.ts` (REST rotaları). Testler: kapsam-dışı `objectId` için `ContextService.getContext`'in SIFIR kez çağrıldığının mock kanıtı (fail-closed); `filterFederatedContextGraph`'ın kapsam-dışı `entity` komşusunu TAMAMEN elediği (birim); host-tarafı audit yazımı başarısız olduğunda `ContextService`'in HİÇ çağrılmadığı VE isteğin başarısız döndüğü; grantee-tarafı audit yazımı başarısız olduğunda isteğin YİNE DE başarılı döndüğü (best-effort regresyonu); guard'ın `revoke` sonrası ANINDA 401 döndüğü (canlı durum kontrolü); guard'ın `revokedAt`/`expiresAt`/bulunamayan token için AYNI 401'i döndüğü (durum sızdırmama); RBAC (REST uç noktalarında `admin+`/`member+` ayrımı); rate-limit'in `(hostWorkspaceId, credentialId)` anahtarıyla çalıştığı.
3. **PR3 — Frontend.** Federasyon bağlantısı yönetim paneli (`admin+` gate'li: link oluştur/kabul et/iptal et, kapsam nesnesi ekle/çıkar, credential oluştur/listele/iptal et) + denetim günlüğü görüntüleme paneli (`member+`: kendi workspace'inin `FederatedContextAccessed`/`FederatedContextRequested` event'lerini listeler). Testler: `admin+` OLMAYAN bir kullanıcıya yönetim aksiyonlarının UI'da gösterilmediği/API çağrısının 403 ile reddedildiği; link durumuna göre (`pending`/`active`/`revoked`) doğru aksiyon butonlarının render edildiği; audit log panelinin her iki event tipini de (erişilen/istenen) doğru ayırt ederek gösterdiği.

## Kapsam Dışı

- **`packages/memory` (Memory Passport) paylaşımı** — İnsan kararı 3, sonraki görev önerisi.
- **Yeni bir `Organization` varlığı** — İnsan kararı 1'in reddettiği alternatif.
- **Kapsam-içi içerik redaksiyonu (Kademe-bazlı veya alan-bazlı)** — İnsan kararı 2'nin reddettiği alternatif.
- **Toplu/otomatik nesne paylaşımı** ("tüm workspace'i paylaş") — İnsan kararı 2'nin reddettiği alternatif.
- **Tek-taraflı (onaysız) federasyon** — Karar (c)'nin reddettiği alternatif.
- **Federasyon credential'ları için "süresiz" seçenek** — İnsan kararı 4, bu oturumda kapatıldı.
- **Federasyon credential rotasyon/yenileme UI'ı** — ADR-0028 Bilinen Sınırlama (b)'nin AYNI erteleme kararı.
- **Nesne-tipi bazlı kapsam daraltma** — v0'da yalnızca tek-tek `objectId` granülerliği.
- **Karşı workspace'i keşfetme/arama UI'ı** — initiator, `counterpartWorkspaceId`'yi kurum-dışı bir kanaldan (ör. e-posta) zaten bilmeli varsayılıyor.
- **Rate-limit dışında ek bir kötüye-kullanım/anomali tespiti.**

## Kabul Kriterleri

- [ ] **PR1:** Durum-makinesi geçiş matrisi (`pending→active`, `pending/active→revoked`, geçersiz geçişler `InvalidObjectStateError`) birim testlerle kanıtlı.
- [ ] **PR1:** `initiate`/`accept`/`revoke` — yetkisiz rol `ForbiddenError`; initiator kendi teklifini kabul edemiyor; aynı iki workspace arasında ikinci pending/active link `ConflictError`; `revoke` sonrası yeniden link kurulabiliyor.
- [ ] **PR1:** Kapsam ekleme/çıkarma — var olmayan `objectId` `NotFoundError`; yanlış `ownerWorkspaceId` `ForbiddenError`; tombstone sonrası yeniden eklenebiliyor.
- [ ] **PR1:** Credential oluşturma yalnızca 30/90/365 gün kabul ediyor (varsayılan 90), `expiresAt` hiçbir kod yolunda `NULL` yazılmıyor.
- [ ] **PR1:** `pnpm --filter @luminaos/server typecheck && lint && test:changed` yeşil; `security-reviewer` bulgusuz; migration 0047 + down script mevcut ve ters sırada tabloları düşürüyor.
- [ ] **PR2:** Kapsam-dışı `objectId` isteği `ContextService.getContext`'i SIFIR kez çağırıyor (fail-closed kanıtı).
- [ ] **PR2:** `filterFederatedContextGraph`, kapsam-dışı `entity` komşusunu edge listesinden TAMAMEN eliyor (yalnızca title/fieldValues değil, düğümün kendisi); `person`/`time`/`topic` düğümleri etkilenmiyor.
- [ ] **PR2:** Host-tarafı `FederatedContextAccessed` yazımı başarısız olduğunda istek başarısız dönüyor VE `ContextService` hiç çağrılmıyor.
- [ ] **PR2:** Grantee-tarafı `FederatedContextRequested` yazımı başarısız olsa bile istek başarılı dönüyor (best-effort regresyonu).
- [ ] **PR2:** `FederationTokenAuthGuard` — bulunamayan/iptal edilmiş/süresi dolmuş token VE `pending`/`revoked` durumundaki link için AYNI 401'i döndürüyor (durum sızdırmıyor); `revoke` sonrası bir sonraki çağrı ANINDA 401.
- [ ] **PR2:** REST uç noktalarında `admin+`/`member+` RBAC ayrımı doğru uygulanıyor; rate-limit `(hostWorkspaceId, credentialId)` anahtarıyla çalışıyor.
- [ ] **PR2:** `pnpm --filter @luminaos/server typecheck && lint && test:changed` yeşil; `security-reviewer` bulgusuz.
- [ ] **PR3:** `admin+` olmayan kullanıcı için yönetim aksiyonları UI'da gizli/devre dışı; API çağrısı 403.
- [ ] **PR3:** Link durumuna göre doğru aksiyon butonları (pending → kabul et/iptal, active → kapsam yönetimi/iptal, revoked → salt-okunur) render ediliyor.
- [ ] **PR3:** Denetim günlüğü paneli her iki event tipini ayırt ederek doğru render ediyor.
- [ ] **PR3:** `pnpm --filter @luminaos/web typecheck && lint && test:changed` yeşil; `security-reviewer` bulgusuz.

## Açık Sorular

- **Denetim günlüğü okuma uç noktasının tam yerleşimi** (PR2'nin backend rotası mı, `EventStoreService.readByWorkspace`'in nasıl filtreleneceği) — mimari bir karar GEREKTİRMİYOR, implementer'a bırakılan küçük bir uygulama detayı.
- **`packages/memory` federasyon genişlemesi** — bu görev tamamlandıktan sonra doğal bir sonraki görev adayı; ayrı bir spec/ADR gerektirecek (İnsan kararı 3).
- **Gerçek bir "süresiz federasyon" ihtiyacı doğarsa** — Karar (d)'nin nullable `expiresAt` kolonu şema-seviyesinde esnek bırakıldı, ama v0'ın hiçbir kod yolu bunu kullanmıyor; gelecekte AYRI bir insan kararı + ADR gerektirir.

## Sıradaki adım

ADR-0048 ve bu spec onaylandı — `test-writer` → `implementer` → `security-reviewer` ritüeline **PR1**'den başlanır:

```
docs/specs/F3-E6/F3-T14-federatif-baglam-paylasimi.md'nin PR1'ini uygula: federation_links/
federation_link_credentials/federation_scope_objects şemaları + migration 0047 (+ down script) +
saf durum-makinesi (federation-link-state.ts) + FederationLinksService/FederationScopeService/
FederationLinkCredentialsService. Önce test-writer ile PR1'in Kabul Kriterleri'ndeki başarısız
testleri yaz (durum geçiş matrisi, RBAC/ConflictError/InvalidObjectStateError senaryoları, credential
30/90/365 gün doğrulaması), sonra implementer ile asgari uygulamayı yap. docs/adr/ADR-0048-
federatif-baglam-paylasimi-v0.md Karar (a)-(e)/(k) referans alınmalı, yeniden türetilmemeli.
```

F3-T14, `docs/PLAN.md`'nin Faz 3'ünün SON epiğinin (F3-E6, Kapsam Q) TEK görevi — PR1/PR2/PR3'ün tamamı `main`'e merge olduğunda Faz 3 TAMAMEN kapanır, Faz 4 planlaması insana bırakılır.
