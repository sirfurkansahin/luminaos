# ADR-0027: Connected Search — Per-Çağrı Bağlayıcı İnşası, Ayrı Dış-Arama Endpoint'i, Minimal Sonuç Normalizasyonu

**Durum:** Kabul edildi
**Tarih:** 2026-08-19
**İlgili görev:** [F2-T11 — Connected Search: Tek Arama Çubuğunda İç + Dış Kaynak Birleşik Sonuç](../specs/F2-E3/F2-T11-connected-search.md)
**İlgili plan referansı:** `docs/PLAN.md` §"Epik F2-E3: MCP-native Entegrasyon (Kapsam G)" (F2-T11 satırı) ve CLAUDE.md "ADR Ne Zaman Gerekir" maddesinin (b) fıkrası — bu görevin kurduğu "per-çağrı, per-kullanıcı bağlayıcı inşası" mekanizması, ADR-0026 §m'nin AÇIKÇA F2-T11'e bıraktığı, gelecekteki her "gerçek kullanıcı verisiyle MCP çağrısı yapan" özelliğin temel alacağı bir sözleşim (spec'in başlığındaki ⚠️ MİMARİ-KRİTİK GÖREV notu).

> Bu ADR'nin kararları, spec'in (`F2-T11-connected-search.md`) Açık Sorular 1-5'ine plan onayında verilen yanıtları AYNEN kayda geçiriyor — icat etmiyor. ADR'nin kendi katkısı: bu kararların somut dosya/sınıf/endpoint şekli, mevcut kod tabanındaki gerçek emsallerle (ADR-0025/ADR-0026, `ConnectorHealthService`, `CalendarConnectorModule`, `CommandPalette`) hizalanmış biçimde.

## Bağlam

1. **ADR-0026 §m'nin bıraktığı boşluk:** `McpConnectorRegistry`'deki 5 bağlayıcı örneği, yalnızca "bu connectorType uygulama-seviyesinde yapılandırılmış" sinyali taşıyor — `getAccessToken` çağrılırsa `InvalidObjectStateError` fırlatıyor (`apps/server/src/integrations/mcp-connectors.module.ts`). Registry, gerçek kullanıcı `callTool` akışı için KULLANILAMAZ; bu ADR'nin ilk sorumluluğu bu boşluğu kapatmak.
2. **`ConnectorCredentialsService.retrieve(workspaceId, userId, connectorType)`** (`apps/server/src/integrations/connector-credentials.service.ts`), var olan bir satır için `Record<string, unknown> | undefined` döner — hiçbir satır yoksa `undefined`, şifreli metni asla dışarı sızdırmaz. `mcp-oauth.controller.ts` bu blob'u `{accessToken, refreshToken?, expiresAt?}` şeklinde saklıyor (`accessToken: tokenResult.accessToken`, `expiresAt` ISO-8601 string, `oauth2-authorization-code-flow.ts`'in ürettiği şekil) — bu ADR'nin credentials'ı okuma/yorumlama şekli bu somut sözleşime dayanıyor.
3. **`ConnectorRateLimitService.assertNotRateLimited(workspaceId, connectorType, cost)`** (`apps/server/src/integrations/connector-rate-limit.service.ts`) hâlâ HİÇBİR gerçek çağrı yolundan tüketilmiyor (ADR-0025 §l kuruldu ama F2-T9'dan bu yana çağıransız) — bu görev bunun İLK gerçek tüketicisi.
4. **5 somut bağlayıcı sınıfı** `packages/integrations/src/mcp/connectors/` içinde tam yazılı ve testli (F2-T10): `NotionMcpConnector`, `GoogleDriveMcpConnector`, `GmailMcpConnector`, `SlackMcpConnector`, `GithubMcpConnector`. Hepsi `StreamableHttpMcpConnector`'ı (ADR-0026 §g) genişletiyor, `{connectorType, serverUrl, getAccessToken: () => Promise<string>}` ile inşa ediliyor. Her birinin arama aracının TOOL_RESULT_SCHEMAS'taki adı ve şeması BİREBİR aynı opak zarf:
   - `notion-search`, `drive-search`, `gmail-search-threads`, `slack-search-messages`, `github-search-issues` → hepsi `z.array(z.object({ type: z.literal('text'), text: z.string() }))`.
5. **`ConnectorHealthService.checkAll()`** (`apps/server/src/integrations/connector-health.service.ts`) zaten `withTimeout` (varsayılan 2000ms) + `Promise.allSettled` desenini registry'deki HER bağlayıcı için uyguluyor — bir bağlayıcının zaman aşımı/hatası diğerlerini engellemiyor, başarısız/timeout olan `{status:'error'}` döner. Bu görevin dış-arama orkestrasyonu AYNI izolasyon deseni.
6. **Sunucu URL'leri bugün DRY DEĞİL:** `mcp-connectors.module.ts` içinde 5 sabit URL (`https://mcp.notion.com`, `https://drivemcp.googleapis.com/mcp/v1`, `https://gmailmcp.googleapis.com/mcp/v1`, `https://mcp.slack.com/mcp`, `https://api.githubcopilot.com/mcp/`) hardcoded — bu görevin yeni servisi AYNI URL'lere ihtiyaç duyuyor, ikinci bir hardcode kopyası kabul edilemez.
7. **`CommandPalette.tsx`** (`apps/web/src/views/shared/`) olgun: `useSearchQuery(workspaceId, debouncedQuery)` → `GROUP_ORDER` sabit dizisiyle gruplanmış `SearchResult[]`, `flatResults` ok-tuşu navigasyonu + `selectResult`. `ExternalEventChip.tsx` (`apps/web/src/views/calendar/`) dış veri için görsel ayırt etme emsali: `Card` + nötr `Badge`, sürüklenemez/salt-okunur, navigasyon state'ine hiç girmiyor.
8. **ADR-0012'nin "türetilmiş/atılabilir" felsefesi** (dış takvim verisi hiçbir yerde olay-günlüğüne yazılmaz, her okuma canlı bir read-through) bu ADR'nin dış arama sonuçları için BİREBİR benimsediği felsefe — "Mimari Değişmezler"in "tek doğruluk kaynağı olay günlüğüdür" maddesiyle çelişmiyor çünkü bu veri hiçbir zaman kalıcı LuminaOS durumu haline gelmiyor.

## Karar

### (a) Per-çağrı, per-kullanıcı bağlayıcı inşası — `ConnectedSearchService`, registry TAMAMEN bypass edilir

Yeni `apps/server/src/search/connected-search.service.ts`:

```ts
const KNOWN_CONNECTOR_TYPES = ['notion', 'google-drive', 'gmail', 'slack', 'github'] as const;
type KnownConnectorType = (typeof KNOWN_CONNECTOR_TYPES)[number];

const SEARCH_TOOL_NAMES: Record<KnownConnectorType, string> = {
  notion: 'notion-search',
  'google-drive': 'drive-search',
  gmail: 'gmail-search-threads',
  slack: 'slack-search-messages',
  github: 'github-search-issues',
};

export interface ExternalSearchResult {
  connectorType: string;
  title: string;
  snippet: string;
}

export interface ConnectedSearchResponse {
  results: ExternalSearchResult[];
  /** connectorType'ların, süresi geçmiş token VEYA oran sınırı VEYA çağrı
   * hatası/zaman-aşımı nedeniyle atlandığı listesi. */
  degraded: string[];
}

@Injectable()
export class ConnectedSearchService {
  constructor(
    private readonly credentials: ConnectorCredentialsService,
    private readonly rateLimit: ConnectorRateLimitService,
  ) {}

  async searchExternal(
    workspaceId: string,
    userId: string,
    query: string,
  ): Promise<ConnectedSearchResponse> {
    /* Karar (e) */
  }

  /** connectorType→somut-sınıf switch; her çağrıda TAZE bir örnek. */
  private buildConnector(connectorType: KnownConnectorType, accessToken: string): McpConnector {
    switch (connectorType) {
      case 'notion':
        return new NotionMcpConnector({
          connectorType: 'notion',
          serverUrl: MCP_CONNECTOR_SERVER_URLS.notion,
          getAccessToken: async () => accessToken,
        });
      // ... google-drive / gmail / slack / github aynı desen
    }
  }
}
```

`McpConnectorsModule`'ün DI token'ları (`NOTION_MCP_CONNECTOR` vb.) HİÇ enjekte edilmez/resolve edilmez — bu servis registry'nin varlığından habersiz. Gerekçe (ADR-0026 §m'nin açıkça bıraktığı yön): registry'deki paylaşılan örnek hiçbir kullanıcıya ait değil; gerçek per-kullanıcı `callTool` yalnızca `ConnectorCredentialsService.retrieve()`'den okunan gerçek token'la TAZE bir örnek inşa ederek güvenli.

**Bağlantı havuzlama/yeniden kullanma YOK** — her arama = taze `connect()`→`callTool()`→`finally { disconnect() }` döngüsü. YAGNI: bu görev framework-only bir performans optimizasyonu icat etmiyor; bir sonraki arama isteği tamamen yeni bir örnek, yeni bir TCP/handshake maliyetiyle başlar. Performans gerekirse ayrı bir gelecek görev (Bilinen Sınırlamalar §c).

### (b) Sunucu URL'leri DRY refaktörü — `MCP_CONNECTOR_SERVER_URLS`

Yeni `packages/integrations/src/mcp/mcp-connector-server-urls.ts`:

```ts
export const MCP_CONNECTOR_SERVER_URLS: Record<
  'notion' | 'google-drive' | 'gmail' | 'slack' | 'github',
  string
> = {
  notion: 'https://mcp.notion.com',
  'google-drive': 'https://drivemcp.googleapis.com/mcp/v1',
  gmail: 'https://gmailmcp.googleapis.com/mcp/v1',
  slack: 'https://mcp.slack.com/mcp',
  github: 'https://api.githubcopilot.com/mcp/',
};
```

`packages/integrations/src/index.ts`'den export edilir. `apps/server/src/integrations/mcp-connectors.module.ts`, kendi 5 `serverUrl: 'https://...'` satırını bu sabitle DEĞİŞTİRİR (`serverUrl: MCP_CONNECTOR_SERVER_URLS.notion` vb.) — davranış değişmez, saf refaktör. Yeni `ConnectedSearchService.buildConnector` AYNI sabiti kullanır. Bu, "iki yerde aynı 5 URL hardcoded" durumunu ortadan kaldıran, kendi başına yeni bir mimari karar taşımayan mekanik bir DRY adımı.

### (c) Ayrı endpoint — `POST /workspaces/:workspaceId/search/external`, iç aramayla BİRLEŞTİRİLMEZ

`SearchController`'a (`apps/server/src/search/search.controller.ts`) ikinci bir route eklenir, AYNI guard yığını:

```ts
@Controller('workspaces/:workspaceId/search')
@UseGuards(SessionAuthGuard, WorkspaceMembershipGuard)
export class SearchController {
  constructor(
    private readonly searchService: SearchService,
    private readonly connectedSearchService: ConnectedSearchService,
  ) {}

  @Post() /* mevcut iç arama, değişmez */
  @Post('external')
  @HttpCode(HttpStatus.OK)
  async searchExternal(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @CurrentUser() userId: string, // SessionAuthGuard'ın enjekte ettiği kimlik — ASLA body/query'den
    @Body(new ZodValidationPipe(searchExternalSchema)) body: SearchExternalInput,
  ): Promise<ConnectedSearchResponse> {
    return this.connectedSearchService.searchExternal(workspaceId, userId, body.query);
  }
}
```

`userId` HER ZAMAN authenticated session'dan gelir — spec'in Kabul Kriteri'nin "cross-workspace/cross-user izolasyon" şartının ta kendisi, `AuthController`'ın mevcut oturum-kimliği enjeksiyon deseninin doğrudan bir uygulaması.

**Gerekçe (neden tek bir birleşik endpoint DEĞİL):** İç arama (Postgres `tsvector`+kosinüs, ~10-50ms, ADR-0013) ve dış arama (canlı ağ, bağlayıcı başına 2sn'ye kadar zaman aşımı, Karar e) çok farklı gecikme/güven katmanları. Aynı endpoint'e gömülürse iç aramanın anlık hissi en yavaş/en sağlıksız bağlayıcıya kilitlenir — `Promise.all`'la tek yanıt beklenirse iç sonuçlar bile dış bir sağlayıcının 2sn zaman aşımını bekler. Frontend paralel iki query ateşler (Karar f), iç sonuçlar HER ZAMAN önce render olur.

### (d) Minimal sonuç normalizasyonu — derin per-connector ayrıştırma YOK

5 bağlayıcının hepsinin arama aracı sonuç şeması ALAN-DÜZEYİNDE title/url/yazar TAŞIMIYOR (Bağlam madde 4) — yalnızca `content: Array<{type:'text', text:string}>`. `ConnectedSearchService`, `content` dizisindeki `text` alanlarını `'\n'` ile birleştirip:

- `title`: birleşik metnin ilk ~80 karakteri (kelime sınırında kesilir, `…` eklenmez — `SearchService`'in kendi `snippet`'inin `.slice(0, 300)` sadeliğiyle tutarlı, ekstra "temiz kesme" mantığı icat edilmez).
- `snippet`: birleşik metnin ilk ~300 karakteri (`SearchService.search`'ün `(entry.docText ?? '').slice(0, 300)` kesme uzunluğuyla BİREBİR aynı sabit — iki farklı kesme uzunluğu icat edip tutarsızlık yaratmamak için).

**Gerekçe:** bu ortamda hiçbir sağlayıcının GERÇEK MCP sunucu yanıtı hiç gözlemlenemedi (gerçek OAuth kimlik bilgisi yok, F2-T10'un aynı kısıtı). Bağlayıcıya-özel derin ayrıştırma (Notion'ın gerçek sayfa başlığı, Slack'in kalıcı bağlantısı, GitHub'ın issue numarası) yazmak, doğrulanamayan bir formatı UYDURMAK anlamına gelirdi — ADR-0016 §d'nin "kanıtlanmamış bir şemayı elle reverse-engineer etmeyi reddet" ilkesiyle aynı risk. Format insan gerçek kimlik bilgisiyle manuel doğruladığında derinleştirilebilir (Bilinen Sınırlamalar §a).

### (e) Süresi geçmiş/oran-sınırlı bağlayıcılar — sessizce atla + `degraded[]`, `Promise.allSettled`, token yenileme KURULMAZ

`searchExternal`'ın tam akışı, `KNOWN_CONNECTOR_TYPES`'ın HER biri için:

1. `credentials.retrieve(workspaceId, userId, connectorType)` — `undefined` ise (kullanıcı bu bağlayıcıya hiç bağlanmamış) sessizce ATLA, `degraded`'e EKLEME (bu bir bozulma değil, "hiç bağlı değil" beklenen durum).
2. Bağlıysa: `expiresAt` alanı VARSA ve geçmişse (`new Date(credentials.expiresAt) <= new Date()`) → `degraded.push(connectorType)`, ATLA. Token yenileme (MCP `refreshToken` akışı) bu görevde BİLİNÇLİ olarak KURULMAZ.
3. `rateLimit.assertNotRateLimited(workspaceId, connectorType, 1)` — `QuotaExceededError` fırlatırsa yakala, `degraded.push(connectorType)`, ATLA.
4. Kalan her connectorType için: `buildConnector` (Karar a) → `connect()` → `callTool(SEARCH_TOOL_NAMES[connectorType], {query})` → normalize et (Karar d) → `finally { await connector.disconnect() }`. Bu adım `Promise.allSettled` ile TÜM connectorType'lar için PARALEL çalıştırılır — `ConnectorHealthService.checkAll()`'daki AYNI izolasyon deseni (bir bağlayıcının hatası/zaman aşımı diğerlerini VEYA iç sonuçları ASLA engellemez). Reddedilen/hata veren her promise → `degraded.push(connectorType)`.
5. Zaman aşımı: `ConnectorHealthService`'in AYNI varsayılan **2000ms**'i, kendi `withTimeout` kopyası ile (yeni bir sabit icat edilmez — spec'in Açık Soru 5'inin önerisi aynen kabul edildi).

**Token yenileme neden bu görevde KURULMAZ:** gerçek yenileme mantığı (`CalendarTokenRefreshService`'in MCP eşdeğeri) kendi başına mimari-kritik bir karar — 5 farklı sağlayıcının refresh davranışı farklı (bazıları refresh_token döndürmüyor bile, `oauth2-authorization-code-flow.ts`'in `refreshToken?` alanının `optional` olması bunun kanıtı), `CalendarReconnectRequiredError`'ın MCP eşdeğeri ayrı bir tasarım gerektirir. Bu görev yalnızca `expiresAt` kontrolü yapar, geçmişse atlar — kullanıcı manuel olarak yeniden bağlanana kadar o kaynak `degraded`'de kalır (Bilinen Sınırlamalar §b).

### (f) Frontend — paralel iki query, dış sonuçlar navigasyona DAHİL EDİLMEZ

`apps/web/src/lib/apiClient.ts`'e `searchWorkspace`'in AYNI desenle yeni bir fonksiyon:

```ts
export function searchExternalWorkspace(
  workspaceId: string,
  query: string,
): Promise<ConnectedSearchResponse> {
  return request<ConnectedSearchResponse>(
    `/workspaces/${encodeURIComponent(workspaceId)}/search/external`,
    { method: 'POST', body: JSON.stringify({ query }) },
  );
}
```

Yeni `apps/web/src/hooks/useExternalSearchQuery.ts`, `useSearchQuery`'nin BİREBİR aynı `useQuery` iskeleti (`queryKey: ['search-external', workspaceId, query]`, `enabled: query.trim().length > 0`) — AYRI bir React Query key, iç aramanın query state'inden bağımsız (biri yavaşsa/hata verirse diğerinin `isLoading`/`data`'sını etkilemez).

`CommandPalette.tsx`, `useSearchQuery` çağrısının yanına `useExternalSearchQuery(workspaceId, debouncedQuery)` ekler. **Mevcut `flatResults`/ok-tuşu-navigasyonu/`selectResult` yalnızca iç `SearchResult[]` (`ObjectType` tipli) için çalışmaya devam eder — hiç dokunulmaz.** Yeni `ExternalSearchResultChip.tsx` (`apps/web/src/views/shared/`), `ExternalEventChip.tsx`'in AYNI deseni: `Card` + nötr `Badge`, salt-okunur, tıklanamaz, `data-testid="external-search-result-chip"`. Mevcut grupların ALTINDA, sabit bir "Dış Kaynaklar" başlığı altında, connectorType'a göre etiketlenmiş (Badge metni: connectorType) render edilir; `data?.degraded` doluysa küçük bir "N kaynak atlandı" notu gösterilir (tıklanamaz, yalnızca bilgilendirme).

**Gerekçe:** dış sonuçları LuminaOS nesnelerine dönüştürme/import etme kapsam dışı (F2-T7'nin İçe Aktarma sihirbazından farklı, ayrı bir kullanıcı eylemi) — tıklanabilir/seçilebilir yapmak bu dönüştürme kararını zorunlu kılardı (bir tıklamanın ne yapacağı tanımsız kalırdı: yeni bir obje mi oluşturur, dış sekmede mi açar — hiçbiri bu görevin kapsamında karara bağlanmadı).

## Mimari Değişmezlerle İlişki

- **"Tek doğruluk kaynağı olay günlüğüdür; bağlam grafiği ve tüm projeksiyonlar türetilir."** Dış arama sonuçları hiçbir yerde kalıcılaştırılmaz/olay-günlüğüne yazılmaz — her `searchExternal` çağrısı canlı, tekrarlanabilir bir MCP `callTool`; `ExternalSearchResult[]` yalnızca HTTP yanıtında var olur, hiçbir tabloya INSERT edilmez. ADR-0012'nin dış takvim verisi için kurduğu "türetilmiş/atılabilir" felsefesiyle BİREBİR tutarlı (Bağlam madde 8) — bu değişmezle ÇELİŞMEZ çünkü bu veri hiç kalıcı durum haline gelmiyor, dolayısıyla "olay günlüğünden türetilmesi gereken bir projeksiyon" kategorisine hiç girmiyor.
- **"Ajan aksiyonları `{niyet, gerekçe, kaynaklar[], geri_alma_planı}` sözleşmesine uyar."** Bu görev bir ajan aksiyonu değil, kullanıcı-tetikli salt-okunur bir sorgu — sözleşim bu görevde uygulanabilir değil (F3-T1'in, "Ajan Runtime'ın Connected Search'ü nasıl kullanacağı" sorusunun, ayrı ve gelecekteki kapsamı).
- **"Veri dışa aktarma hiçbir planda/kodda kısıtlanamaz."** Bu görev veri dışa aktarma değil, dışarıdan İÇERİ okuma — ilgisiz.
- **"Hassas veri sınıfları buluta ham gönderilmez."** Dış arama sorgu metni (`query`) ilgili SaaS sağlayıcısına (Notion/Slack/GitHub/Google) zaten kullanıcının kendi bağladığı, kendi OAuth kapsamı dahilindeki bir kanaldan gidiyor — bu, ADR-0026'nın zaten karara bağladığı bir bağlayıcı-güven sınırı, bu ADR yeniden açmıyor.

## Değerlendirilip reddedilen alternatifler

- **Bağlantı havuzlama/yeniden kullanma (per-workspace, per-connectorType bir `Map<key, McpConnector>`).** Reddedildi (Karar a) — YAGNI: bu görevde ölçülmüş bir performans sorunu yok, havuzlama TTL/invalidation/eşzamanlı-arama karmaşıklığı ekler (bir bağlayıcı örneği hangi kullanıcının token'ıyla "kirlenmiş" kalır sorusu). Performans gerekirse ayrı bir görev.
- **Registry'yi genişletip per-kullanıcı context taşıyan bir `callTool(toolName, args, {workspaceId, userId})` eklemek.** Reddedildi — ADR-0026 §m'nin zaten reddettiği alternatifin aynısı; `McpConnector` arayüzü ADR-0025 §f'de DONDURULMUŞ, bu görev onu yeniden açmıyor. Registry'yi TAMAMEN bypass etmek, arayüzü genişletmekten daha az riskli.
- **Dış sonuçları iç `SearchResult`'a benzer tek bir birleşik tipe zorlayıp `CommandPalette`'in mevcut `GROUP_ORDER`/navigasyon mantığına dahil etmek.** Reddedildi (Karar f) — dış sonuçların "seçilince ne olur" sorusu tanımsız (import/dönüştürme kapsam dışı); mevcut navigasyon mantığını bu belirsizlikle kirletmek yerine ayrı, salt-okunur bir blok.
- **Tek birleşik `POST /search` endpoint'i, sunucu tarafında iç+dış sonuçları `Promise.all` ile birleştirip TEK yanıt döndürmek.** Reddedildi (Karar c) — iç aramanın ~10-50ms'lik anlık hissini en yavaş/sağlıksız dış bağlayıcının 2sn zaman aşımına kilitlerdi.
- **Bağlayıcıya-özel derin sonuç ayrıştırma (regex/heuristik ile başlık/URL çıkarma).** Reddedildi (Karar d) — gerçek sağlayıcı yanıtı hiç gözlemlenemedi; UYDURULMUŞ bir format, insan gerçek kimlik bilgisiyle test ettiğinde sessizce yanlış sonuçlar üretebilirdi.
- **Token yenileme akışını bu görevde kurmak (`CalendarTokenRefreshService`'in MCP genellemesi).** Reddedildi (Karar e) — 5 sağlayıcının refresh davranışı farklı, kendi başına mimari-kritik bir karar; bu ortamda gerçek kimlik bilgisi yok, canlı doğrulanamaz.

## Sonuçlar / Etkiler

**Şimdi ne kazanıyoruz:**

- ADR-0026 §m'nin açıkça F2-T11'e bıraktığı boşluk kapanıyor — registry'yi bypass eden, gerçek per-kullanıcı token'la per-çağrı taze bağlayıcı inşası ilk kez üretim kod yolunda kuruluyor; bu desen bundan sonraki her "gerçek kullanıcı verisiyle MCP çağrısı yapan" özelliğin temel alacağı bir örüntü.
- `ConnectorRateLimitService`/`ConnectorCredentialsService`'in ilk gerçek tüketicisi — ADR-0025'in kurduğu framework artık gerçekten kullanılıyor, boşta durmuyor.
- İç/dış arama gecikme katmanlarının ayrılması (Karar c), CommandPalette'in mevcut anlık-hissini hiç riske atmadan dış kaynak keşfini ekliyor.
- `Promise.allSettled` izolasyonu (Karar e), `ConnectorHealthService`'in kanıtlanmış desenini üçüncü kez, farklı bir bounded context'te (arama) doğruluyor.

**Neyi erteliyoruz/kabul ediyoruz:**

- **(a) Minimal normalizasyon gerçek sağlayıcı formatlarına karşı doğrulanmadı** — `title`/`snippet` kesme sezgisi, bu ortamda hiç gözlemlenemeyen gerçek MCP yanıtlarına karşı bir varsayım; insan gerçek OAuth kimlik bilgisiyle manuel doğruladığında bağlayıcıya-özel derin ayrıştırma (gelecekteki görev) gerekebilir.
- **(b) Token yenileme yok** — süresi geçmiş bağlantılar `degraded[]`'de sessizce işaretlenir, kullanıcı manuel olarak yeniden bağlanana (`IntegrationsPanel`'den) kadar o kaynaktan hiç sonuç gelmez. Gerçek yenileme akışı ayrı, kendi ADR'sini gerektiren bir gelecek görev.
- **(c) Bağlantı havuzlama yok** — her arama = taze TCP/handshake maliyeti (OAuth token enjeksiyonu + SDK `Client.connect()` el sıkışması). Sık tekrarlanan aramalar için bu maliyet birikir; ölçülmüş bir sorun haline gelirse ayrı bir performans görevi.
