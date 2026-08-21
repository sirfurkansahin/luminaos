# F2-T11 — Connected Search: Tek Arama Çubuğunda İç + Dış Kaynak Birleşik Sonuç

**Epik:** F2-E3 (MCP-native Entegrasyon, Kapsam G) · **Durum:** Taslak — insan onayına sunuluyor.
**Bağımlılık:** F2-T10 (Tamamlandı) — 5 gerçek `McpConnector` (`packages/integrations/src/mcp/connectors/`), `ConnectorCredentialsService`/`ConnectorRateLimitService`/`ConnectorHealthService` (`apps/server/src/integrations/`), `McpConnectorRegistry` (F2-T9). Ayrıca `apps/server/src/search/` (ADR-0013 — mevcut iç hibrit arama), `apps/web/src/views/shared/CommandPalette.tsx` (mevcut tek arama çubuğu UI'ı), `apps/server/src/calendar/calendar-token-refresh.service.ts` (ADR-0012 — token yenileme emsali).

> ⚠️ MİMARİ-KRİTİK GÖREV: CLAUDE.md'nin ADR kriterinin (b) fıkrasına giriyor — bu görevin kuracağı "per-çağrı, per-kullanıcı bağlayıcı inşası" mekanizması, ADR-0026 §m'nin AÇIKÇA F2-T11'e bıraktığı, henüz kurulmamış bir sözleşim: _"F2-T11'in gerçek per-kullanıcı `callTool` akışı için registry'yi KULLANMAMASI, bunun yerine `ConnectorCredentialsService.retrieve(...)`'den okunan token'la HER ÇAĞRIDA TAZE bir somut bağlayıcı örneği inşa etmesi GEREKİR."_ Bu mekanizma, bu görevden sonra gelecek her "gerçek kullanıcı verisiyle MCP çağrısı yapan" özelliğin (F2-T12'nin sunucu tarafı hariç — o ayrı bir yön) temel alacağı bir örüntü olacağı için tek bir görevin içinde kalan bir detay değil. `architect` taslağı + insan onayı koddan önce zorunlu.

## Amaç

`apps/web/src/views/shared/CommandPalette.tsx`'in mevcut tek arama çubuğunu, F2-T10'da bağlanmış dış MCP kaynaklarından (kullanıcının kendi bağladığı Google Drive, Gmail, Slack, GitHub, Notion) gelen sonuçları da iç LuminaOS sonuçlarıyla (ADR-0013'ün hibrit arama) birleştirerek gösterecek şekilde genişletmek — ve bunu yaparken ADR-0026 §m'nin bıraktığı boşluğu (gerçek per-kullanıcı bağlayıcı çağrısı) kapatmak.

## Mevcut Durum

- **Tek arama çubuğu zaten var ve olgun: `CommandPalette.tsx`.** Cmd/Ctrl+K ile açılan modal, 250ms debounce (`useDebouncedValue`), `useSearchQuery` hook'u `searchWorkspace`'i çağırıyor, sonuçlar `type`'a göre (`GROUP_ORDER` sabit dizisi: task/doc/note/timeblock) gruplanıp Türkçe başlıklarla gösteriliyor. Ayrı bir "SearchView" YOK — `apps/web/src` içinde sıfır eşleşme. Bu görev muhtemelen yeni bir ekran değil, CommandPalette'in bir uzantısı.
- **İç arama (`SearchService`, ADR-0013) olgun ve YALNIZCA iç veri üzerinde çalışıyor.** `POST /workspaces/:workspaceId/search` — Postgres `tsvector` anahtar-kelime + brute-force kosinüs benzerliği hibrit sıralama, sabit 0.5/0.5 ağırlık, sonuç şekli `{objectId, title, type, score, snippet}`. Dış kaynak kavramı bu katmanda YOK.
- **`McpConnectorRegistry`'deki bağlayıcı örnekleri gerçek kullanıcı çağrısı için KULLANILAMAZ (ADR-0026 §m'nin bilinçli sınırı).** Her kayıtlı bağlayıcının `getAccessToken`'ı çağrılırsa `InvalidObjectStateError` fırlatıyor — registry yalnızca "bu connectorType uygulama-seviyesinde yapılandırılmış mı" sinyali taşıyor. Bugün `callTool`/`readResource`'ın `apps/server/src` içinde test dosyaları dışında SIFIR gerçek çağıranı var. Bu görev bunun İLK gerçek tüketicisi olacak.
- **Token yenileme (refresh) MCP bağlayıcıları için tamamen KURULMAMIŞ.** `ConnectorCredentialsService.retrieve()` yalnızca şifre çözüp döndürüyor — `expiresAt` kontrolü, süresi geçmiş token'ı yenileme mantığı hiçbir yerde yok. Gerçek, çalışan bir emsal var: `apps/server/src/calendar/calendar-token-refresh.service.ts`'in `ensureFreshAccessToken()`'ı — saklı token'ı çözer, `expiresAt`'i 5 dakikalık bir tampon penceresine karşı kontrol eder, gerekirse `connector.refreshToken()` çağırır, yeni token'ları şifreleyip tekrar saklar, yenileme başarısız olursa `CalendarReconnectRequiredError` fırlatır. Bu görev bu deseni MCP bağlayıcıları için mi genelleyecek, yoksa kapsam dışı mı bırakacak, Açık Soru 2'de netleştirilir.
- **Dış bağlayıcıların "arama" araçlarının sonuç şekli birleşik/yapılandırılmış DEĞİL — bu beklenenden daha büyük bir sorun.** 5 bağlayıcının hepsinin (`notion-search`, `slack-search-messages`, `github-search-issues`, `drive-search`, `gmail-search-threads`) `TOOL_RESULT_SCHEMAS`'ı BİREBİR aynı jenerik zarfı bildiriyor: `z.array(z.object({type: z.literal('text'), text: z.string()}))` — bu, MCP protokolünün kendi taşıma şeklinden (`McpToolCallResult.content: unknown`) başka bir şey değil. Başlık/URL/özet/yazar gibi ALAN-DÜZEYİNDE yapılandırılmış bir şema YOK — her bağlayıcının gerçek arama sonucu, `text` alanının içine gömülü, bağlayıcıya özgü, biçimi belirsiz serbest metin. Bu görev bu ayrıştırmayı SIFIRDAN tasarlamak zorunda, yalnızca zaten-tipli alanları yeniden eşlemek değil.
- **Oran sınırı (`ConnectorRateLimitService.assertNotRateLimited`) hiçbir gerçek çağrı yoluna BAĞLANMAMIŞ.** F2-T9'da kuruldu, bugüne kadar hiçbir servis/kontrolcü çağırmıyor. Bu görev bunun İLK gerçek tüketicisi olacak.
- **Dış veriyi görsel olarak ayırt etme emsali zaten var: `apps/web/src/views/calendar/ExternalEventChip.tsx`.** `Card` + nötr `Badge`, açıkça sürüklenemez/salt-okunur — Connected Search'ün dış sonuç satırları için yeniden kullanılabilir bir görsel desen.

## Kapsam

1. **Per-çağrı, per-kullanıcı bağlayıcı inşası (ADR-0026 §m'nin bıraktığı, ZORUNLU):** `McpConnectorRegistry`'yi BYPASS eden, `ConnectorCredentialsService.retrieve(workspaceId, userId, connectorType)`'den okunan gerçek token'la HER arama çağrısında taze bir somut bağlayıcı örneği (`new NotionMcpConnector({..., getAccessToken: async () => token})`) inşa eden bir mekanizma.
2. **Dış arama orkestrasyonu:** kullanıcının bağlı olduğu HER connectorType için (yalnızca `ConnectorCredentialsService.retrieve()`'in bir şey döndürdüğü bağlayıcılar — bağlı olmayanlar sessizce atlanır), ilgili "arama" aracını `callTool` ile çağırır. `Promise.allSettled` ile paralel — bir bağlayıcının başarısızlığı/zaman aşımı diğerlerini VEYA iç sonuçları engellemez (`HealthService`'in `withTimeout`/`Promise.allSettled` deseninin bu görevdeki genellemesi, ADR-0025 §m'nin zaten kurduğu felsefeyle tutarlı).
3. **Oran sınırı entegrasyonu:** her dış çağrıdan önce `ConnectorRateLimitService.assertNotRateLimited(workspaceId, connectorType, cost)` — aşılırsa o bağlayıcı sessizce atlanır (kullanıcıya hata göstermez, yalnızca o kaynaktan sonuç gelmez), diğer bağlayıcılar/iç sonuçlar etkilenmez.
4. **Sonuç normalizasyonu (bkz. Açık Soru 3):** her bağlayıcının opak `text` yanıtından, iç `SearchResult` şekline (`{title, snippet, ...}`) benzer, birleşik bir dış-sonuç şekli türetmek.
5. **Birleşik sunum:** `CommandPalette.tsx`'e iç sonuçların yanına "Dış Kaynaklar" (veya bağlayıcı-başına ayrı gruplar) eklenir, `ExternalEventChip`'in görsel ayırt etme desenine benzer şekilde işaretlenir.
6. **Token yenileme (bkz. Açık Soru 2):** MCP bağlayıcıları için `expiresAt` kontrolü + yenileme — `CalendarTokenRefreshService`'in deseni mi genellenir, yoksa bu görevde ERTELENİR mi.
7. **ADR:** `architect` ile per-çağrı bağlayıcı inşası mekanizmasının tam şekli, sonuç normalizasyon stratejisi, hata/zaman-aşımı davranışı insan onayından önce yazılır.

## Kapsam DIŞI

- **LuminaOS'in kendi MCP sunucusu (dışarıya bağlam sunma)** — F2-T12'nin kapsamı, bu görev yalnızca İSTEMCİ tarafı.
- **Dış sonuçların LuminaOS nesnelerine dönüştürülmesi/import edilmesi** — bu görev yalnızca ARAMA sonucu gösterir, bir dış öğeyi LuminaOS'e kalıcı olarak getirmez (F2-T7'nin İçe Aktarma sihirbazından farklı, ayrı bir kullanıcı eylemi — mevcut).
- **Dış arama sonuçlarının önbelleklenmesi/kalıcılaştırılması** — her arama gerçek zamanlı, canlı bir MCP çağrısı; sonuçlar hiçbir yerde saklanmaz (ADR-0012'nin dış takvim verisi için kurduğu "türetilmiş/atılabilir" felsefesiyle tutarlı).
- **Ajan Runtime'ın Connected Search'ü nasıl kullanacağı** (F3-T1) — henüz yok, Faz 3.

## Açık Sorular

1. **[KRİTİK] Per-çağrı bağlayıcı inşası nerede yaşar, tam şekli nedir?**
   - **Öneri:** `apps/server/src/search/` içinde yeni bir `connected-search.service.ts` (veya `mcp-search.service.ts`) — `packages/integrations`'a KOYULMAZ çünkü `ConnectorCredentialsService`'e (bir NestJS/DB servisi) bağımlı, saf paket olamaz. Her connectorType için somut sınıfı (`NotionMcpConnector` vb.) `switch`/harita ile seçip `new`'ler, `getAccessToken: async () => (await credentialsService.retrieve(...)).accessToken` ile besler. `connect()` her aramada bir kez çağrılır (bağlantı havuzlama/yeniden kullanma bu görevde KURULMAZ — YAGNI, gerekirse ayrı bir performans görevi).
2. **[KRİTİK] Token yenileme bu görevde mi kurulur, yoksa ertelenir mi?**
   - **Öneri:** ERTELE — yalnızca `expiresAt` geçmişse o bağlayıcıyı sessizce atla (dış kaynak listesinde "yeniden bağlan gerekebilir" gibi bir işaretle, ama arama sonucunu ENGELLEMEZ). Gerçek yenileme mantığı (`CalendarTokenRefreshService`'in genellemesi) kendi başına mimari-kritik bir karar (5 farklı sağlayıcının farklı refresh-token davranışları, `CalendarReconnectRequiredError`'un MCP eşdeğeri) — bu görevin kapsamını önemli ölçüde büyütür. Bu ortamda gerçek OAuth kimlik bilgisi de yok, bu yüzden yenileme akışı canlı doğrulanamaz zaten (F2-T10'un aynı gerekçesi). Ayrı bir gelecek görev olarak not düşülür.
3. **[KRİTİK] Sonuç normalizasyonu ne kadar derin?**
   - **Öneri:** MİNİMAL — her bağlayıcının `text` yanıtını OLDUĞU GİBİ bir `snippet` olarak göster (ör. ilk 300 karakter, iç `SearchResult.snippet`'in kesme uzunluğuyla tutarlı), `title` için metnin ilk satırını/ilk N karakterini kullan. Bağlayıcıya-özel derin ayrıştırma (Notion'ın gerçek sayfa başlığı, Slack'in gerçek kalıcı bağlantısı, GitHub'ın gerçek issue numarası) bu görevde KURULMAZ — sağlayıcıların gerçek MCP sunucu yanıtları bu ortamda hiç gözlemlenemediği için (gerçek kimlik bilgisi yok) böyle bir ayrıştırmayı YAZMAK, doğrulanamayan bir formatı UYDURMAK anlamına gelir (ADR-0016 §d'nin "kanıtlanmamış bir şemayı elle reverse-engineer etmeyi reddet" ilkesiyle aynı risk). Testler sahte/mock bir MCP sunucusuna karşı yazılır (F2-T10'un deseni), gerçek biçim insan gerçek kimlik bilgisi girip manuel doğruladığında netleşir — ayrıştırma o zaman derinleştirilebilir.
4. Dış sonuçlar `CommandPalette`'in mevcut `GROUP_ORDER` grup yapısına mı eklenir, yoksa ayrı bir "Dış Kaynaklar" bölümü mü olur?
   - **Öneri:** Ayrı, EN ALTTA sabit bir "Dış Kaynaklar" grubu (bağlayıcı-tipine göre alt-gruplanmış) — iç sonuçların mevcut sıralama/gruplama mantığına dokunmaz, dış sonuçlar kavramsal olarak farklı bir güven/tazelik seviyesinde (canlı ağ çağrısı, potansiyel gecikme/hata).
5. Zaman aşımı süresi ne olur?
   - **Öneri:** `HealthService`'in mevcut varsayılanı (2000ms) — arama bağlamında biraz cömert olabilir ama yeni bir sabit icat etmek yerine mevcut emsali yeniden kullan; `architect` ADR'de kesinleştirir.

## Kabul Kriterleri

- [ ] Açık Soru 1-5'in insan kararları ADR'de kayıt altına alındı ve `architect` tarafından insan onayından önce taslak olarak sunuldu.
- [ ] `McpConnectorRegistry`'yi bypass eden, gerçek kullanıcı token'ıyla per-çağrı taze bağlayıcı örneği inşa eden bir mekanizma var (ADR-0026 §m'nin bıraktığı boşluk kapatıldı).
- [ ] Kullanıcının bağlı OLMADIĞI bir connectorType için hiçbir çağrı yapılmaz (sessizce atlanır, hata fırlatmaz).
- [ ] Bir dış bağlayıcının başarısızlığı/zaman aşımı, ne diğer dış bağlayıcıları ne de iç arama sonuçlarını engeller (`Promise.allSettled` desenli, doğrulanmış).
- [ ] Her dış çağrıdan önce `ConnectorRateLimitService.assertNotRateLimited` çağrılır; aşım durumunda o kaynak sessizce atlanır.
- [ ] Dış sonuçlar `CommandPalette`'te iç sonuçlardan görsel olarak ayırt edilebilir şekilde gösterilir.
- [ ] Testler sahte/mock MCP sunucusuna karşı yeşil (gerçek canlı hesap gerektirmiyor); cross-workspace/cross-user izolasyon dahil (bir kullanıcının arama sonucunda başka bir kullanıcının kimlik bilgisiyle yapılmış çağrı ASLA yer almaz).
- [ ] `security-reviewer` denetiminde bulgu yok (özellikle: token'ların loglanmadığı, cross-user/cross-workspace izolasyon, oran-sınırı bypass edilemediği).
- [ ] `pnpm typecheck && pnpm lint && pnpm test:changed` yeşil.

---

**Sıradaki adım:** Bu spec taslağı insan onayına sunulur. Onaylanırsa Plan Mode'a geçilip keşif `explorer` subagent'ına devredilir, ardından Açık Sorular 1-5'in insan kararları `architect` subagent'ı ile bir ADR taslağına dökülür; ADR onaylandıktan sonra `test-writer` → `implementer` → `security-reviewer` ritüeline geçilir.
