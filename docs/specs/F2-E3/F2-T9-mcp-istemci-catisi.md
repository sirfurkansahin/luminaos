# F2-T9 — MCP İstemci Çatısı + Bağlayıcı Yaşam Döngüsü (Kimlik, Oran Sınırı, Sağlık)

**Epik:** F2-E3 (MCP-native Entegrasyon, Kapsam G) · **Durum:** Tamamlandı. ADR: `docs/adr/ADR-0025-mcp-istemci-catisi.md`. PR'lar: #145-146 (PR1: `packages/integrations/src/mcp/` protokol katmanı), #147 (PR2: `apps/server/src/integrations/` kimlik-bilgisi/oran-sınırı/sağlık servisleri).
**Bağımlılık:** `packages/integrations` (zaten var, F1-T12 PR4'ten `CalendarConnector` arayüzü — `packages/ai-gateway`'in `AIProvider` desenine benzer şekilde modellenmiş, ADR-0012), `apps/server/src/calendar/` (kimlik-bilgisi/token şifreleme emsali, ADR-0012), `apps/server/src/ai/ai-usage.service.ts` (kota/limit izleme emsali, ADR-0014), `apps/server/src/health/health.service.ts` (sağlık-kontrolü deseni), `packages/shared/src/secrets/token-encryption.ts` (şifreleme yardımcı fonksiyonları).

> ⚠️ MİMARİ-KRİTİK GÖREV: CLAUDE.md'nin ADR kriterinin HER İKİ fıkrasına da giriyor. (a) "Mimari Değişmezler" listesi MCP'yi AÇIKÇA adıyla anıyor: "Her dış girdi (MCP, webhook, form) şema ile doğrulanır (zod)" — bu görev bu değişmezin MCP tarafını ilk kez somut bir mekanizmaya döken görev. (b) Bu görevin tanımlayacağı bağlayıcı yaşam döngüsü sözleşimi (kimlik/kimlik-bilgisi saklama şekli, oran sınırı mekanizması, sağlık-kontrolü arayüzü), F2-T10 (ilk 6 bağlayıcı), F2-T11 (Connected Search) ve F2-T12 (MCP sunucusu) için dayatılan bir temel — bu üç görev de F2-T9'un kuracağı sözleşmeyi aynen tüketecek. `architect` taslağı + insan onayı koddan önce zorunlu.

## Amaç

LuminaOS'in dış kaynaklara (Google Drive, Gmail, Slack, GitHub, Notion, Takvimler — F2-T10'un listesi) MCP (Model Context Protocol) istemcisi olarak bağlanabileceği genel bir çatı kurmak: bağlayıcı kaydı/yaşam döngüsü, kimlik-bilgisi (credential) saklama, oran sınırı (rate limiting), ve sağlık-kontrolü (health check) — üçü de bağlayıcıdan-bağımsız, tekrar kullanılabilir bir sözleşim olarak. Bu görev **hiçbir gerçek dış bağlayıcı kurmaz** (Google Drive/Gmail/Slack/GitHub/Notion/Takvimler entegrasyonlarının kendisi F2-T10'un kapsamı) — yalnızca çatıyı, referans/mock bir bağlayıcıyla uçtan uca kanıtlanmış halde kurar.

## Mevcut Durum

- **`packages/integrations` zaten var ama MCP'yle ilgisiz, dar kapsamlı.** Tek gerçek içeriği `calendar-connector.ts`: `CalendarConnector` arayüzü (`listEvents`/`createEvent`/`updateEvent`/`deleteEvent`/`refreshToken`), `packages/ai-gateway`'in `AIProvider.complete()` desenine benzer şekilde modellenmiş (ADR-0012 §d), `MockCalendarConnector` ile test ediliyor. Bu, takvim-domain'ine özel bir soyutlama — MCP protokolüyle (JSON-RPC tabanlı, genel amaçlı tool/resource çağrıları) YAPISAL OLARAK FARKLI. Bu görev bu dosyaya DOKUNMAZ (bkz. Açık Soru 2).
- **Repoda sıfır MCP protokol kodu var.** Grep'te `MCP`/`mcp`/`@modelcontextprotocol` yalnızca doküman/plan metinlerinde geçiyor (`docs/PLAN.md`, `.claude/skills/mcp-baglayici/SKILL.md` — kendisi "iskelet, henüz doldurulmamış" diye işaretli —, ADR-0013). `pnpm-lock.yaml`'da `@modelcontextprotocol` bağımlılığı YOK. Bu görev bu alandaki İLK gerçek MCP protokol kodu.
- **`packages/ai-gateway`'de bir "kayıt/çoklu-sağlayıcı-seçimi/sağlık-kontrolü/oran-sınırı" yöneticisi YOK** — her çağıran doğrudan tek bir somut `AIProvider` örneği kullanıyor (ör. `AnthropicProvider`). Mirror alınacak bir "registry" deseni bugün yok — bu görev böyle bir düzenin İLK örneğini kuracak.
- **Kimlik-bilgisi (credential) saklama emsali zaten var ve olgun: `apps/server/src/calendar/`** (ADR-0012) — `CalendarAccountsService.connect/list/disconnect`, `calendar-token-encryption.service.ts` (`packages/shared/src/secrets/token-encryption.ts`'in `encryptSecret`/`decryptSecret`'ını kullanır), `calendar-token-refresh.service.ts`, `calendar-reconnect-required.error.ts`. Token'lar HER ZAMAN şifreli saklanır, public servis metotlarından asla düz metin dönmez, NestJS DI token deseniyle bağlanır (doğrudan import değil). Bu, bu görevin bağlayıcı-bağımsız kimlik-bilgisi saklama sözleşmesinin doğrudan genellemesi gereken emsal.
- **Oran sınırı (rate limiting) için genel bir yardımcı/kütüphane YOK.** En yakın emsal `AIUsageService.assertAITokenQuotaNotExceeded(workspaceId)` (ADR-0014) — workspace-başına, kilit korumalı kontrol-sonra-kaydet deseni, `QuotaExceededError` fırlatır. Bu literal bir API oran sınırlayıcısı değil (kullanım kotası), ama eşzamanlılık-güvenli kontrol-sonra-kaydet mimarisi doğrudan yeniden kullanılabilir.
- **Sağlık-kontrolü için olgun bir desen zaten var: `apps/server/src/health/health.service.ts`.** Framework-bağımsız `HealthService`, yapısal (duck-typed) probe arayüzleri alır, `withTimeout()` her probe'u 2000ms varsayılan zaman aşımına karşı yarıştırır, `Promise.allSettled` ile bir probe'un başarısızlığı diğerini engellemez, `{status:'ok'|'degraded', checks, version}` döner. Bu, bir bağlayıcının kendi sağlık-kontrolü kavramının doğrudan genellenebileceği kanıtlanmış bir kalıp.
- **CLAUDE.md'nin "Ajan çağrıları yalnızca ai-gateway üzerinden" kuralı bu göreve DOĞRUDAN uygulanmaz** — MCP bağlayıcıları AI model çağrısı değil, dış veri-kaynağı bağlantısı; ama "her dış girdi şema ile doğrulanır (zod)" kuralı doğrudan uygulanır ve bu görevde ilk kez somutlaşacak.

## Kapsam

1. **Paket konumu (ADR'de sabitlenir, bkz. Açık Soru 1-2):** MCP protokol istemci kodu nereye kurulur — `packages/integrations`'a mı eklenir (mevcut `calendar-connector.ts`'in yanına, ayrı bir dosya/alt-dizin olarak) yoksa yeni bir paket mi açılır. `CalendarConnector`'ın genelleştirilip genelleştirilmeyeceği (ortak bir `Connector` temel arayüzü) ayrı bir karar.
2. **MCP protokol katmanı (ADR'de sabitlenir, bkz. Açık Soru 3):** resmi `@modelcontextprotocol/sdk` (TypeScript SDK, Anthropic'in referans implementasyonu) mu kullanılır, yoksa JSON-RPC/transport elle mi yazılır.
3. **Bağlayıcı yaşam döngüsü sözleşimi:** kayıt (`register`), bağlan (`connect`), bağlantı kes (`disconnect`), durum sorgulama — bağlayıcıdan-bağımsız, `CalendarConnector`'ın kendi domain-özel şeklinden AYRI (bkz. Açık Soru 2).
4. **Kimlik-bilgisi saklama:** bağlayıcı-bağımsız, şifreli kimlik-bilgisi saklama şeması/servisi — `calendar-token-encryption.service.ts`'in genellemesi. Gerçek OAuth akışının UI/handshake kısmı KAPSAM DIŞI (F2-T10'un işi); bu görev yalnızca "bir bağlayıcının kimlik bilgilerini nasıl saklarız/şifreleriz/geri alırız" sözleşmesini kurar.
5. **Oran sınırı:** bağlayıcı-başına, yapılandırılabilir bir oran sınırlama mekanizması (ör. token-bucket), `AIUsageService`'in eşzamanlılık-güvenli kontrol-sonra-kaydet deseninden ilham alır.
6. **Sağlık kontrolü:** her bağlayıcının uygulayacağı bir `checkHealth()` sözleşimi, `HealthService`'in `withTimeout`/`Promise.allSettled` desenini izler.
7. **Referans/mock bağlayıcı:** çatının uçtan uca çalıştığını kanıtlayan, gerçek bir dış servise bağlanmayan bir örnek bağlayıcı (`MockCalendarConnector`'ın MCP-çatısı eşleniği).
8. **ADR:** `architect` subagent'ı ile paket konumu, protokol katmanı seçimi, kimlik-bilgisi/oran-sınırı/sağlık-kontrolü sözleşimlerinin tam şekli insan onayından önce yazılır.

## Kapsam DIŞI

- **Gerçek dış bağlayıcılar (Google Drive, Gmail, Slack, GitHub, Notion, Takvimler)** — F2-T10'un kapsamı. Bu görev yalnızca çatıyı kurar, gerçek bir OAuth uygulaması kaydı/API anahtarı gerektirmez.
- **Connected Search (birleşik iç+dış arama sonucu)** — F2-T11'in kapsamı.
- **LuminaOS'in kendi MCP sunucusu (dışarıya bağlam sunma)** — F2-T12'nin kapsamı; bu görev yalnızca İSTEMCİ tarafını kurar.
- **`CalendarConnector`'ın MCP-tabanlı bir bağlayıcıya taşınması/yeniden yazılması** — mevcut takvim senkronizasyonu (ADR-0012'nin read-through-cache tasarımı) bu görevde DEĞİŞTİRİLMEZ; ileride bir düşünce olarak kalır, bu görevin kapsamında bir taahhüt değil.
- **Ajan Runtime'ın (F3-T1) bağlayıcıları nasıl keşfedeceği/kullanacağı** — henüz yok, Faz 3.

## Açık Sorular

1. **[KRİTİK]** MCP protokol kodu nerede yaşayacak?
   - **Öneri:** `packages/integrations/src/mcp/` — mevcut paketin altında yeni bir alt-dizin/modül, `calendar-connector.ts`'in yanına eklenir (ayrı bir paket AÇILMAZ, aynı bounded context: "dış kaynak bağlantıları"). `packages/ai-gateway`'in tek-paket-çok-sağlayıcı desenine benzer.
2. **[KRİTİK]** `CalendarConnector`'ın kendi domain-özel arayüzü (`listEvents`/`createEvent` vb.) genelleştirilip yeni MCP `Connector` sözleşmesiyle birleştirilsin mi?
   - **Öneri:** HAYIR, ayrı tutulsun. `CalendarConnector` takvim-domain'ine özel bir soyutlama (ADR-0012'nin read-through-cache tasarımının parçası, MCP-tabanlı değil); MCP bağlayıcıları protokol-seviyesinde genel tool/resource çağrıları. İkisini ortak bir temel arayüze zorlamak bu aşamada erken/yanlış bir soyutlama olurdu — CLAUDE.md'nin "gerekenden fazla soyutlama ekleme" ilkesiyle tutarlı.
3. **[KRİTİK]** MCP protokol/transport katmanı için resmi `@modelcontextprotocol/sdk` mu kullanılır, yoksa elle mi yazılır?
   - **Öneri:** Resmi SDK kullanılır. JSON-RPC handshake/transport'u elle yeniden yazmak riskli ve gereksiz (protokolün kendi referans implementasyonu zaten var, Anthropic tarafından bakımı yapılıyor) — ADR-0016 §d'nin "kanıtlanmamış bir şemayı elle reverse-engineer etmek yerine mevcut/kanıtlanmış bir yolu tercih et" mantığıyla aynı risk-azaltma kararı.
4. Kimlik-bilgisi saklama şeması ne kadar geneldir — `calendar_accounts` tablosunun birebir bir genellemesi mi (yeni bir `connector_credentials` tablosu), yoksa `calendar_accounts`'ın kendisi mi bağlayıcı-tipini ayırt eden bir alanla genişletilir?
   - **Öneri:** Yeni, ayrı bir `connector_credentials` tablosu (ör. `{id, workspaceId, userId, connectorType, encryptedCredentials, ...}`) — `calendar_accounts`'a DOKUNULMAZ (ADR-0012'nin sabitlediği şema değişmez), takvim kendi tablosunda kalır, MCP bağlayıcıları kendi genel tablosunu kullanır. İki farklı bağlantı-türünü aynı tabloya zorlamak (biri read-through-cache senkron, diğeri MCP protokol tabanlı) kavramsal olarak yanlış birleştirme olurdu.
5. Oran sınırlama nerede uygulanır — her bağlayıcı çağrısından önce senkron bir kontrol mü (`AIUsageService`'in deseni), yoksa arka planda bir kuyruk/zamanlayıcı mı?
   - **Öneri:** Senkron kontrol-sonra-kaydet (`AIUsageService`'in deseni) — basit, mevcut ve kanıtlanmış; bir kuyruk/zamanlayıcı bu görevin kapsamına göre aşırı mühendislik olurdu.

## Kabul Kriterleri

- [x] Açık Soru 1-5'in insan kararları ADR'de (ADR-0025) kayıt altına alındı ve `architect` tarafından insan onayından önce taslak olarak sunuldu.
- [x] Bağlayıcı yaşam döngüsü sözleşimi (`register`/`connect`/`disconnect`/durum) saf TypeScript arayüz(ler) olarak tanımlı, testli (PR1: `McpConnector`, `McpConnectorRegistry`).
- [x] Kimlik-bilgisi saklama servisi: kimlik bilgileri her zaman şifreli saklanıyor, public metotlardan asla düz metin dönmüyor, testli (PR2: `ConnectorCredentialsService`, 9/9 entegrasyon testi, `security-reviewer` tarafından doğrulandı).
- [x] Oran sınırlama: yapılandırılan limit aşıldığında çağrı reddediliyor, eşzamanlı çağrılar arasında yarış durumu (race condition) yok, testli (PR2: `ConnectorRateLimitService`, `pg_advisory_lock` korumalı, 6/6 entegrasyon testi eşzamanlılık yarış testi dahil).
- [x] Sağlık kontrolü: bir bağlayıcının `checkHealth()`'i zaman aşımına uğradığında veya hata fırlattığında sistemin geri kalanını engellemiyor, testli (PR2: `ConnectorHealthService`, 4/4 test).
- [x] Referans/mock bağlayıcı uçtan uca çalışıyor (kayıt→bağlan→sağlık-kontrolü→bağlantı-kes), testli (PR1: `MockMcpConnector`).
- [x] Her dış girdi (MCP mesajları dahil) zod ile doğrulanıyor (Mimari Değişmez) — ADR-0025'in `McpConnector` sözleşimi bunu her somut bağlayıcı implementasyonu için zorunlu kılıyor (`callTool`/`readResource` sonuçları çağıran koda ulaşmadan önce zod-doğrulanmış olmalı); bu görevde gerçek bir dış bağlayıcı KURULMADIĞI için (kapsam dışı, F2-T10) somut zod şeması bu görevde yazılmadı — F2-T10'un her yeni bağlayıcısı bu zorunluluğu miras alır.
- [x] `security-reviewer` denetiminde bulgu yok (özellikle: kimlik bilgilerinin loglanmadığı, şifreleme doğru kullanıldığı) — PR1 ve PR2 ayrı ayrı denetlendi, ikisinde de bloklayıcı bulgu yok.
- [x] `pnpm typecheck && pnpm lint && pnpm test:changed` yeşil.

---

**Sıradaki adım:** F2-T9 tamamlandı, F2-E3 epiğinin ilk görevi kapandı. Sırada `docs/PLAN.md`'nin F2-E3 listesindeki F2-T10 var: "İlk 6 bağlayıcı: Google Drive, Gmail, Slack, GitHub, Notion, Takvimler." Bu, bu görevin kurduğu `McpConnector`/`McpConnectorRegistry`/`ConnectorCredentialsService`/`ConnectorRateLimitService`/`ConnectorHealthService` çatısını gerçek bağlayıcılarla tüketecek ilk görev. Kopyala-yapıştır komutu:

```
docs/specs/F2-E3/F2-T10-ilk-6-baglayici.md spec dosyasını yaz, sonra Plan Mode ile F2-T10'u planla.
```
