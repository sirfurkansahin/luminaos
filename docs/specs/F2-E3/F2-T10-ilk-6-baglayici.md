# F2-T10 — İlk Gerçek MCP Bağlayıcıları: Google Drive, Gmail, Slack, GitHub, Notion

**Epik:** F2-E3 (MCP-native Entegrasyon, Kapsam G) · **Durum:** Taslak — insan onayına sunuluyor.
**Bağımlılık:** F2-T9 (MCP İstemci Çatısı, Tamamlandı) — `McpConnector`/`McpConnectorRegistry`/`MockMcpConnector` (`packages/integrations/src/mcp/`), `ConnectorCredentialsService`/`ConnectorRateLimitService`/`ConnectorHealthService`/`IntegrationsModule` (`apps/server/src/integrations/`, henüz `app.module.ts`'e bağlı değil), `connector_credentials`/`connector_rate_limit_buckets` tabloları (ADR-0025). Ayrıca `apps/server/src/calendar/` (ADR-0012 — OAuth token şifreleme/DI-fabrikası emsali, `CalendarConnector` bu görevde DOKUNULMAZ), `packages/shared/src/secrets/token-encryption.ts`.

> ⚠️ MİMARİ-KRİTİK GÖREV: CLAUDE.md'nin ADR kriterinin HER İKİ fıkrasına giriyor. (a) Bu görev LuminaOS'e İLK KEZ gerçek, canlı dış OAuth kimlik bilgisi (6 farklı sağlayıcı için CLIENT_ID/SECRET) ve gerçek ağ üzerinden dış MCP sunucusu bağlantısı getiriyor — "Mimari Değişmezler"in "hassas veri sınıfları buluta ham gönderilmez" ve "her dış girdi (MCP dahil) zod ile doğrulanır" maddeleriyle doğrudan kesişiyor, ADR-0012'nin OAuth/şifreleme emsalinin ilk gerçek-dünya sınaması. (b) Bu görevin kuracağı "bağlayıcı-başına OAuth akışı + gerçek transport" sözleşmesi F2-T11'in (Connected Search) doğrudan tükettiği bir temel. `architect` taslağı + insan onayı koddan önce zorunlu.

## Amaç

F2-T9'un kurduğu çatıyı (bağlayıcı yaşam döngüsü, şifreli kimlik-bilgisi saklama, oran sınırı, sağlık kontrolü) gerçek, canlı dış servislere bağlayan somut `McpConnector` implementasyonları kurmak: Google Drive, Gmail, Slack, GitHub, Notion — her biri kendi OAuth2 akışı ve gerçek MCP sunucusuyla uçtan uca çalışır durumda.

## Mevcut Durum

- **F2-T9'un çatısı hazır ama hiç gerçek bağlayıcı yok.** `packages/integrations/src/mcp/`'de yalnızca `MockMcpConnector` (bellek-içi, sabit fixture) var. `IntegrationsModule` (`apps/server/src/integrations/`) `app.module.ts`'e bağlı DEĞİL — bugün hiçbir HTTP isteği bu servislere ulaşamıyor (ADR-0025 §n'in bilinçli kapsam sınırı, bu görevin kapatması beklenen boşluk).
- **Bu ortamda hiçbir dış OAuth uygulaması kayıtlı değil.** `apps/server/src/config/env.ts`'te Google/Slack/GitHub/Notion için `CLIENT_ID`/`CLIENT_SECRET` yok; hiçbir yerde gerçek bir OAuth `redirect_uri` tanımlı değil. Bu, ADR-0012'nin (F1-T12, Takvim) BİREBİR yaşadığı durumla aynı: o görev de "gerçek OAuth kimlik bilgisi / test ortamı yok" gerekçesiyle gerçek Google/Outlook adaptörlerini kalıcı olarak ERTELEDİ (`calendar-connector.module.ts` bugün hâlâ sabit `new MockCalendarConnector()` döndüren bir PLACEHOLDER — aylar sonra bile gerçek adaptör hiç yazılmadı). Bu görev, AYNI karara mı varacak yoksa bu sefer FARKLI bir yol mu izleyecek, Açık Soru 1'de insana soruluyor.
- **Web araştırması (2026-08), birincil kaynaklara karşı doğrulanmış** (ilk geçiş SEO-blog agregatörlerine dayanıyordu, insan bunu haklı olarak sorguladı — ikinci geçiş resmi kaynaklara karşı teyit edildi):
  - **Gmail/Drive:** Google-barındırmalı, resmi (`gmailmcp.googleapis.com`, `drivemcp.googleapis.com`), belgeler `developers.google.com`'da. Bu, üçüncü-parti topluluk projesi `taylorwilsdon/google_workspace_mcp` İLE KARIŞTIRILMAMALI — o proje KULLANILMAYACAK. **Kısıt:** her ikisi de hâlâ **Developer Preview** statüsünde (GA DEĞİL) — kullanabilmek için Google Cloud projesinin Google Workspace MCP Developer Preview Programı'na kayıtlı olması gerekiyor (insanın kod-dışı yapması gereken bir adım).
  - **GitHub:** Resmi, GitHub-barındırmalı (`api.githubcopilot.com/mcp/`, GA). **Kısıt:** bir GitHub Copilot lisansı (Free/Pro/Business/Enterprise) GEREKTİRİYOR VE hesabın MCP erişimi için sınırlı-rollout'a dahil olması gerekiyor — salt bir PAT yetmiyor.
  - **Slack:** Resmi, Slack-barındırmalı (`mcp.slack.com/mcp`, 2026-02-17 GA), OAuth 2.0 + workspace-admin onay akışı arkasında.
  - **Notion:** Resmi, Notion-barındırmalı (`mcp.notion.com`, `developers.notion.com/guides/mcp/overview`), `notion.so/my-integrations`'ta serbestçe (self-serve, ücretsiz, admin onayı gerektirmeden) entegrasyon oluşturulabiliyor.
  - Hepsi Streamable HTTP üzerinden erişilebilir — yerel süreç (stdio) spawn etmeye GEREK YOK, `@modelcontextprotocol/sdk`'nin `StreamableHTTPClientTransport`'u ile doğrudan bağlanılabilir. Bu, F2-T9'un `McpConnector.connect()` sözleşmesini (transport'u kasıtlı olarak soyutlayan) gerçek bir implementasyonla doldurmayı mimari açıdan mümkün kılıyor — F1-T12'nin Outlook/Google Calendar döneminde (2026-08-07) hiç böyle bir seçenek yoktu.
  - **Sonuç:** referans/ilk-kanıtlanan bağlayıcı GitHub DEĞİL, **Notion** olmalı — Notion'ın self-serve/lisanssız/admin-onaysız akışı, insanın gerçek kimlik bilgisiyle manuel duman testi yapabilmesini garanti ediyor; GitHub'ınki garanti etmiyor (Copilot lisansı + sınırlı-rollout'a bağlı).
- **`@modelcontextprotocol/sdk` (`^1.30.0`) zaten `packages/integrations`'ın bağımlılığı** (F2-T9 PR1) ama bugüne kadar yalnızca tip/arayüz seviyesinde referans alındı — hiçbir kod SDK'nin gerçek `Client`/transport sınıflarını örneklemedi.
- **OAuth token şifreleme + saklama emsali olgun ve doğrudan yeniden kullanılabilir:** `ConnectorCredentialsService` (F2-T9) zaten `(workspaceId, userId, connectorType)` üçlüsüne göre şifreli saklama/geri-alma sağlıyor — bu görev yalnızca her bağlayıcının OAuth `access_token`/`refresh_token`'ını BUNUN üzerinden geçirir, yeni bir şifreleme mekanizması KURULMAZ.
- **Oran sınırı ve sağlık kontrolü de hazır** (`ConnectorRateLimitService`, `ConnectorHealthService`) — bu görev yalnızca her yeni bağlayıcıyı `McpConnectorRegistry`'ye kaydeder, iki servisi TÜKETİR, değiştirmez.

## Kapsam

1. **Gerçek `McpConnector` implementasyonları (5 adet — bkz. Açık Soru 4):** Google Drive, Gmail, Slack, GitHub, Notion. Her biri `StreamableHTTPClientTransport` ile ilgili sağlayıcının uzak MCP sunucusuna bağlanır; `callTool`/`readResource` sonuçları zod ile doğrulanır (ADR-0025'in zaten sabitlediği `McpConnector` sözleşimi gereği).
2. **Bağlayıcı-başına OAuth2 authorization-code akışı:** `/workspaces/:workspaceId/integrations/:connectorType/oauth/authorize` (yönlendirme başlatır) + `/workspaces/:workspaceId/integrations/:connectorType/oauth/callback` (kod↔token değişimi, `ConnectorCredentialsService.store` ile şifreli saklama). Bu, ADR-0025 §n'in F2-T10'a bıraktığı İLK public REST uç noktası.
3. **OAuth uygulama kimlik bilgileri yapılandırması:** her sağlayıcı için `env.ts`'e `CLIENT_ID`/`CLIENT_SECRET` (ADR-0012'nin `ENCRYPTION_KEY` desenine benzer, ama connector başına opsiyonel — bkz. Açık Soru 1).
4. **`IntegrationsModule`'ün `app.module.ts`'e bağlanması** — F2-T9'un bilinçli olarak ertelediği adım.
5. **DI-fabrikası deseni (env-gated):** `CalendarConnectorModule`'ün `useFactory` desenini izleyerek, her bağlayıcı için CLIENT_ID/SECRET yapılandırılmışsa gerçek implementasyon, yapılandırılmamışsa `MockMcpConnector` döner.
6. **Minimal "Entegrasyonlar" ayarlar ekranı (`apps/web`):** bağlı/bağlı-değil durumu listeleyen, bağlan/bağlantı-kes düğmeleri olan bir panel (`CalendarAccountsController`/`MemoryPassportPanel`'in UI emsali).
7. **ADR:** `architect` ile transport modeli, OAuth akış şekli, DI-fabrikası deseni, credential-yapılandırma şekli insan onayından önce yazılır.

## Kapsam DIŞI

- **Takvimler (Google Calendar/Outlook)** — bkz. Açık Soru 3: ADR-0012'nin `CalendarConnector`'ı bu görevde DOKUNULMAZ; MCP-tabanlı bir takvim bağlayıcısına geçiş (varsa) ayrı, gelecekteki bir karar.
- **Connected Search (birleşik iç+dış arama)** — F2-T11'in kapsamı; bu görev yalnızca bağlayıcıları kurar, hiçbir arama/AI özelliği bunları TÜKETMEZ (F2-T8'in "yayınla şimdi, tüket sonra" deseniyle tutarlı).
- **LuminaOS'in kendi MCP sunucusu** — F2-T12.
- **Gerçek OAuth uygulamalarının Google/Slack/GitHub/Notion konsollarında KAYDI** — bu insanın yapması gereken, kod-dışı bir adım (bkz. Açık Soru 1); bu görev yalnızca kodu, kimlik bilgileri env'e girildiğinde ÇALIŞACAK şekilde hazırlar.
- **Ajan Runtime'ın bu bağlayıcıları nasıl kullanacağı** (F3-T1) — henüz yok, Faz 3.

## Açık Sorular

1. **[KRİTİK] Gerçek OAuth kimlik bilgisi bu ortamda yok — Kabul Kriterleri neye karşı kanıtlanacak?**
   - **Öneri:** ADR-0012'nin (Takvim) desenini izle, ama TAMAMEN aynı sonuca varma: gerçek bağlayıcı KODU (OAuth2 authorization-code değişimi, `StreamableHTTPClientTransport` bağlantısı, zod-doğrulamalı `callTool`/`readResource`) TAM yazılır — Mock'a ERTELENMEZ — çünkü artık (ADR-0012 döneminden farklı olarak) gerçek sağlayıcı uç noktaları/protokolü belgeli ve doğrulanabilir (bkz. Mevcut Durum'daki araştırma). Ama Kabul Kriterleri'nin OTOMATİZE TESTLERİ yine Mock'a/sahte bir HTTP sunucusuna (ör. `msw` veya elle yazılmış bir test-only Streamable HTTP sunucusu) karşı kanıtlanır — gerçek Google/Slack/GitHub/Notion hesaplarıyla canlı doğrulama bu oturumda YAPILAMAZ (kimlik bilgisi yok). İnsan, gerçek OAuth uygulamalarını kaydedip env'e CLIENT_ID/SECRET girdiğinde, DI-fabrikası otomatik gerçek bağlayıcıya geçer ve insan kendi hesabıyla manuel duman testi (smoke test) yapar — bu, ADR-0012 §d'nin "Mock-öncelikli, insan sonradan doğrular" mirasının doğrudan devamı.
2. **[KRİTİK] Transport modeli tüm bağlayıcılarda tek tip mi?**
   - **Öneri:** EVET — `@modelcontextprotocol/sdk`'nin `StreamableHTTPClientTransport`'u 5 bağlayıcının hepsinde kullanılır (birincil kaynaklara karşı doğrulandı, bkz. Mevcut Durum); bağlayıcılar yalnızca kendi sunucu URL'si, OAuth scope'ları ve token-değişim uç noktalarıyla farklılaşır. Paylaşılan bir taban yardımcı (`createStreamableHttpMcpConnector(config)` gibi) 5 bağlayıcı arasındaki tekrarı azaltabilir — kesin şekli `architect`/`implementer`'a bırakılır. **Referans/ilk-kanıtlanan bağlayıcı GitHub değil, Notion olmalı** — GitHub'ın resmi sunucusu bir Copilot lisansı + sınırlı-rollout hesap erişimi gerektiriyor (insan bunu garantili sağlayamayabilir), Notion'ınki self-serve/lisanssız/admin-onaysız.
3. **[KRİTİK] "Takvimler" bu görevde mi ele alınıyor?**
   - **Öneri:** HAYIR — `docs/PLAN.md`'nin F2-T10 satırı 6 kalemi sayıyor ama "Takvimler" zaten ADR-0012 ile ÇÖZÜLMÜŞ, olgun, üretimde bir entegrasyon (yalnızca Mock arkasında, insanın gerçek OAuth eklemesini bekliyor — bu görevin diğer 5'i gibi). MCP-registry'ye ayrı bir kayıt eklemek (`CalendarConnector`'ı `McpConnector`'a sarmalamak) kavramsal karışıklık yaratır (F2-T9 spec'inin kendi Kapsam Dışı maddesiyle tutarlı: "`CalendarConnector`'ın MCP-tabanlı bir bağlayıcıya taşınması bu görevin kapsamında değil"). Bu görev 5 YENİ bağlayıcıyla sınırlı: Google Drive, Gmail, Slack, GitHub, Notion.
4. OAuth kimlik bilgileri (CLIENT_ID/SECRET) uygulama-seviyesinde mi, workspace-seviyesinde mi yapılandırılır?
   - **Öneri:** Uygulama-seviyesi env (ADR-0012'nin `ENCRYPTION_KEY` desenine benzer) — tek LuminaOS dağıtımı, tek OAuth uygulaması seti, tüm workspace'ler paylaşır. Sonuçta üretilen access/refresh token'lar zaten `(workspaceId, userId, connectorType)`'a göre ayrı ayrı saklanıyor (F2-T9, `connector_credentials`), bu yüzden kullanıcı/workspace izolasyonu bozulmaz.
5. UI kapsamı ne kadar geniş?
   - **Öneri:** Minimal — bağlı bağlayıcıları listeleyen, bağlan (OAuth yönlendirmesi başlatır) / bağlantı-kes düğmeleri olan TEK bir panel (`apps/web/src/views/shared/IntegrationsPanel.tsx` gibi). Bağlayıcı-başına özel ayar/yapılandırma ekranı (ör. hangi Slack kanalları) bu görevin kapsamı DIŞI, gerekiyorsa F2-T11'e ertelenir.

## Kabul Kriterleri

- [ ] Açık Soru 1-5'in insan kararları ADR'de kayıt altına alındı ve `architect` tarafından insan onayından önce taslak olarak sunuldu.
- [ ] Google Drive, Gmail, Slack, GitHub, Notion için `McpConnector`-uyumlu, gerçek `StreamableHTTPClientTransport` kullanan implementasyonlar var; `McpConnectorRegistry`'ye kayıtlı.
- [ ] Her bağlayıcı için OAuth2 authorization-code akışı (authorize + callback uç noktaları) çalışıyor, elde edilen token'lar `ConnectorCredentialsService` ile şifreli saklanıyor.
- [ ] CLIENT_ID/SECRET yapılandırılmamış bir bağlayıcı için sistem güvenle Mock'a düşüyor (fail-closed değil, fail-to-mock — kullanıcıya "bağlı değil" olarak görünür, sistem çökmez).
- [ ] `callTool`/`readResource` sonuçları çağıran koda ulaşmadan önce zod ile doğrulanıyor (Mimari Değişmez, ADR-0025'in zaten sabitlediği sözleşim).
- [ ] `IntegrationsModule` `app.module.ts`'e bağlı; oran sınırı ve sağlık kontrolü her yeni bağlayıcı için otomatik devrede.
- [ ] Minimal "Entegrasyonlar" ekranı: bağlı/bağlı-değil durumu görünüyor, bağlan/bağlantı-kes çalışıyor.
- [ ] Testler Mock/sahte-HTTP-sunucusuna karşı yeşil (gerçek canlı hesap gerektirmiyor); OAuth token değişimi, hata/timeout senaryoları, cross-workspace izolasyon dahil.
- [ ] GitHub bağlayıcısının Copilot-lisansı + sınırlı-rollout kısıtı VE Gmail/Drive'ın Developer Preview (GA değil, Google Workspace MCP Developer Preview Programı kaydı gerektiren) statüsü ADR'de bilinen-sınırlama olarak kayıtlı (kod tamamlanır, ama insanın canlı duman testi yapabilmesi kendi Copilot/Preview-Program durumuna bağlıdır — Slack/Notion için geçerli DEĞİL, ikisi de GA ve self-serve).
- [ ] `security-reviewer` denetiminde bulgu yok (özellikle: OAuth state/CSRF koruması, token'ların loglanmadığı, redirect_uri doğrulaması, cross-workspace/cross-user izolasyon).
- [ ] `pnpm typecheck && pnpm lint && pnpm test:changed` yeşil.

---

**Sıradaki adım:** Bu spec taslağı insan onayına sunulur. Onaylanırsa Plan Mode'a geçilip keşif `explorer` subagent'ına devredilir, ardından Açık Sorular 1-5'in insan kararları `architect` subagent'ı ile bir ADR taslağına dökülür; ADR onaylandıktan sonra `test-writer` → `implementer` → `security-reviewer` ritüeline geçilir (görevin boyutu nedeniyle muhtemelen çok-PR'lı: paylaşılan altyapı + referans bağlayıcı, sonra kalan bağlayıcılar).
