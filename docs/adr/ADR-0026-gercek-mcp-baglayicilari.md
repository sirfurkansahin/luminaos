# ADR-0026: Gerçek MCP Bağlayıcıları (Drive/Gmail/Slack/GitHub/Notion) — OAuth2 Akışı, Streamable HTTP Taban Sınıfı, DI-Fabrikası

**Durum:** Kabul edildi
**Tarih:** 2026-08-18
**İlgili görev:** [F2-T10 — İlk Gerçek MCP Bağlayıcıları: Google Drive, Gmail, Slack, GitHub, Notion](../specs/F2-E3/F2-T10-ilk-6-baglayici.md)
**İlgili plan referansı:** `docs/PLAN.md` §"Epik F2-E3: MCP-native Entegrasyon (Kapsam G)" (F2-T10 satırı) ve CLAUDE.md "ADR Ne Zaman Gerekir" maddesinin HER İKİ fıkrası — (a) bu görev LuminaOS'e İLK KEZ gerçek dış OAuth2 kimlik bilgisi ve gerçek ağ üzerinden dış MCP sunucusu bağlantısı getiriyor, "Mimari Değişmezler"in "hassas veri sınıfları buluta ham gönderilmez" ve "her dış girdi zod ile doğrulanır" maddeleriyle doğrudan kesişiyor; (b) bu görevin kuracağı bağlayıcı-başına OAuth akışı sözleşmesi F2-T11'in (Connected Search) doğrudan tükettiği bir temel.

> Bu ADR'nin (a)-(f) maddeleri insan onaylı Plan Mode kararlarını AYNEN kayda geçiriyor (icat etmiyor) — spec'in (`F2-T10-ilk-6-baglayici.md`) Açık Sorular 1-5'ine plan onayında verilen yanıtlar. ADR'nin kendi sorumluluğu (g)-(n): SDK'nın gerçek `StreamableHTTPClientTransport`/`Client` tip yüzeyine karşı doğrulanmış (bkz. Bağlam madde 3) bir taban bağlayıcı sınıfı, zod-doğrulama kancası, OAuth `state`/CSRF tasarımı, redirect_uri/anti-open-redirect tasarımı, `env.ts` okuyucu şekli, ve — en önemlisi — DI-fabrikası/registry'nin çoklu-kullanıcı kimlik-bilgisi gerçeğiyle nasıl uzlaştığı (bu son madde, insan tarafından önceden karara bağlanmamış, bu ADR'nin YENİ tespit ettiği bir tasarım gerilimi, bkz. Karar (m)).

## Bağlam

1. **`McpConnector` arayüzü DONDURULMUŞ (ADR-0025 §f, DOKUNULMAZ):** `connect()`/`disconnect()`/`checkHealth()`/`callTool(toolName, args)`/`readResource(uri)` — hiçbirinde `workspaceId`/`userId` parametresi YOK, hiçbiri MCP SDK tipini dışa sızdırmıyor. `McpConnectorRegistry` (§g) `Map<connectorType, McpConnector>` — bağlayıcı-tipi başına TEK örnek.
2. **`ConnectorCredentialsService`/`ConnectorRateLimitService`/`ConnectorHealthService` olgun, DOKUNULMAZ (F2-T9/ADR-0025 §k/l/m):** kimlik bilgisi `(workspaceId, userId, connectorType)` üçlüsüne göre şifreli saklanıyor/geri alınıyor; oran sınırı `(workspaceId, connectorType)`'a göre; sağlık kontrolü registry'deki HER bağlayıcı için. `IntegrationsModule` bugün `app.module.ts`'e bağlı DEĞİL (bu görev bağlar).
3. **`@modelcontextprotocol/sdk@1.30.0`'ın gerçek tip yüzeyi bu oturumda doğrulandı** (`node_modules/.pnpm/.../dist/esm/client/{index,streamableHttp}.d.ts`, `Read`/`Grep` ile okundu — ADR-0025'in bıraktığı zorunluluk):
   - `StreamableHTTPClientTransport` (`./client/streamableHttp.js`): `constructor(url: URL, opts?: StreamableHTTPClientTransportOptions)`; `opts.requestInit?: RequestInit` (her isteğe eklenecek özel başlıklar/`Authorization` dahil) ve `opts.authProvider?: OAuthClientProvider` İKİ AYRI, birbirini DIŞLAMAYAN kimlik-doğrulama yolu sunuyor. `close()`, `terminateSession()` mevcut.
   - `Client` (`./client/index.js`): `new Client(implementation, options)`, `connect(transport): Promise<void>`, `callTool(params: {name, arguments}, resultSchema?, options?)`, `readResource(params: {uri}, options?)` — ikisi de SDK'nın KENDİ, çok-alanlı, zaten-zengin dönüş tipini verir (`content`/`contents` dizileri, `isError?`).
   - **Karar:** `opts.authProvider` (SDK'nın kendi `OAuthClientProvider` soyutlaması, kendi token-saklama/yenileme varsayımlarıyla) KULLANILMAZ — bu, LuminaOS'in KENDİ `ConnectorCredentialsService`/OAuth-akışıyla ÇAKIŞAN, ikinci bir token-yönetim sorumlusu yaratırdı. Bunun yerine her `connect()` çağrısında TAZE bir `requestInit: { headers: { Authorization: 'Bearer ' + accessToken } }` ile YENİ bir `StreamableHTTPClientTransport` inşa edilir (Karar (g)) — token yenileme/geçerlilik sorumluluğu tamamen `getAccessToken` callback'inin (çağıranın) içinde kalır, SDK'nın kendi auth-akışına hiç girilmez.
4. **`env.ts` hand-rolled okuyucu konvansiyonu** (`readAnthropicApiKey`/`readEncryptionKey`): yokluk asla ölümcül değil (`undefined` → DI'nin Mock'a düşme sinyali); VARLIK ama YANLIŞ ŞEKİL ölümcül. `readEncryptionKey`'in "base64 çöz, uzunluk kontrolü, aksi halde `process.exit(1)`" deseni bu ADR'nin (k) kararının şablonu.
5. **`AuthController`'ın oturum-çerezi (`sid`, `httpOnly`, `sameSite: 'lax'`, `path: '/'`) konvansiyonu** — `sameSite: 'lax'`, üst-seviye (top-level) GET yönlendirmelerinde (tam olarak bu görevin OAuth callback senaryosu) çerezi TARAYICI tarafından gönderir; bu, callback uç noktasının da `SessionAuthGuard` ile korunabilmesini sağlıyor (Karar (i)).
6. **Web araştırması (birincil kaynaklara karşı doğrulanmış, spec'in kendi Mevcut Durum bölümünde detaylı):** Notion (`mcp.notion.com`) self-serve/lisanssız/admin-onaysız, GA — referans/ilk-kanıtlanan bağlayıcı. Slack (`mcp.slack.com/mcp`) GA ama workspace-admin onayı arkasında. GitHub (`api.githubcopilot.com/mcp/`) GA ama Copilot lisansı + sınırlı-rollout gerektiriyor. Gmail/Drive (`gmailmcp.googleapis.com`/`drivemcp.googleapis.com`) Google-resmi ama Developer Preview (GA değil).
7. **Çözülmesi gereken merkezi gerilim (yeni, bu ADR'nin tespiti):** `McpConnectorRegistry` bağlayıcı-tipi başına TEK, paylaşılan bir `McpConnector` örneği tutuyor (Bağlam 1) — ama bu görevin 5 bağlayıcısının HER BİRİNİN kimlik bilgisi `(workspaceId, userId)`'e göre AYRI AYRI (Bağlam 2). Takvim (ADR-0012) bu gerilimle hiç yüzleşmedi çünkü gerçek adaptörü hep ERTELEDİ. Bu görev gerçek kod yazdığı için gerilim artık kaçınılmaz — çözümü Karar (m).

## Karar

### (a) Bağlayıcı derinliği — gerçek kod TAM yazılır, testler sahte-HTTP'ye karşı (insan kararı, aynen kayıt)

5 bağlayıcının hepsi için gerçek OAuth2 authorization-code akışı VE gerçek `StreamableHTTPClientTransport` kodu TAM yazılır — Mock'a ERTELENMEZ (ADR-0012 §d'nin aksine). Otomatik testler bir sahte/test-only Streamable HTTP sunucusuna (veya `msw`) karşı kanıtlanır — bu ortamda gerçek hesap/kimlik bilgisi YOK. İnsan, gerçek CLIENT_ID/SECRET'ı env'e girdiğinde DI-fabrikası (Karar l) otomatik gerçek bağlayıcıya geçer; insan kendi hesabıyla manuel duman testi yapar.

### (b) Kapsam — 5 YENİ bağlayıcı, Takvimler HARİÇ (insan kararı, aynen kayıt)

Google Drive, Gmail, Slack, GitHub, Notion. Takvimler (`CalendarConnector`, ADR-0012) bu görevde DOKUNULMAZ, `McpConnectorRegistry`'ye SARILMAZ — ayrı, gelecekteki bir karar.

### (c) UI — mevcut düz-JSX deseni, yeni router YOK (insan kararı, aynen kayıt)

`apps/web/src/views/shared/IntegrationsPanel.tsx`, `MemoryPassportPanel`'in `App.tsx`'e doğrudan kardeş olarak monte edilme desenini izler. react-router veya benzeri bir yönlendirici bu görevle GETİRİLMEZ.

### (d) PR bölünmesi — PR1 (paylaşılan altyapı + Notion referansı), PR2+ (kalan 4) (insan kararı, aynen kayıt)

PR1: OAuth authorize/callback uç nokta çifti, `oauth-state.service.ts`, env yapılandırması, `IntegrationsModule`→`app.module.ts` bağlanması (ADR-0025 §n'in ertelediği adım), + Notion bağlayıcısı (taban sınıf + somut sınıf + DI-fabrikası + kayıt). PR2(+PR3): kalan 4 bağlayıcı, PR1'in deseninin mekanik tekrarı.

### (e) Referans bağlayıcı — Notion (GitHub DEĞİL) (insan kararı, aynen kayıt)

Notion'ın self-serve/lisanssız/admin-onaysız akışı insanın gerçek kimlik bilgisiyle güvenilir bir şekilde manuel duman testi yapabilmesini garanti ediyor. **Bilinen sınırlamalar (Kabul Kriteri gereği burada kayıtlı):**

- **GitHub:** resmi/GA ama bir GitHub Copilot lisansı (Free/Pro/Business/Enterprise) VE hesabın MCP-erişimi sınırlı-rollout'una dahil olması gerekiyor; salt bir PAT yetmiyor. Kod TAM yazılır, ama insanın canlı duman testi yapabilmesi kendi Copilot/rollout durumuna bağlı.
- **Gmail/Drive:** Google-resmi ama Developer Preview (GA değil) — Google Workspace MCP Developer Preview Programı'na kayıt gerektiriyor (insanın kod-dışı yapması gereken adım). Kod TAM yazılır, aynı kısıt geçerli.
- **Slack/Notion için bu kısıt YOK** — ikisi de GA ve self-serve (Slack workspace-admin onayı gerektiriyor ama lisans/rollout gerektirmiyor).

### (f) OAuth kimlik bilgisi yapılandırması — uygulama-seviyesi env (insan kararı, aynen kayıt)

CLIENT_ID/CLIENT_SECRET her sağlayıcı için `env.ts`'e (ADR-0012'nin `ENCRYPTION_KEY` desenine benzer), workspace-seviyesinde DEĞİL. Tek LuminaOS dağıtımı, tek OAuth uygulaması seti, tüm workspace'ler paylaşır. Sonuç token'lar zaten `(workspaceId, userId, connectorType)`'a göre ayrı saklanıyor (F2-T9) — izolasyon bozulmaz.

### (g) `StreamableHttpMcpConnector` — paylaşılan taban sınıf, `packages/integrations/src/mcp/streamable-http-mcp-connector.ts`

```ts
export interface StreamableHttpMcpConnectorConfig {
  connectorType: string;
  /** The provider's MCP server endpoint, e.g. 'https://mcp.notion.com'. */
  serverUrl: string;
  /** Called at the START of every `connect()` — returns a currently-valid
   * access token. Refresh-if-expired logic (if any) lives INSIDE this
   * callback, supplied by the caller (the DI factory, Karar l) — the base
   * class never inspects token expiry itself, mirroring how `getAccessToken`
   * is the ONE seam between this class and `ConnectorCredentialsService`. */
  getAccessToken: () => Promise<string>;
}

/**
 * Shared base every one of the 5 concrete connectors extends. Builds a
 * fresh `StreamableHTTPClientTransport` + SDK `Client` on each `connect()`
 * (never uses the SDK's own `OAuthClientProvider` — Bağlam madde 3). Concrete
 * subclasses supply ONLY: `connectorType`/`serverUrl` (via `super(config)`)
 * and the two zod-validation hooks below (Karar h).
 */
export abstract class StreamableHttpMcpConnector implements McpConnector {
  readonly connectorType: string;
  private client: Client | undefined; // SDK's own `Client`, never exposed
  private readonly config: StreamableHttpMcpConnectorConfig;

  constructor(config: StreamableHttpMcpConnectorConfig) {
    this.connectorType = config.connectorType;
    this.config = config;
  }

  async connect(): Promise<void> {
    const accessToken = await this.config.getAccessToken();
    const transport = new StreamableHTTPClientTransport(new URL(this.config.serverUrl), {
      requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
    });
    const client = new Client({ name: 'luminaos', version: '1.0.0' });
    await client.connect(transport); // throws on handshake failure (McpConnector contract)
    this.client = client;
  }

  async disconnect(): Promise<void> {
    // Idempotent — SDK's Client has no explicit close(); dropping the
    // reference is sufficient (no `client.close()` observed in the SDK's
    // `Client` surface, Bağlam madde 3 — only the transport has `close()`,
    // which the SDK's own `client.connect()` is responsible for owning).
    this.client = undefined;
  }

  /** Never throws (McpConnector contract) — read-only against existing
   * `this.client` state, NEVER calls `connect()`/`getAccessToken` itself. */
  async checkHealth(): Promise<ConnectorHealth> {
    if (!this.client) {
      return { status: 'error', detail: 'not connected' };
    }
    try {
      await this.client.ping();
      return { status: 'ok' };
    } catch {
      return { status: 'error', detail: 'ping failed' };
    }
  }

  async callTool(toolName: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
    if (!this.client) {
      throw new InvalidObjectStateError(
        `Cannot call tool "${toolName}" on connector "${this.connectorType}" while not connected`,
      );
    }
    const raw = await this.client.callTool({ name: toolName, arguments: args });
    const content = this.parseOrThrow(this.getToolResultSchema(toolName), raw.content, toolName);
    return { content, isError: raw.isError ?? false };
  }

  async readResource(uri: string): Promise<McpResourceReadResult> {
    if (!this.client) {
      throw new InvalidObjectStateError(
        `Cannot read resource "${uri}" on connector "${this.connectorType}" while not connected`,
      );
    }
    const raw = await this.client.readResource({ uri });
    const [first] = raw.contents;
    const content = this.parseOrThrow(this.getResourceContentSchema(uri), first, uri);
    return { uri, mimeType: (first as { mimeType?: string })?.mimeType, content };
  }

  /** `ZodValidationPipe`'ın (`apps/server/src/common/`) AYNI `safeParse` +
   * `ValidationError(message, issues)` deseni — MCP çağrılarının sonuçları
   * için tekrarlanabilir, tek bir kanca (Karar h). */
  protected parseOrThrow<T>(schema: ZodType<T>, raw: unknown, context: string): T {
    const result = schema.safeParse(raw);
    if (!result.success) {
      throw new ValidationError(
        `Connector "${this.connectorType}" returned an unexpected shape for "${context}"`,
        result.error.issues,
      );
    }
    return result.data;
  }

  /** Concrete connectors implement this as a lookup into their OWN static
   * map of `toolName -> ZodType`; throws `NotFoundError` for a `toolName`
   * this connector class does not declare a schema for — this is a WIRING
   * bug (a tool the connector never registered a schema for), not a
   * degraded/expected state, mirroring `MockMcpConnector`'s own
   * unknown-tool `NotFoundError`. */
  protected abstract getToolResultSchema(toolName: string): ZodType<unknown>;

  /** Same contract as above, for `readResource`. */
  protected abstract getResourceContentSchema(uri: string): ZodType<unknown>;
}
```

Bu, spec'in Açık Soru 2'sinin önerdiği `createStreamableHttpMcpConnector(config)` fikrini SOMUTLAŞTIRIYOR — bir fonksiyon değil, bir ABSTRACT SINIF olarak (gerekçe: her bağlayıcının KENDİ zod-şema haritasını sağlaması gerekiyor, bu doğal olarak protected abstract metotlarla ifade edilir; `MockMcpConnector`'ın da zaten bir sınıf olması, bu paketin OO-tabanlı `McpConnector` implementasyon konvansiyonuyla tutarlı).

### (h) Zod-doğrulama kancası — `getToolResultSchema`/`getResourceContentSchema` + `parseOrThrow`

Karar (g)'nin `parseOrThrow` metodu, "her dış girdi şema ile doğrulanır" değişmezinin MCP `callTool`/`readResource` sonuçlarına uygulanma NOKTASIdır — `ZodValidationPipe`'ın konvansiyonuyla BİREBİR aynı (`safeParse` + `ValidationError(message, issues)`). Her somut bağlayıcı (ör. `NotionMcpConnector`) kendi desteklediği tool/resource setini KAPALI bir haritada bildirir:

```ts
// packages/integrations/src/mcp/connectors/notion-mcp-connector.ts
const TOOL_RESULT_SCHEMAS: Record<string, ZodType<unknown>> = {
  'notion-search': z.object({ results: z.array(z.object({ id: z.string(), title: z.string() })) }),
  // ... Notion'ın gerçek MCP sunucusunun tool listesine göre genişler
};

export class NotionMcpConnector extends StreamableHttpMcpConnector {
  protected getToolResultSchema(toolName: string): ZodType<unknown> {
    const schema = TOOL_RESULT_SCHEMAS[toolName];
    if (!schema) throw new NotFoundError(`Unknown tool "${toolName}" for connector "notion"`);
    return schema;
  }
  // getResourceContentSchema aynı desen
}
```

Bu haritanın TAM içeriği (Notion'ın gerçek tool/resource listesi) `test-writer`/`implementer`'a bırakılır — kendi başına yeni bir mimari karar taşımıyor, Karar (g)/(h)'nin doğrudan bir uygulaması.

### (i) OAuth `state`/CSRF tasarımı — DB-backed, tek-kullanımlık, 10 dakika TTL

**Kararlaştırılan: DB-backed (in-memory DEĞİL).** Gerekçe: OAuth authorize→callback döngüsü, kullanıcının dış sağlayıcının onay ekranında saniyeler-dakikalar geçirdiği, TARAYICI-tetikli bir akıştır — bu pencerede bir rolling-deploy/süreç yeniden başlatması gerçekleşirse, in-memory bir `state` haritası kaybolur ve kullanıcının OAuth denemesi sert biçimde başarısız olur (ADR-0025'in oran-sınırı/registry'sinin kabul ettiği "tek-süreç varsayımı" sınırlamasından KASITLI bir SAPMA — oradaki kayıp sessizce daha-cömert bir davranışa/otomatik-iyileşmeye yol açar, buradaki kayıp kullanıcıya görünür bir hata olarak patlar).

`apps/server/src/db/schema/oauth-state-tokens.ts` (yeni, migration + down):

```ts
export const oauthStateTokens = pgTable('oauth_state_tokens', {
  state: varchar('state', { length: 64 }).primaryKey(), // base64url(randomBytes(32)) ~43 karakter
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  connectorType: varchar('connector_type', { length: 50 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});
```

`apps/server/src/integrations/oauth-state.service.ts`:

```ts
@Injectable()
export class OAuthStateService {
  /** `state`, `randomBytes(32).toString('base64url')` (256-bit entropi) —
   * opak, içine workspaceId/userId/connectorType KODLANMAZ (JWT gibi
   * imzalı bir taşıyıcı değil); korelasyon SADECE bu tablodaki satır
   * üzerinden yapılır — `AuthController`'ın `sid` çerezinin AYNI "opak
   * anahtar, sunucu tarafında satırla eşleştir" felsefesi. */
  async issue(workspaceId: string, userId: string, connectorType: string): Promise<string>;

  /** Tek-kullanımlık: eşleşen satırı DELETE...RETURNING ile ATOMİK olarak
   * tüketir (ADR-0025 §l'nin `pg_advisory_lock`'a gerek DUYMAYAN, tek-satır
   * sil-ve-oku deseni — burada eşzamanlı çift-tüketim zaten anlamsız,
   * ikinci deneme boş sonuç bulur). `expiresAt <= now()` veya satır YOKSA
   * `ForbiddenError` fırlatır — "geçersiz" ile "süresi dolmuş" arasında
   * BİLİNÇLİ olarak ayrım YAPILMAZ (bir saldırgana hangi durumun geçerli
   * olduğunu söylememek için, standart CSRF-token doğrulama pratiği). */
  async consume(
    state: string,
  ): Promise<{ workspaceId: string; userId: string; connectorType: string }>;
}
```

TTL: **10 dakika** (bir insanın dış sağlayıcının onay ekranında kimlik doğrulaması için makul üst sınır; replay riskini sınırlı tutmak için yeterince kısa). Süresi dolmuş satırların proaktif temizliği YOK (bilinçli, küçük bir kabul edilen operasyonel borç — satırlar küçük, hacim gerçek OAuth deneme sayısıyla sınırlı; `consume`'un `expiresAt` kontrolü fonksiyonel doğruluğu zaten garanti ediyor).

### (j) Redirect URI / anti-open-redirect tasarımı

**Giden yön (LuminaOS → sağlayıcı):** Her bağlayıcı-tipi için sağlayıcının authorize URL'i (host + path) ve LuminaOS'in kendi callback `redirect_uri`'si TAMAMEN SUNUCU-TARAFLI SABİTLERDİR (`apps/server/src/integrations/mcp-oauth-provider-configs.ts`, bkz. Karar (n)) — HİÇBİRİ istek girdisinden (query param, body) türetilmez. Bu, redirect_uri manipülasyonu/açık-yönlendirme sınıfı saldırıları koddan yapısal olarak imkansız kılar.

**⚠️ Spec'in sözdizimsel sapması — insan onayı gerektirir:** Spec'in Kapsam §2'si callback uç noktasını `/workspaces/:workspaceId/integrations/:connectorType/oauth/callback` olarak yazıyor. Bu, sağlayıcıya gönderilen GERÇEK `redirect_uri` DEĞERİ olarak KULLANILAMAZ: Google/Slack/GitHub/Notion'ın hepsi OAuth uygulaması konsolunda ÖNCEDEN KAYITLI, TAM EŞLEŞEN bir `redirect_uri` talep eder — `:workspaceId` gibi dinamik bir segment, her workspace için ayrı bir önceden-kayıtlı URI gerektirir ki bu, çok-kiracılı (multi-tenant), dinamik-workspace-oluşturma modeliyle UYUMSUZDUR. **Bu ADR'nin çözümü:** yalnızca CALLBACK'in sağlayıcıya-kayıtlı, fiziksel yolu workspace-bağımsız hale getirilir — `${env.serverPublicUrl}/integrations/:connectorType/oauth/callback` (bağlayıcı-tipine göre değişir, workspace'e göre DEĞİL) — `workspaceId`/`userId` korelasyonu TAMAMEN `state` satırı (Karar i) üzerinden sağlanır. AUTHORIZE uç noktası spec'in yazdığı TAM şekli korur (`/workspaces/:workspaceId/integrations/:connectorType/oauth/authorize`, `SessionAuthGuard`+`WorkspaceMembershipGuard`). Bu, spec'in ONAYLANMIŞ ÖZELLİK kapsamından bir SAPMA DEĞİL — spec'in taslak URL yazımının, gerçek sağlayıcıların tescilli-redirect_uri kısıtıyla teknik uzlaşımı; ama spec metninden harfiyen bir farklılık olduğu için **açıkça insana bildirilmeli, implementer'a geçmeden önce onaylanmalı** (bkz. bu ADR'nin sonundaki özet).

**Dönüş yönü (sağlayıcı → LuminaOS → tarayıcı):** callback başarılı token-değişiminden SONRA tarayıcıyı SABİT, `env.webOrigin`'den türetilen bir URL'e (`${env.webOrigin}/`) 302 ile yönlendirir — hiçbir istemci-sağlanan `?returnTo=`/benzeri parametre HİÇBİR ZAMAN yönlendirme hedefi olarak kullanılmaz.

### (k) `env.ts` okuyucu şekli — 5 CLIENT_ID/SECRET çifti + `SERVER_PUBLIC_URL`

`readAnthropicApiKey`'in AYNI "yokluk asla ölümcül değil, EKSİK-ÇİFT (biri var biri yok) ölümcül" deseni, tek bir paylaşılan yardımcıyla 5 kez uygulanır:

```ts
export interface OAuthAppCredentials {
  clientId: string;
  clientSecret: string;
}

/** `${PREFIX}_CLIENT_ID`/`${PREFIX}_CLIENT_SECRET`: HER İKİSİ de yoksa/boşsa
 * -> `undefined` (DI-fabrikasının Mock'a düşme sinyali, Karar l). Yalnızca
 * BİRİ varsa -> ÖLÜMCÜL (bozuk/yarım yapılandırma bir kullanıcı hatasıdır,
 * sessizce görmezden gelinemez) — `readEncryptionKey`'in "var ama
 * yanlış-şekilli -> ölümcül" ilkesinin bu ikili-eksiksizlik biçimine
 * uyarlanmışı. Değerlerin KENDİSİ (`readAnthropicApiKey` gibi) şekil
 * doğrulamasına TABİ DEĞİL — sağlayıcının kendi OAuth uç noktası çağrı
 * zamanında geçersiz bir client_id/secret'ı zaten reddeder. */
function readOAuthAppCredentials(prefix: string): OAuthAppCredentials | undefined {
  const clientId = process.env[`${prefix}_CLIENT_ID`];
  const clientSecret = process.env[`${prefix}_CLIENT_SECRET`];
  const hasId = clientId !== undefined && clientId.trim() !== '';
  const hasSecret = clientSecret !== undefined && clientSecret.trim() !== '';

  if (!hasId && !hasSecret) return undefined;
  if (hasId !== hasSecret) {
    process.stderr.write(
      `FATAL: ${prefix}_CLIENT_ID/${prefix}_CLIENT_SECRET must both be set or both unset.\n`,
    );
    process.exit(1);
  }
  return { clientId: clientId as string, clientSecret: clientSecret as string };
}
```

`Env` arayüzüne eklenir: `googleDriveOAuth?`, `gmailOAuth?`, `slackOAuth?`, `githubOAuth?`, `notionOAuth?` (her biri `readOAuthAppCredentials('GOOGLE_DRIVE')` vb. ile okunur — connectorType'a göre AYRI env çiftleri, Google'ın Drive+Gmail için TEK bir GCP OAuth istemcisi paylaşması OPERASYONEL bir tercih olarak kalır, kod-seviyesinde ZORUNLU KILINMAZ, her `connectorType` DI-fabrikasıyla 1:1 eşleşir).

**Yeni: `SERVER_PUBLIC_URL`** — sunucunun kendi genel adresi (callback `redirect_uri` inşası için gerekli; mevcut `webOrigin`/`desktopOrigin` İSTEMCİ CORS kökenleridir, sunucunun kendi adresi değil). `readWebOrigin`'in AYNI "yokluk yanlış-yapılandırma değildir" tarzı: yoksa/boşsa `http://localhost:3000` (`main.ts`'in `app.listen(3000)` varsayılanıyla hizalı).

### (l) `apps/server/src/integrations/oauth2-authorization-code-flow.ts` — paylaşılan, sağlayıcı-agnostik OAuth2 yardımcı

Kod-değişimi ve authorize-URL inşası 5 bağlayıcı arasında protokol-seviyesinde AYNIDIR (RFC 6749 authorization-code grant) — `packages/integrations/src/mcp/`'e DEĞİL (MCP protokolüyle ilgisiz, salt OAuth2), `apps/server/src/integrations/`'a ait çünkü `fetch`/env'e bağımlı bir sunucu-katmanı yardımcısıdır:

```ts
export interface OAuth2ProviderConfig {
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export function buildAuthorizationUrl(config: OAuth2ProviderConfig, state: string): string;

/** Sağlayıcının token uç noktasına `application/x-www-form-urlencoded`
 * POST, JSON yanıtı zod ile doğrulanır (`z.object({access_token: z.string(),
 * refresh_token: z.string().optional(), expires_in: z.number().optional()})`)
 * — "her dış girdi zod ile doğrulanır" değişmezinin OAuth token yanıtına
 * (MCP tool-call sonuçlarına ek olarak) uygulanma noktası. Geçersiz şekilde
 * `ValidationError` fırlatır (`ZodValidationPipe`'ın AYNI deseni). */
export async function exchangeAuthorizationCode(
  config: OAuth2ProviderConfig,
  code: string,
): Promise<{ accessToken: string; refreshToken?: string; expiresAt?: string }>;
```

`apps/server/src/integrations/mcp-oauth-provider-configs.ts`: 5 bağlayıcı-tipinin `authorizeUrl`/`tokenUrl`/`scopes`'unu (ADR-0012 §h'nin "ertelenmiş adaptörler için scope'ları şimdiden sabitle" disipliniyle) `env`'den okunan `clientId`/`clientSecret` ile birleştiren, `Record<string, (config: Env) => OAuth2ProviderConfig | undefined>` şeklinde küçük bir eşleme.

### (m) DI-fabrikası deseni + `McpConnectorRegistry` semantiğinin çoklu-kullanıcı gerçeğiyle uzlaşması (YENİ tespit — insan tarafından önceden karara bağlanmamış)

Bağlam madde 7'nin gerilimi: `McpConnectorRegistry` bağlayıcı-tipi başına TEK örnek tutuyor, ama her kullanıcının kendi token'ı var. **Bu ADR'nin çözümü, F2-T10'un GERÇEK kapsamıyla sınırlı kalarak:**

- Registry'ye kayıt, "bu connectorType UYGULAMA-SEVİYESİNDE yapılandırılmış" anlamına gelir — "şu an canlı, paylaşılan bir oturum var" anlamına GELMEZ. Registry'deki örneğin `connect()`'i bu görevin HİÇBİR üretim kod yolunda ÇAĞRILMAZ (yalnızca test kodu, doğrudan somut sınıfı sahte bir sunucuya karşı örnekleyerek, DI/registry'yi BYPASS eder).
- `apps/server/src/integrations/mcp-connectors.module.ts` (yeni), `CalendarConnectorModule`'ün AYNI `useFactory` desenini, bağlayıcı-başına AYRI bir DI token ile (`NOTION_MCP_CONNECTOR` vb.) izler:

```ts
{
  provide: NOTION_MCP_CONNECTOR,
  inject: [MCP_CONNECTOR_REGISTRY],
  useFactory: (registry: McpConnectorRegistry): McpConnector | undefined => {
    if (!env.notionOAuth) return undefined; // Kabul Kriteri: Mock'a düş = registry'ye KAYIT ETME
    const connector = new NotionMcpConnector({
      connectorType: 'notion',
      serverUrl: 'https://mcp.notion.com',
      // Bilinçli, YÜKSEK SESLE sınırlama — F2-T11'in çözmesi gereken açık
      // soru: registry'deki TEK paylaşılan örnek hiçbir belirli kullanıcıya
      // ait değil, dolayısıyla bu callback'in gerçekten ÇAĞRILMASI bir
      // kablolama hatasıdır (`.connect()` bu görevde HİÇBİR ÜRETİM kod
      // yolundan çağrılmıyor, Karar m). Sessizce yanlış/boş bir token
      // döndürmek yerine YÜKSEK SESLE fırlatıyoruz.
      getAccessToken: () => {
        throw new InvalidObjectStateError(
          'notion connector'ının paylaşılan registry örneği kullanıcı-bazlı oturum kurmayı desteklemiyor (F2-T11 kapsamı)',
        );
      },
    });
    registry.register(connector);
    return connector;
  },
}
```

- `ConnectorHealthService.checkAll()` bu 5 bağlayıcı için hep `{status:'error', detail:'not connected'}` raporlar (Karar g'nin `checkHealth`'i `this.client` yokken `getAccessToken`'a hiç dokunmadan bunu döndürüyor) — bu KABUL EDİLEN bir durumdur, `McpConnector` arayüzünün "sağlıksız olmak beklenen, istisnai-olmayan bir sonuç" ilkesiyle (ADR-0025 §f) tam tutarlı.
- OAuth callback'i başarılı token-değişiminden sonra CANLI bir `.connect()` doğrulaması YAPMAZ ("bağlan" düğmesinin başarı sinyali = "token saklandı", "bağlantı canlı doğrulandı" DEĞİL) — Kabul Kriterleri bunu talep ETMİYOR ve Karar (a)'nın "insan kendi hesabıyla manuel duman testi yapar" mirasıyla tutarlı.
- **F2-T11'in (Connected Search) gerçek per-kullanıcı `callTool` akışı için registry'yi KULLANMAMASI, bunun yerine `ConnectorCredentialsService.retrieve(workspaceId, userId, connectorType)`'den okunan token'la HER ÇAĞRIDA TAZE bir somut bağlayıcı örneği (`new NotionMcpConnector({..., getAccessToken: async () => token})`) inşa etmesi GEREKİR — bu ADR bunu İNŞA ETMİYOR, sadece gerekliliğini kayda geçiriyor.** Bu, F2-T11'in kendi ADR'sinin kapatması gereken açık bir mimari sorudur (bkz. bu ADR'nin sonu).

### (n) `IntegrationsModule` → `app.module.ts` bağlanması

ADR-0025 §n'in ertelediği adım bu görevde tamamlanır: `IntegrationsModule` (`ConnectorCredentialsService`+`ConnectorRateLimitService`) ve yeni `McpConnectorsModule` (Karar m), `AppModule`'ün `imports` dizisine eklenir. Yeni `McpOAuthController` (`apps/server/src/integrations/mcp-oauth.controller.ts`) hem `IntegrationsModule` hem `McpConnectorsModule`'ü (registry'ye erişim için) enjekte eder.

## Değerlendirilip reddedilen alternatifler

- **SDK'nın `OAuthClientProvider`/`authProvider` seçeneğini kullanmak (Karar g).** Reddedildi — kendi token-saklama/yenileme varsayımlarını taşıyor, `ConnectorCredentialsService`'le ÇAKIŞAN ikinci bir kimlik-bilgisi otoritesi yaratırdı. Her `connect()`'te taze `requestInit`'le token enjekte etmek daha basit, tek-otorite.
- **`state`'i in-memory (Map, `AIRefreshScheduler` deseni) saklamak (Karar i).** Reddedildi — OAuth akışı, kullanıcının dış sağlayıcının ekranında dakikalarca kalabileceği, TARAYICI-tetikli bir akış; bu pencerede bir süreç yeniden başlarsa kullanıcının denemesi GÖRÜNÜR biçimde başarısız olur (rate-limit/registry'nin kabul ettiği sessiz-derecede-daha-cömert sınırlamadan daha kötü bir başarısızlık modu).
- **Callback URL'inde `:workspaceId`'yi harfiyen tutmak (spec'in yazdığı gibi).** Reddedildi (Karar j) — sağlayıcıların tescilli, tam-eşleşen `redirect_uri` kısıtıyla teknik olarak uyumsuz (dinamik workspace sayısı kadar önceden-kayıtlı URI gerektirirdi). Workspace korelasyonu `state` satırına taşındı; İNSAN ONAYI gerektiren bir sapma olarak işaretlendi.
- **`state`'in içine `workspaceId`/`userId`/`connectorType`'ı imzalı bir JWT olarak KODLAMAK (opak DB satırı yerine).** Reddedildi — yeni bir imzalama/anahtar-yönetimi yüzeyi açardı (`ENCRYPTION_KEY`'den AYRI); DB satırı zaten tek-kullanımlık tüketimi doğal olarak sağlıyor (JWT'nin kendisi tek-kullanımlık değildir, ayrı bir "kullanıldı" defteri gerektirirdi — bu da sonunda bir DB satırına geri döner).
- **Registry'nin `McpConnector` arayüzünü/`register` semantiğini bu görevde DEĞİŞTİRMEK** (ör. `callTool(toolName, args, {workspaceId, userId})` gibi per-çağrı context eklemek). Reddedildi — ADR-0025'in dondurduğu arayüz bu görevde DOKUNULMAZ (görev talimatı); ayrıca bu değişiklik `MockMcpConnector`'ı da etkiler, F2-T9'un tamamlanmış/gözden-geçirilmiş yüzeyini yeniden açardı. Çoklu-kullanıcı gerçeği, arayüzü genişletmek YERİNE registry'nin KULLANIM biçimini (Karar m) daraltarak çözüldü.
- **OAuth callback'inde başarılı token-değişiminden sonra canlı bir `.connect()` doğrulaması yapmak ("bağlan" = "test edildi").** Reddedildi — bunun için per-kullanıcı bağlayıcı inşası gerekirdi (Karar m'nin F2-T11'e bıraktığı mekanizma); Kabul Kriterleri bunu talep etmiyor, kapsam disiplinini (spec'in "hazır olmuşken ekleme" ilkesi) korumak için ertelendi.

## Sonuçlar / Ödünler

**Şimdi ne kazanıyoruz:**

- ADR-0025'in dondurduğu `McpConnector` sözleşmesi, SDK'nın GERÇEK, doğrulanmış tip yüzeyine (Bağlam madde 3) karşı, hiçbir hayali API varsayılmadan, ilk kez somut bir gerçek-transport implementasyonuyla dolduruluyor.
- OAuth `state`/CSRF, redirect_uri sabitleme, ve tek-otorite token-enjeksiyonu (SDK'nın kendi auth akışını atlayarak) bu kod tabanına ilk gerçek OAuth2 authorization-code akışını, `ConnectorCredentialsService`'in olgun şifreleme/saklama emsalini YENİDEN İCAT ETMEDEN getiriyor.
- Zod-doğrulama kancası (`parseOrThrow` + `getToolResultSchema`/`getResourceContentSchema`), "her dış girdi şema ile doğrulanır" değişmezini MCP `callTool`/`readResource` sonuçlarına VE OAuth token-değişimi yanıtına aynı disiplinle uyguluyor.
- Notion'ın referans-bağlayıcı olması, PR1'in insan tarafından GERÇEKTEN, kod-dışı hiçbir bekleyen adım olmadan manuel duman-test edilebilmesini garanti ediyor.

**Neyi erteliyoruz / kabul ediyoruz:**

- **GitHub'ın Copilot-lisansı + sınırlı-rollout kısıtı ve Gmail/Drive'ın Developer Preview statüsü** — kod TAM yazılır, ama insanın bu 3 bağlayıcı için canlı duman testi yapabilmesi kendi hesap/program durumuna bağlı (Kabul Kriteri, Karar e).
- **Çoklu-kullanıcı, per-çağrı bağlayıcı inşası (Karar m) BU GÖREVDE İNŞA EDİLMİYOR** — registry'deki paylaşılan örnekler yalnızca "uygulama-seviyesinde yapılandırılmış" sinyalini taşıyor, gerçek `callTool`/`readResource` hiçbir üretim kod yolunda çağrılmıyor. **Bu, F2-T11'in (Connected Search) kendi ADR'sinde AÇIKÇA çözmesi gereken bir mimari sorudur** — muhtemel yön: `ConnectorCredentialsService.retrieve()`'den okunan token'la per-çağrı taze bağlayıcı örneği inşası, registry'yi bypass ederek.
- **Spec'in callback URL'inin harfiyen `:workspaceId` içermesi TERK EDİLDİ** (Karar j) — sağlayıcıların tescilli-redirect_uri kısıtıyla teknik uyumsuzluk nedeniyle; bu, spec'in ONAYLANMIŞ metninden bir sapma olduğu için implementer'a geçmeden önce AÇIKÇA insana bildirilmeli.
- **`oauth_state_tokens`'ın süresi dolmuş satırlarının proaktif temizliği YOK** — küçük, kabul edilen operasyonel borç; fonksiyonel doğruluk `consume`'un `expiresAt` kontrolüyle zaten garanti.
- **OAuth callback'inde canlı bağlantı doğrulaması YOK** — "bağlan" başarı sinyali yalnızca "token saklandı"; ADR-0012 §d'nin "Mock-öncelikli, insan sonradan doğrular" mirasının devamı.
