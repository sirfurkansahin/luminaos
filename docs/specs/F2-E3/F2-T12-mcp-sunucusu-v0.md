# F2-T12 — LuminaOS MCP Sunucusu v0: Dışarıya Güvenli Bağlam Sunumu

**Epik:** F2-E3 (MCP-native Entegrasyon, Kapsam G) · **Durum:** Tamamlandı — [PR #154](https://github.com/sirfurkansahin/luminaos/pull/154) (backend, ADR-0028) + [PR #155](https://github.com/sirfurkansahin/luminaos/pull/155) (frontend, McpAccessPanel).
**Bağımlılık:** F2-T2 (Bağlam API'si, Tamamlandı — `apps/server/src/context/`), F2-T9/F2-T10/F2-T11 (MCP istemci tarafı, Tamamlandı), F1-T18/ADR-0016 (dışa aktarım, Tamamlandı), ADR-0023 (JSON-LD bellek şeması), ADR-0024 (bellek erişim manifestoları, emsal).

> ⚠️ MİMARİ-KRİTİK GÖREV: CLAUDE.md'nin ADR kriterinin HEM (a) HEM (b) fıkrasına giriyor:
>
> - **(a) Mimari Değişmezlerle gerilim:** Bu görev, LuminaOS'e İLK KEZ **içeri doğru** (inbound) bir güven sınırı ekliyor — bugüne kadarki tüm dış bağlantılar (F2-T10) LuminaOS'in KENDİSİNİN bir OAuth2 istemcisi olarak dışarı çıktığı yönde; F2-T12 bunun TERSİ: dış bir MCP istemcisinin (Claude Desktop, gelecekte başka bir kurum) LuminaOS'e kimlik doğrulayıp veri OKUMASI. "Veri dışa aktarma hiçbir planda/kodda kısıtlanamaz" ve "hassas veri sınıfları buluta ham gönderilmez" değişmezleriyle doğrudan kesişiyor — bu görev bu iki değişmezin YENİ bir dış-erişim yüzeyinde de tutarlı uygulandığını KANITLAMALI.
> - **(b) Gelecekteki görevlere dayatılan sözleşim:** `docs/PLAN.md`'nin F3-T14'ü ("Federatif Beyin v0", Kapsam Q) açıkça bu görevin üzerine inşa edilecek: _"LuminaOS'in kendi MCP sunucusu, kapsam-sınırlı belirteçlerle karşı kuruma bağlam servis eder."_ Burada kurulan token/scope/tool modeli, F3-T14'ün doğrudan mirasçısı olacak.
>
> `architect` taslağı (ADR-0028, sıradaki boş numara) + insan onayı koddan önce zorunlu.

## Amaç

LuminaOS'in kendi bağlamını (nesneler, ilişkiler, bellek pasaportu) bir MCP sunucusu olarak dışarıya sunmak — böylece Claude Desktop gibi harici MCP istemcileri, kullanıcının açıkça yetkilendirdiği, kapsam-sınırlı bir erişimle LuminaOS workspace'inin bağlamını sorgulayabilir. Bu, `docs/PLAN.md`'nin Kapsam Q ("Federatif Beyin") vizyonunun v0 temeli: bugün tek-kullanıcı/tek-workspace erişimi, yarın kurumlar-arası izinli köprü.

## Mevcut Durum (bir `explorer` dispatch'i ile doğrulandı)

- **Bağlam API'si (F2-T2) zaten TAM kurulu ve doğrudan yeniden kullanılabilir.** `ContextService.getContext(workspaceId, objectId, callerRole, options?)` (`apps/server/src/context/context.service.ts`) — 1-hop bağlam-grafiği gezinmesi, alan-bazlı izin süzgeçli (`canViewField`, ADR-0018), `?sort=relevance` (ADR-0021). <100ms performansı `context-query-performance.integration.test.ts`'te kanıtlı. Bu görev bunu YENİDEN İCAT ETMEZ, doğrudan bir MCP tool'una sarar.
- **İçeri doğru (inbound) kimlik doğrulama HİÇ YOK — bu görev sıfırdan kurmalı.** `SessionAuthGuard` yalnızca tarayıcı `sid` çerezini biliyor. Sunucu genelinde PAT/API-key/OAuth2 client-credentials akışı YOK. `mcp-oauth.controller.ts` (F2-T10) TERS yönde: LuminaOS'in kendisinin dışarıdaki bir MCP sunucusuna OAuth2 istemcisi olarak bağlanması. F2-T12'nin ihtiyacı BUNUN AYNASI değil, TAMAMEN YENİ bir yön — dış bir istemcinin LuminaOS'e karşı kimlik doğrulaması.
- **MCP SDK'nın sunucu-tarafı sınıfları zaten kurulu, hiç kullanılmamış.** `@modelcontextprotocol/sdk@^1.30.0` içinde `server/mcp.js`'de `McpServer` (`registerResource`/`registerTool`/`registerPrompt`) ve `server/streamableHttp.js`'de `StreamableHTTPServerTransport` mevcut — yeni paket kurulumu gerekmiyor, yalnızca yeni import yolları.
- **RBAC granülerliği: workspace-üyeliği + alan-bazlı izin, nesne-bazlı ACL YOK.** `WorkspaceMembershipGuard` yalnızca üyelik+rol kontrol ediyor; daha ince tanecik `FieldPermissions`/`canViewField` (`@luminaos/core-objects`) ile alan-bazlı. MCP-özel bir kapsamlama (ör. yalnızca belirli nesne tiplerine erişim) YENİ.
- **Dışa aktarım emsali (F2-T7/ADR-0023) bu görevi AÇIKÇA işaret ediyor.** ADR-0023: _"F2-T12'nin MCP sunucusu bu şemayı dışarı sunabilir."_ ADR-0016 §(a)'nın kuralı ("okuma/dışa-aktarım rol-kapılı DEĞİL, yalnızca üyelik-kapılı") tüm gelecek Faz 2+ okuma uç noktaları için bağlayıcı ilan edilmiş — F2-T12 da bunu miras alır.
- **Oran sınırı matematiği yeniden kullanılabilir, servisin kendisi değil.** `packages/integrations/src/mcp/rate-limit-math.ts`'in `checkRateLimit` fonksiyonu saf/durumsuz — inbound için de kullanılabilir. `ConnectorRateLimitService` (outbound, `(workspaceId, connectorType)` anahtarlı) doğrudan yeniden kullanılamaz; aynı deseni izleyen YENİ bir servis (`(workspaceId, mcpClientId)` anahtarlı) gerekir.
- **Bellek erişim manifestoları (F2-T8/ADR-0024) yakın ama farklı bir emsal.** `MemoryAccessPolicy` grant/revoke deseni (`packages/memory/src/memory-access-policy.ts`) var ama `agentIdentifier` sınırsız bir string, gerçek bir "dış istemci kimliği" kavramı YOK, ve yalnızca bellek kayıtlarını kapsıyor (Context API/nesneleri değil). F2-T12 kendi "dış istemci kimliği + kapsam" kavramını kurmalı — ADR-0024'ün grant/revoke şeklini örnek alarak ama yeni bir varlık için.

## Kapsam

1. **Yeni içeri-doğru kimlik doğrulama mekanizması** (bkz. Açık Soru 1) — dış bir MCP istemcisinin LuminaOS'e Bearer token ile kimlik doğrulaması.
2. **Yeni "MCP istemci izni" (grant) modeli** — kullanıcının hangi dış istemciye (insan tarafından adlandırılmış, ör. "Kişisel Claude Desktop'ım"), hangi kapsamda (salt-okunur, hangi nesne tipleri) erişim verdiğini kaydeden, oluşturulabilir/iptal edilebilir bir kayıt (ADR-0024 grant/revoke desenine benzer, yeni bir varlık için).
3. **MCP sunucusu wiring'i** — `McpServer` + `StreamableHTTPServerTransport` kullanan yeni bir HTTP uç noktası, en az bir tool: `get_context` (mevcut `ContextService.getContext`'i saran).
4. **Inbound oran sınırlama** — `rate-limit-math.ts`'in yeniden kullanıldığı, `(workspaceId, mcpClientId)` anahtarlı yeni bir servis.
5. **Token yönetimi UI'ı** — kullanıcının kendi MCP erişim anahtarlarını oluşturup/iptal edebildiği yeni bir panel (`IntegrationsPanel.tsx`'in görsel/etkileşim desenine benzer, yeni bir bileşen).
6. **`architect` ile ADR-0028**: kimlik doğrulama modeli seçimi, kapsam/scope tasarımı, transport/endpoint şekli, v0'da hangi tool'ların dahil edileceği kararları insan onayından önce yazılır.

## Kapsam DIŞI

- **Kurumlar-arası federasyon (F3-T14, Kapsam Q'nun tamamı)** — bu görev yalnızca TEK workspace/TEK kullanıcı için token-tabanlı erişimin v0'ı; çift-taraflı denetim günlüğü, kurumlar-arası paylaşılan proje alanı kavramı F3-T14'e ertelenir.
- **Yazma/mutasyon tool'ları** — v0 SALT-OKUNUR (bkz. Açık Soru 4) — dış bir istemcinin workspace'e veri YAZMASI bu görevde kurulmaz.
- **OAuth2 client-credentials/resource-server tam akışı** (eğer Açık Soru 1'in kararı basit PAT ise) — gelecekte gerçek kurumlar-arası federasyon için daha güçlü bir akış gerekebilir, ama v0'da PAT yeterli kabul edilirse bu ertelenir.
- **Bellek Pasaportu'nun (F2-E2) MCP üzerinden sunulması** — v0 yalnızca Context API'yi (nesneler/ilişkiler) sarar; bellek kayıtlarının aynı sunucudan sunulup sunulmayacağı ayrı bir gelecek kararı.

## Açık Sorular

1. **[KRİTİK] Kimlik doğrulama modeli: PAT mi, OAuth2 client-credentials mi?**
   - **Öneri: Kişisel Erişim Belirteci (PAT)** — kullanıcının panelden oluşturduğu, yalnızca oluşturma anında gösterilen, hash'lenmiş halde saklanan uzun-ömürlü bir Bearer token. Gerekçe: v0'ın hedefi TEK kullanıcının KENDİ MCP istemcisine (Claude Desktop gibi) erişim vermesi — bu, GitHub/Notion'ın kendi MCP sunucularının PAT emsaliyle tutarlı, tam bir OAuth2 kaynak-sunucusu akışından çok daha az karmaşık ve v0 için yeterli. Kurumlar-arası federasyon (F3-T14) gerçekleştiğinde daha güçlü bir akış (gerçek OAuth2 client-credentials) ayrı bir karar olarak değerlendirilebilir. **Hash algoritması: `argon2` DEĞİL, `sha256`** — PAT zaten ~256 bit rastgele entropi taşıdığı için (kullanıcı parolalarının aksine) argon2'nin yavaş/tuzlu hash'lemesi gereksiz; deterministik sha256, DB'de tek sorguyla tam-eşleşme aramaya izin verir (plan aşamasında netleşen düzeltme, `architect` ADR-0028'de kesinleştirir).
   - **Son kullanma tarihi (`expiresAt`, nullable):** token tablosu opsiyonel bir `expiresAt` alanı taşır — kullanıcı süresiz de seçebilir, ama panelde varsayılan/önerilen bir süre (ör. 90 gün) sunulur. Tam varsayılan süre değeri VE süresiz seçeneğinin panelde gerçekten sunulup sunulmayacağı `architect` tarafından ADR-0028'de kesinleştirilir (insan onayı, plan onayı sırasında istendi).
2. **[KRİTİK] Token workspace'e nasıl bağlanır — URL'den mi, token'ın kendisinden mi?**
   - **Öneri: Token'ın KENDİSİNDEN.** Uç nokta workspace-bağımsız bir `POST /mcp` olur (URL'de `:workspaceId` YOK); token oluşturulduğunda TEK bir workspace+kullanıcıya sabitlenir, guard token'ı çözüp `workspaceId`/`userId`'yi ORADAN alır. Gerekçe: F2-T10 PR1'in OAuth callback'inde tam olarak bu sınıftan bir güvenlik açığı bulunup düzeltilmişti (URL'deki `:connectorType` ile state'in gerçek `connectorType`'ı uyuşmazlığı) — burada da URL'deki `:workspaceId` ile token'ın gerçekte yetkili olduğu workspace'in birbirinden bağımsız iki kaynak olması AYNI risk sınıfını taşır; token'ı TEK doğruluk kaynağı yapmak bu sınıfı yapısal olarak ortadan kaldırır.
3. **[KRİTİK] v0'da hangi tool'lar/resource'lar sunulur?**
   - **Öneri: Yalnızca `get_context(objectId)`** (mevcut `ContextService.getContext`'i saran) — v0'ın tek, kanıtlanmış, <100ms performanslı birincil primitive'i. `search` tool'u (F1-T13'ün `SearchService`'ini sararak) ikinci bir PR'da eklenebilir ama v0'ın minimum kanıtlanabilir ucu-uca akışı için gerekli değil — spec Kabul Kriterleri'nde yalnızca `get_context` zorunlu tutulur, `search` "iyi olur ama zorunlu değil" olarak not düşülür.
4. **[KRİTİK] v0 salt-okunur mu?**
   - **Öneri: Evet, kesinlikle salt-okunur.** Dış bir istemcinin workspace'e yazması, bu görevin zaten yeterince büyük olan güven-sınırı yüzeyine bir mutasyon riski daha ekler — v0'ın amacı "bağlamı güvenle DIŞARI sunmak", içeri veri almak değil. Yazma tool'ları (ör. "bu MCP istemcisinden görev oluştur") tamamen ayrı, kendi ADR'sini gerektiren bir gelecek karar.
5. **Kapsam (scope) granülerliği: yalnızca "salt-okunur, tüm workspace" mi, yoksa nesne-tipi bazlı mı?**
   - **Öneri: v0'da TEK kapsam — "bu token, bu kullanıcının workspace'teki GÖREBİLDİĞİ her şeyi salt-okunur görebilir"** (yani mevcut alan-bazlı izin süzgeci zaten uygulanıyor, YENİ bir kısıtlama katmanı icat edilmiyor). Nesne-tipi bazlı ince kapsamlama (ör. "yalnızca `doc` tipi") gerçek bir kullanım ihtiyacı ortaya çıkarsa ayrı bir gelecek görev.
6. **Inbound oran sınırı varsayılanı nedir?**
   - **Öneri: `ConnectorRateLimitService`'in mevcut varsayılanlarıyla aynı** (60/dk, token-bucket) — yeni bir sabit icat edilmez, `rate-limit-math.ts` yeniden kullanılır.
7. **Token yönetimi UI'ı nerede yaşar?**
   - **Öneri: `IntegrationsPanel.tsx`'e komşu, yeni bir `McpAccessPanel.tsx`** — aynı düz-JSX yerleşim deseni (`App.tsx`'e sibling), ayrı bir bileşen (kavramsal olarak "dışarıdan bağlanan bağlayıcılar" ile "dışarıya erişim veren token'lar" farklı yönler, aynı panelde karıştırılmaz).

## Kabul Kriterleri

- [x] Açık Soru 1-7'nin insan kararları ADR-0028'de kayıt altına alındı ve `architect` tarafından insan onayından önce taslak olarak sunuldu.
- [x] Kullanıcı panelden bir MCP erişim token'ı oluşturabilir (yalnızca oluşturma anında düz metin gösterilir, sonrasında yalnızca hash saklanır) ve iptal edebilir.
- [x] `POST /mcp` (workspace-bağımsız URL) yalnızca geçerli, iptal edilmemiş bir Bearer token ile çalışır; token workspace+kullanıcıyı KENDİSİ taşır (URL'den değil).
- [x] Bir MCP istemcisi `get_context` tool'unu çağırdığında, tam olarak o token'ın sahibi kullanıcının GÖREBİLDİĞİ alan-bazlı izin süzgecinden geçmiş sonuç döner — hiçbir gizli alan sızmaz.
- [x] İptal edilmiş bir token ile yapılan çağrı reddedilir (401), hiçbir bağlam verisi sızdırmaz.
- [x] Süresi geçmiş (`expiresAt <= now`) bir token ile yapılan çağrı reddedilir (401), hiçbir bağlam verisi sızdırmaz.
- [x] Inbound oran sınırı aşıldığında istek reddedilir (bypass edilemez).
- [x] v0 salt-okunur — hiçbir mutasyon tool'u/resource'u sunulmaz.
- [x] Testler: token oluşturma/iptal, cross-user/cross-workspace izolasyon (bir kullanıcının token'ıyla başka bir workspace'e erişilemediği), izin-süzgeçli alan filtrelemesinin MCP yanıtında da korunduğu, oran sınırı, iptal-sonrası-red senaryoları.
- [x] `security-reviewer` denetiminde bulgu yok (özellikle: token hash'leme, cross-user/cross-workspace izolasyon, alan-bazlı izin sızıntısı, oran sınırı bypass).
- [x] `pnpm typecheck && pnpm lint && pnpm test:changed` yeşil.

---

**Sıradaki adım:** F2-E3 (MCP-native Entegrasyon) epiği tamamlandı (F2-T9 → F2-T12). Sıradaki epik: **F2-E4 (Toplantı Zekâsı, Kapsam H)** — F2-T13, Notetaker botu (Meet/Zoom/Teams; ad hoc link yapıştırma dahil). Görev spec dosyası henüz yazılmadı; sıradaki oturumda şu komutla başlanabilir:

```
docs/specs/F2-E4/F2-T13-notetaker-botu.md spec dosyasını yaz, sonra Plan Mode ile F2-T13'ü planla.
```
