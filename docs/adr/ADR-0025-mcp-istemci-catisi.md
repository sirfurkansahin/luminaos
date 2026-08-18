# ADR-0025: MCP İstemci Çatısı — Bağlayıcı Yaşam Döngüsü, Kimlik-Bilgisi Saklama, Oran Sınırı, Sağlık Kontrolü

**Durum:** Kabul edildi
**Tarih:** 2026-08-18
**İlgili görev:** [F2-T9 — MCP İstemci Çatısı + Bağlayıcı Yaşam Döngüsü (Kimlik, Oran Sınırı, Sağlık)](../specs/F2-E3/F2-T9-mcp-istemci-catisi.md)
**İlgili plan referansı:** `docs/PLAN.md` §"Epik F2-E3: MCP-native Entegrasyon (Kapsam G)" (F2-T9 satırı, Faz 2) ve CLAUDE.md "ADR Ne Zaman Gerekir" maddesinin HER İKİ fıkrası — (a) "Mimari Değişmezler" listesi MCP'yi açıkça adıyla anıyor ("her dış girdi — MCP, webhook, form — şema ile doğrulanır, zod"), bu görev bu değişmezin MCP tarafını ilk kez somut bir mekanizmaya döken görev; (b) bu görevin kuracağı bağlayıcı yaşam döngüsü sözleşmesi F2-T10 (ilk 6 bağlayıcı), F2-T11 (Connected Search) ve F2-T12 (MCP sunucusu) için dayatılan bir temel.

> Bu karar setinin beş maddesi ((a) paket konumu, (b) `CalendarConnector` ile birleştirmeme, (c) resmi `@modelcontextprotocol/sdk`, (d) ayrı `connector_credentials` tablosu, (e) senkron kilit-korumalı oran sınırı) tamamen insan onaylı geldi — spec'in (`F2-T9-mcp-istemci-catisi.md`) "Açık Sorular" bölümündeki 1-5 numaralı sorulara plan onayında verilen yanıtlardır; bu ADR onları icat etmiyor, aynen kayıt altına alıyor (aşağıda (a)-(e)). Bu ADR'nin kendi sorumluluğu, geri kalan teknik-tasarım sorularını (f)-(l) kod-seviyesinde kapatmak: `McpConnector` arayüzünün tam şekli, registry deseni, saf oran-sınırı algoritması ve durum şekli, mock bağlayıcı, `connector_credentials` şemasının tam kolon/kısıt listesi, ve üç `apps/server` servisinin tam metot imzaları.
>
> **MCP SDK üzerine kritik bir sınır:** Bu ADR resmi `@modelcontextprotocol/sdk` paketinin iç sınıf/metot adlarını TAHMİN ETMİYOR/İCAT ETMİYOR — web erişimi olmadan bu SDK'nın gerçek TypeScript tip yüzeyini doğru yazmak mümkün değil, ve yanlış bir sözleşmeyi bir ADR'ye kilitlemek `implementer`'ı yanlış yönlendirme riski taşırdı. Bunun yerine bu ADR yalnızca LuminaOS'in KENDİ soyutlama seviyesindeki `McpConnector` arayüzünü sabitliyor (`register`/`connect`/`disconnect`/`checkHealth`/`callTool`/`readResource` — MCP protokolünün kendisinin, SDK'nın API yüzeyinden bağımsız, iki kararlı çekirdek ilkesi: tools ve resources). `implementer`, PR1'e başlamadan önce ÖNCE `pnpm add @modelcontextprotocol/sdk`, SONRA `node_modules/@modelcontextprotocol/sdk/dist/**/*.d.ts` içindeki gerçek `.d.ts` dosyalarını `Read`/`Grep` ile okuyup SDK'nın gerçek sınıf/metot adlarını (client oluşturma, transport bağlama, tool çağırma, resource okuma) doğrulamak ve bunları `McpConnector` arayüzünü UYGULAYAN somut sınıfın İÇİNDE (arayüzün kendisinde değil) sarmalamak ZORUNDADIR.

## Bağlam

Keşif üç mevcut emsali doğruladı, ve bunların hiçbirinin doğrudan MCP protokolüyle ilgili olmadığını netleştirdi:

1. **`packages/integrations/src/calendar-connector.ts`** (tek mevcut içerik, ADR-0012 §d) — `CalendarConnector` arayüzü, `packages/ai-gateway`'in `AIProvider.complete()` desenine benzer şekilde modellenmiş, TAKVİM-domain'ine özel (`listEvents`/`createEvent`/`updateEvent`/`deleteEvent`/`refreshToken`), MCP protokolüyle YAPISAL OLARAK FARKLI (JSON-RPC tabanlı genel tool/resource çağrıları değil, domain-özel CRUD). `MockCalendarConnector`, çağrıları kaydeden (`createdEvents`/`updatedEvents`/`deletedEventIds`) ince bir test double'ı — hata durumunda throw eder (result-tipi dönmez), bu repo'nun servis-katmanı hata konvansiyonuyla (`packages/shared/errors`) tutarlı.
2. **`apps/server/src/calendar/`'ın kimlik-bilgisi saklama emsali** (ADR-0012 §c) — `CalendarTokenEncryptionService` (`encrypt`/`decrypt`, `env.encryptionKey` eksikse `InvalidObjectStateError` ile lazy-fatal), `CalendarAccountsService` (`connect`/`list`/`disconnect`, public metotlardan ASLA token dönmez), `calendar_accounts` Drizzle şeması (uuid PK, `workspaceId`/`userId` FK `onDelete: cascade`, şifreli metin sütunları). `env.encryptionKey` (`ENCRYPTION_KEY`) ZATEN genel bir AES-256-GCM ana anahtar olarak modellenmiş — takvime özgü bir isim taşımıyor, dolayısıyla bu görev için YENİDEN KULLANILABİLİR (bkz. Karar (h)).
3. **`AIUsageService`'in kilit-korumalı kontrol-sonra-kaydet deseni** (ADR-0014 §a) — `withWorkspaceAILock` (`pg_advisory_lock(hashtext(...))`, ayrı pool bağlantısı, `finally` ile unlock), `assertAITokenQuotaNotExceeded`/`assertAICostBudgetNotExceeded` (`SUM(...)` + `COALESCE`, eşik aşılınca `QuotaExceededError`), `recordAIUsage` (best-effort, asla throw etmez). Bu üçü birlikte TOCTOU-güvenli bir "kontrol et → işlemi yap → kaydet" iskeleti kuruyor; oran sınırı için doğrudan genellenecek desen bu.
4. **`HealthService`'in `withTimeout`/`Promise.allSettled` deseni** — framework-bağımsız, yapısal (duck-typed) probe arayüzleri, her probe 2000ms varsayılan zaman aşımına karşı yarıştırılıyor, bir probe'un başarısızlığı/zaman-aşımı diğerini engellemiyor, `{status:'ok'|'degraded', checks, version}` döner.

Çözülmesi gereken merkezi soru (insan onayıyla kapatılan (a)-(e) hariç): `McpConnector`'ın tam arayüz şekli SDK'nın gerçek tip yüzeyini şimdiden yanlış varsaymadan nasıl sabitlenir; registry/oran-sınırı/sağlık-kontrolü/kimlik-bilgisi katmanları hangi tam metot imzalarıyla, hangi paket/dosya sınırlarıyla kurulur.

## Karar

### (a) Paket konumu — `packages/integrations/src/mcp/` (insan kararı, aynen kayıt)

Yeni bir paket AÇILMAZ. MCP protokol istemci kodu, mevcut `packages/integrations`'ın altında yeni bir `src/mcp/` alt-dizininde yaşar, `calendar-connector.ts`'in yanında. Gerekçe: ikisi aynı bounded context'i ("dış kaynak bağlantıları") paylaşıyor; `packages/ai-gateway`'in tek-paket-çok-sağlayıcı desenine benzer.

### (b) `CalendarConnector` ile birleştirme YOK (insan kararı, aynen kayıt)

`CalendarConnector`'ın domain-özel arayüzü (`listEvents`/`createEvent` vb., ADR-0012'nin read-through-cache tasarımının parçası) ve yeni `McpConnector` sözleşmesi arasında ortak bir temel arayüz KURULMAZ. `CalendarConnector` MCP-tabanlı değil (bugün); `McpConnector` protokol-seviyesinde genel tool/resource çağrıları. İkisini ortak bir soyutlamaya zorlamak bugün erken/yanlış bir soyutlama olurdu. `calendar-connector.ts` bu görevde HİÇ değiştirilmez.

### (c) Protokol katmanı — resmi `@modelcontextprotocol/sdk` (insan kararı, aynen kayıt)

JSON-RPC/transport elle YAZILMAZ. `@modelcontextprotocol/sdk`, `packages/integrations/package.json`'a yeni bir runtime bağımlılığı olarak eklenir. Gerekçe: protokolün referans implementasyonu zaten var ve bakımı yapılıyor; elle yeniden yazmak riskli/gereksiz (ADR-0016 §d'nin "kanıtlanmamış bir şemayı elle reverse-engineer etmek yerine mevcut/kanıtlanmış bir yolu tercih et" mantığıyla aynı risk-azaltma). SDK'nın gerçek iç API'sini bu ADR'nin NASIL sabitlemediği için yukarıdaki "MCP SDK üzerine kritik bir sınır" blok alıntısına bakınız.

### (d) Kimlik-bilgisi saklama — yeni, ayrı `connector_credentials` tablosu (insan kararı, aynen kayıt)

`calendar_accounts`'a DOKUNULMAZ, genişletilmez, paylaşılmaz. Yeni `apps/server/src/db/schema/connector-credentials.ts` (tam şema Karar (i)). Gerekçe: iki farklı bağlantı-türünü (biri read-through-cache senkron, diğeri MCP protokol tabanlı) aynı tabloya zorlamak kavramsal yanlış birleştirme olurdu.

### (e) Oran sınırı — senkron kontrol-sonra-kaydet, kilit korumalı (insan kararı, aynen kayıt)

Arka planda kuyruk/zamanlayıcı YOK. `AIUsageService`'in TOCTOU-güvenli, workspace-başına `pg_advisory_lock` deseni doğrudan genellenir (Karar (k)'de bağlayıcı-başına uyarlanmış hali).

### (f) `McpConnector` arayüzü — LuminaOS'in kendi soyutlama seviyesi, throw-tabanlı hata konvansiyonu

`packages/integrations/src/mcp/mcp-connector.ts` (yeni dosya):

```ts
export type ConnectorHealthStatus = 'ok' | 'error';

export interface ConnectorHealth {
  status: ConnectorHealthStatus;
  /** Only present when status is 'error' — a short, loggable (never
   * credential-bearing) diagnostic string, mirrors `HealthService`'s
   * `checks` shape's spirit but per-connector, not global. */
  detail?: string;
}

export interface McpToolCallResult {
  /** Raw MCP tool-call result payload, already zod-validated by the
   * concrete connector implementation against ITS OWN declared result
   * shape before being returned here — callers never receive
   * unvalidated external input (Mimari Değişmez: "her dış girdi şema ile
   * doğrulanır"). */
  content: unknown;
  isError: boolean;
}

export interface McpResourceReadResult {
  uri: string;
  mimeType?: string;
  /** Already zod-validated by the concrete connector before being
   * returned, same discipline as `McpToolCallResult.content`. */
  content: unknown;
}

/**
 * LuminaOS's own connector lifecycle contract — deliberately NOT a
 * wrapper re-exporting `@modelcontextprotocol/sdk`'s own types. Concrete
 * implementations (real transports, `MockMcpConnector`) hide the SDK's
 * actual client/transport classes entirely behind this interface, so
 * every OTHER package in this codebase (F2-T10's real connectors,
 * F2-T11's Connected Search, F2-T12's MCP server) depends only on this
 * stable surface, never on the SDK's own API directly (ADR-0025 SDK
 * boundary note).
 *
 * Error convention: every method THROWS on failure (never returns a
 * result/error union) — mirrors `CalendarConnector`'s existing
 * convention (`refreshToken` throws, doesn't return
 * `{ok:false,error}`), and this codebase's general "errors thrown via
 * packages/shared/errors classes" rule (CLAUDE.md "Kodlama
 * Sözleşmeleri"). `checkHealth` is the ONE deliberate exception below —
 * it never throws, mirroring `HealthService`'s own probe functions,
 * because a connector being unhealthy is an expected, non-exceptional
 * outcome for a health check, not a failure of the check itself.
 */
export interface McpConnector {
  readonly connectorType: string;

  /** Idempotent — establishes (or re-establishes) the underlying MCP
   * session/transport. Throws if the underlying transport/handshake
   * fails. */
  connect(): Promise<void>;

  /** Idempotent — tears down the underlying session/transport. Safe to
   * call on an already-disconnected connector (no-op). */
  disconnect(): Promise<void>;

  /** Never throws — always resolves to a `ConnectorHealth`, even when
   * the underlying probe fails or times out (the concrete
   * implementation is responsible for its own internal
   * try/catch-and-degrade, mirroring `probeDatabase`/`probeRedis`'s
   * internal catch). Callers (e.g. `ConnectorHealthService`, Karar (m))
   * still apply their OWN `withTimeout` wrapper as defense-in-depth,
   * same "belt and suspenders" reasoning `HealthService.check` already
   * uses via `Promise.allSettled`. */
  checkHealth(): Promise<ConnectorHealth>;

  /** Throws if not connected, if `toolName` is unknown to the
   * underlying MCP server, or if the underlying call fails. `args` is
   * validated against a zod schema INSIDE the concrete implementation
   * before being sent (Mimari Değişmez). */
  callTool(toolName: string, args: Record<string, unknown>): Promise<McpToolCallResult>;

  /** Throws if not connected or if `uri` is unknown/unreadable. */
  readResource(uri: string): Promise<McpResourceReadResult>;
}
```

`register` LuminaOS-seviyesinde `McpConnector`'ın kendi metodu DEĞİL — registry'nin (Karar (g)) sorumluluğu, çünkü "kayıt" bir bağlayıcı örneğinin kendi davranışı değil, birden çok bağlayıcı arasında hangisinin hangi `connectorType` altında bulunabileceğine dair bir KATALOG işlemi.

### (g) Registry — `Map`-tabanlı, `mcp-connector-registry.ts`

`packages/integrations/src/mcp/mcp-connector-registry.ts` (yeni dosya):

```ts
export class McpConnectorRegistry {
  private readonly connectors = new Map<string, McpConnector>();

  /** Throws `ConflictError` if `connector.connectorType` is already
   * registered — a registry is a catalog, not an upsert; re-registering
   * the same type is almost always a wiring bug (e.g. two DI factories
   * both registering 'google-drive'), not an intended override. */
  register(connector: McpConnector): void;

  /** Returns `undefined` if not found — NOT throwing, because "is this
   * connector type known" is a legitimate question callers (e.g.
   * F2-T11's Connected Search) need to ask without a try/catch, mirrors
   * `Map.get`'s own convention directly. */
  get(connectorType: string): McpConnector | undefined;

  list(): McpConnector[];
}
```

`register`'ın `ConflictError` fırlatması, `CalendarAccountsService.connect`'in başarısız-insert'te `ConflictError` fırlatma konvansiyonuyla tutarlı (`packages/shared/errors`).

### (h) Saf oran-sınırı matematiği — token-bucket, `rate-limit-math.ts`

`packages/integrations/src/mcp/rate-limit-math.ts` (yeni dosya) — framework-free, DB/kilit YOK (`packages/memory`'nin saf-fonksiyon konvansiyonuyla aynı disiplin, ör. `is-agent-allowed-to-access-memory.ts`'in "yorumlama mantığı saf, veri-okuma çağıran tarafın işi" ayrımı):

```ts
export interface RateLimitBucketState {
  /** Configured maximum tokens the bucket can ever hold (the "burst"
   * ceiling). */
  capacity: number;
  /** Tokens currently available, BEFORE this check's cost is deducted.
   * Always `0 <= tokensAvailable <= capacity`. */
  tokensAvailable: number;
  /** Tokens added back per millisecond (a fraction, e.g. capacity=60,
   * refillPerMs = 60 / 60_000 for "60 per minute"). */
  refillPerMs: number;
  /** Epoch-ms timestamp `tokensAvailable` was last refilled/observed
   * as-of. */
  lastRefillAtMs: number;
}

export interface RateLimitCheckResult {
  allowed: boolean;
  /** The bucket state to PERSIST after this check — includes both the
   * refill-catch-up AND, if `allowed`, the cost deduction. Callers
   * persist this unconditionally (even when `allowed` is false, the
   * refill catch-up itself must still be saved, or a
   * denied-then-retried caller would re-pay for refill time already
   * elapsed). */
  nextState: RateLimitBucketState;
  /** Only present when `allowed` is false — milliseconds until
   * `cost` tokens would become available, for a `Retry-After`-style
   * caller hint. */
  retryAfterMs?: number;
}

/**
 * Pure token-bucket transition: refills `bucket` up to `capacity`
 * based on elapsed time since `lastRefillAtMs`, THEN attempts to
 * deduct `cost` tokens. No I/O, no `Date.now()` call internally — `now`
 * is an explicit parameter so this function is deterministic and
 * trivially unit-testable (mirrors this codebase's existing pure-math
 * convention of never reading wall-clock time inside a pure function).
 */
export function checkRateLimit(
  bucket: RateLimitBucketState,
  cost: number,
  nowMs: number,
): RateLimitCheckResult;
```

**Neden token-bucket (ve neden sabit-pencere sayaç değil):** `AIUsageService`'in kendi deseni ("workspace başına kümülatif toplam, sabit bir eşiğe karşı") burst'e izin vermeyen, süresiz büyüyen bir sayaçtır — bağlayıcı çağrıları için uygun değil, çünkü bir bağlayıcının oran sınırı genellikle dış servisin KENDİ oran sınırını (ör. "dakikada 60 istek") yansıtmalı, tüm-zamanların kümülatif toplamını değil. Token-bucket, burst'e (kısa süreli, capacity'ye kadar art arda çağrı) izin verirken ortalama oranı `refillPerMs` ile sınırlar — bu, çoğu gerçek dış API'nin (Slack, GitHub, Google) kendi oran-sınırlama modeliyle doğrudan eşleşen, endüstri-standardı bir seçim.

### (i) `connector_credentials` Drizzle şeması

`apps/server/src/db/schema/connector-credentials.ts` (yeni dosya, migration + down script'iyle), `calendar-accounts.ts`'in AYNI kolon/FK stiliyle:

```ts
export const connectorCredentials = pgTable(
  'connector_credentials',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    connectorType: varchar('connector_type', { length: 50 }).notNull(),
    encryptedCredentials: text('encrypted_credentials').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('connector_credentials_workspace_user_type_key').on(
      table.workspaceId,
      table.userId,
      table.connectorType,
    ),
  ],
);
```

**Tekillik kısıtı kararı:** `(workspaceId, userId, connectorType)` üzerinde `uniqueIndex` VAR — `memory_access_policies`'in (ADR-0024 §i) ve `desktop_signal_consents`'in (ADR-0020) AYNI üçlü-anahtar tekillik mantığı: bir kullanıcının bir workspace'te bir bağlayıcı-tipi için TEK bir kimlik-bilgisi satırı olmalı (ör. bir kullanıcı `google-drive`'a birden çok kez bağlanamaz — yeniden bağlanma, mevcut satırın `encryptedCredentials`'ını GÜNCELLEMEli, ikinci bir satır oluşturmamalı). `varchar(50)` (`memory_access_policies.agent_identifier`'ın `varchar(100)`'ünden dar, `calendar_accounts.provider`'ın `varchar(20)`'sinden geniş) — bağlayıcı tipleri F2-T10'un 6 bilinen değeriyle (`google-drive`, `gmail`, `slack`, `github`, `notion`, `calendar`) sınırlı ama gelecekte büyüyebilecek bir açık-uçlu string (Karar (a)'nın "sunucu-taraflı enum yok" ilkesiyle tutarlı — bkz. ADR-0024 Karar (a)'nın `agentIdentifier` için aynı gerekçesi), `varchar(50)` her ikisine de rahatça yeten orta bir sınır.

`encryptedCredentials: text` — TEK bir şifreli metin sütunu, `calendar_accounts`'ın AYRI `encryptedAccessToken`/`encryptedRefreshToken` sütunlarının aksine: bir MCP bağlayıcısının kimlik-bilgisi şekli bağlayıcıdan bağlayıcıya değişir (bazıları OAuth access/refresh çifti, bazıları tek bir API anahtarı, F2-T10'un işi) — bu görev henüz hangi bağlayıcıların hangi kimlik-bilgisi şeklini taşıyacağını bilmiyor, dolayısıyla JSON-serileştirilmiş, sonra TEK BİR `encryptSecret` çağrısıyla şifrelenmiş bir "credentials blob" (ör. `{accessToken, refreshToken}` veya `{apiKey}`) genel/ileri-uyumlu doğru şekil; kolon sayısını bağlayıcı-tipine göre önceden dallandırmak bu görevin "framework-only, gerçek bağlayıcı yok" kapsamını aşardı.

### (j) `MockMcpConnector` — gerçek transport/ağ YOK

`packages/integrations/src/mcp/mock-mcp-connector.ts` (yeni dosya) — `MockCalendarConnector`'ın rolünün MCP-çatısı eşleniği: `McpConnector`'ı bellek-içi, deterministik olarak uygular; `connect`/`disconnect` bir dahili `connected: boolean` bayrağını değiştirir, `callTool`/`readResource` önceden yapılandırılmış (`MockMcpConnectorOptions`) yanıtlar döner veya bilinmeyen `toolName`/`uri` için throw eder, `checkHealth` yapılandırılabilir bir `ConnectorHealth` döner (varsayılan `{status:'ok'}`, testlerin bozulma senaryosu simüle edebilmesi için override edilebilir). `@modelcontextprotocol/sdk`'nın HİÇBİR sınıfını import etmez — çatının uçtan uca (kayıt→bağlan→sağlık-kontrolü→tool-çağrısı→bağlantı-kes) SDK'ya veya gerçek ağa dokunmadan kanıtlanmasını sağlar (Kabul Kriteri 6).

### (k) `apps/server/src/integrations/connector-credentials.service.ts`

`calendar-token-encryption.service.ts` + `calendar-accounts.service.ts`'in BİRLEŞİK şeklini genelleyen tek servis (iki ayrı servise BÖLÜNMEZ — kimlik-bilgisi saklama burada yeterince küçük ki `CalendarTokenEncryptionService`'in ayrı dosya olmasının gerekçesi — takvim modülünün token-refresh servisiyle paylaşılması — burada yok):

```ts
@Injectable()
export class ConnectorCredentialsService {
  async store(
    workspaceId: string,
    userId: string,
    connectorType: string,
    credentials: Record<string, unknown>,
  ): Promise<{ id: string; connectorType: string }>;
  // INSERT ... ON CONFLICT (workspace_id, user_id, connector_type)
  // DO UPDATE SET encrypted_credentials = ..., updated_at = now()
  // — Karar (i)'nin unique-index'i doğal bir upsert hedefi sağlıyor,
  // `MemoryAccessPolicyProjection`'ın `onConflictDoUpdate` desenine
  // (ADR-0024 §j) yapısal olarak benzer, ama event-sourced DEĞİL —
  // bu tablo `calendar_accounts` gibi salt read-side altyapı (ADR-0012
  // §a'nın "olay günlüğünün parçası değil" ayrımıyla aynı sınıf).

  /** Public metottan ASLA düz metin/şifreli metin dönmez — yalnızca
   * bağlayıcının kendi `connect()` çağrısı için ÇÖZÜLMÜŞ credentials
   * nesnesi, doğrudan çağıranın (bir DI fabrikası, F2-T10'un işi)
   * içinde tüketilir, loglanmaz. ADR-0012 §c'nin "public metotlardan
   * asla token dönmez" ilkesinin TAM genellemesi — burada "asla
   * ŞİFRELİ-metin dönmez" olarak genişletildi, çünkü şifreli metnin
   * kendisi bile gereksiz yere dışarı sızdırılmamalı. */
  async retrieve(
    workspaceId: string,
    userId: string,
    connectorType: string,
  ): Promise<Record<string, unknown> | undefined>;

  async remove(workspaceId: string, userId: string, connectorType: string): Promise<void>;
}
```

`ENCRYPTION_KEY`, `CalendarTokenEncryptionService`'in AYNI `env.encryptionKey`'i (Bağlam madde 2) — YENİ bir env değişkeni EKLENMEZ, tek bir genel AES-256-GCM ana anahtar tüm at-rest sırları (takvim + bağlayıcı kimlik-bilgileri) kapsar; eksikse `CalendarTokenEncryptionService`'in AYNI lazy-fatal `InvalidObjectStateError` deseni.

### (l) `apps/server/src/integrations/connector-rate-limit.service.ts`

`AIUsageService`'in AYNI kilit-korumalı kontrol-sonra-kaydet iskeletini, `rate-limit-math.ts`'in saf `checkRateLimit`'ini sarmalayarak:

```ts
@Injectable()
export class ConnectorRateLimitService {
  /** `AIUsageService.withWorkspaceAILock`'un AYNI
   * `pg_advisory_lock(hashtext(...))` deseni, ama kilit anahtarı
   * `${workspaceId}:${connectorType}` (bağlayıcı-başına, workspace
   * içinde bile farklı bağlayıcıların birbirini bloklamaması için —
   * `AIUsageService`'in workspace-başına tek bir AI kilidinden BİLİNÇLİ
   * bir sapma: burada N farklı bağlayıcı aynı workspace'te
   * BAĞIMSIZ oran sınırlarına tabi, hepsini tek bir kilit altında
   * sıraya sokmak gereksiz eşzamanlılık kaybı olurdu). Throws
   * `QuotaExceededError` if the bucket denies the call — REUSES
   * `AIUsageService`'in error tipini (yeni bir `RateLimitExceededError`
   * İCAT EDİLMEZ): `QuotaExceededError`'ın kendisi zaten
   * bağlayıcıdan-bağımsız, mesaj + `details` context taşıyan, HTTP 429
   * status kodlu genel bir "bu operasyon için ayrılmış pay tükendi"
   * kavramı — oran sınırı bunun bir özel durumu, ayrı bir hata sınıfı
   * gerekmez. */
  async assertNotRateLimited(
    workspaceId: string,
    connectorType: string,
    cost: number,
  ): Promise<void>;
}
```

İçeride: kilit altında mevcut `RateLimitBucketState`'i DB'den oku (yeni `connector_rate_limit_buckets` tablosu — `workspaceId`+`connectorType` PK/unique, `RateLimitBucketState`'in dört alanı sütun olarak), `checkRateLimit(bucket, cost, Date.now())` çağır, `nextState`'i DAİMA persist et (Karar (h)'nin "denied olsa bile refill catch-up'ı kaydet" notu), `!allowed` ise `QuotaExceededError` fırlat. Bu yeni tablonun tam şeması PR2 kapsamında implementer tarafından bu ADR'nin `RateLimitBucketState` alan listesine BİREBİR uyarak sabitlenir (kendi başına yeni bir mimari karar taşımıyor — Karar (h)'nin doğrudan bir DB-yansıması).

### (m) `apps/server/src/integrations/connector-health.service.ts`

`HealthService`'in AYNI `withTimeout`/`Promise.allSettled` deseni, ama global iki-probe (`db`+`redis`) yerine registry'deki (Karar (g)) HER bağlayıcı için:

```ts
export class ConnectorHealthService {
  constructor(
    private readonly registry: McpConnectorRegistry,
    options?: { timeoutMs?: number }, // HealthService'in AYNI varsayılan 2000ms
  ) {}

  /** `registry.list()`'teki HER bağlayıcı için `withTimeout(connector.checkHealth(), timeoutMs)`,
   * hepsi `Promise.allSettled` ile paralel — bir bağlayıcının zaman
   * aşımı/hatası diğerlerini ASLA engellemez (HealthService.check'in
   * AYNI izolasyon garantisi, iki sabit probe yerine N dinamik
   * bağlayıcıya genellenmiş). */
  async checkAll(): Promise<Record<string, ConnectorHealth>>;
}
```

`HealthService`'in kendisi (global `/health` uç noktası) BU serviste değişmez/genişletilmez — `ConnectorHealthService` ayrı, framework-bağımsız bir sınıf; `apps/server/src/health/`'e ait DEĞİL, `apps/server/src/integrations/`'a ait, çünkü bağlayıcı sağlığı bu görevin bounded context'i.

### (n) Kapsam sınırı — public REST uç noktası YOK

Bu görev hiçbir yeni `@Controller` eklemez. `ConnectorCredentialsService`/`ConnectorRateLimitService`/`ConnectorHealthService` bu PR'da yalnızca dahili (servis-seviyesi, DI ile enjekte edilebilir) kalır — hiçbir HTTP uç noktası onları dışarı açmaz. Gerekçe: bu görev "framework-only" (spec Amaç); gerçek bağlayıcı yönetimi UI'ı/API'si (bağlan/kes/listele uç noktaları), F2-T10'un kendi kapsamı — o görev gerçek bağlayıcılarla BİRLİKTE kendi controller'larını ekleyecek, bu çatı üzerine inşa ederek.

## Alt-PR ayrıştırması

Spec'in planı bu görevi İKİ alt-PR'a böler (F2-T5'in PR1/PR2 backend-paket-sonra-sunucu-modülü deseninin eşleniği):

- **PR1 — `packages/integrations/src/mcp/`** (protokol katmanı + SDK bağımlılığı): `mcp-connector.ts` (Karar f, ~50 satır), `mcp-connector-registry.ts` (Karar g, ~40 satır), `rate-limit-math.ts` (Karar h, ~60 satır), `mock-mcp-connector.ts` (Karar j, ~70 satır), `package.json`'a `@modelcontextprotocol/sdk` eklenmesi. Testler hariç tahmini ~220 satır — CLAUDE.md'nin mimari-kritik ±400 satır rehberliğinin altında.
- **PR2 — `apps/server/src/integrations/`** (kimlik-bilgisi/oran-sınırı/sağlık servisleri + DB şeması/migration): `connector-credentials.service.ts` (Karar k, ~90 satır), `connector-rate-limit.service.ts` (Karar l, ~80 satır), `connector-health.service.ts` (Karar m, ~40 satır), `apps/server/src/db/schema/connector-credentials.ts` + migration/down (Karar i, ~50 satır), yeni `connector_rate_limit_buckets` şeması + migration/down (Karar l, ~30 satır), `integrations.module.ts` (yeni, ~20 satır — CalendarModule'den BAĞIMSIZ, çünkü bu görev `calendar_accounts`'a dokunmuyor, Karar d). Testler hariç tahmini ~310 satır.

PR1 ve PR2 SIRALI'dır (PR2, PR1'in `McpConnector`/`McpConnectorRegistry` tiplerini import eder) — F2-T5'in kendi PR1→PR2 bağımlılık sırasıyla aynı disiplin. `test-writer`, her PR'ın kendi başlangıcında ÖNCE başarısız testleri yazar (CLAUDE.md TDD ritüeli); PR1'in testleri saf-fonksiyon/mock-tabanlı (gerçek DB/Nest gerektirmez), PR2'nin testleri `AIUsageService`'in kendi entegrasyon-test emsalini (`object-ai-refresh.integration.test.ts`, gerçek Postgres, eşzamanlı-çağrı yarış senaryosu) izler.

## Alternatifler ve Reddedilme Gerekçeleri

- **`McpConnector` arayüzünün `@modelcontextprotocol/sdk`'nın tiplerini doğrudan yeniden dışa aktarması (re-export).** Reddedildi — bu, LuminaOS'in TÜM diğer paketlerini (F2-T10, F2-T11, F2-T12) SDK'nın kendi API yüzeyine doğrudan bağımlı kılardı; SDK bir majör sürüm değiştirdiğinde kırılma tüm çağıranlara yayılırdı. LuminaOS'in KENDİ dar arayüzü (Karar f), SDK'yı yalnızca somut implementasyonların içinde bir uygulama detayı olarak tutar — `AIProvider`'ın Anthropic SDK'sını sarmalama deseniyle (ADR-0012 §d'nin referans aldığı emsal) aynı izolasyon ilkesi.
- **Sonuç dönen (throw etmeyen) bir `Result<T, E>` hata konvansiyonu.** Reddedildi — `CalendarConnector` (tek doğrudan emsal, aynı paket) ve bu repo'nun genel `packages/shared/errors` konvansiyonu (CLAUDE.md "Kodlama Sözleşmeleri": "hatalar `packages/shared/errors` sınıflarıyla fırlatılır") zaten throw-tabanlı; yeni bir hata-taşıma sözleşmesi icat etmek gereksiz bir ikinci konvansiyon yaratırdı. `checkHealth` TEK bilinçli istisna (Karar f) çünkü orada "bağlayıcı sağlıksız" beklenen, exceptional-olmayan bir sonuç.
- **Sabit-pencere (fixed-window) veya kayan-log (sliding-log) oran sınırlama algoritması.** Reddedildi (Karar h) — sabit-pencere pencere-sınırında iki katı trafiğe izin verme kusuru taşır (klasik "boundary burst" problemi); kayan-log her istek için ayrı zaman damgası saklamayı gerektirir (bu görevin dar kapsamına göre gereksiz depolama/karmaşıklık). Token-bucket, tek bir küçük durum (dört sayısal alan) ile hem burst-toleransı hem doğru ortalama-oran garantisi sağlıyor.
- **Oran-sınırı için yeni bir `RateLimitExceededError` sınıfı.** Reddedildi (Karar l) — `QuotaExceededError` zaten bağlayıcıdan-bağımsız, HTTP 429, mesaj+context taşıyan genel bir "pay tükendi" kavramı; ayrı bir sınıf sıfır ek davranış kazandırır, yalnızca `packages/shared/errors`'a bir dosya daha ekler.
- **`connector_credentials`'ta bağlayıcı-tipine göre ayrı, tip-özel sütunlar (ör. `oauthAccessToken`, `apiKey` gibi ayrı nullable sütunlar).** Reddedildi (Karar i) — bu görev henüz F2-T10'un hangi bağlayıcının hangi kimlik-bilgisi şeklini taşıyacağını bilmiyor (framework-only kapsam); tip-özel sütunlar önceden varsayım yapıp gelecekte migration gerektirirdi. Tek bir JSON-serileştirilmiş, şifreli `encryptedCredentials` blob'u ileri-uyumlu.
- **`ConnectorCredentialsService`'i `CalendarTokenEncryptionService`+`CalendarAccountsService` gibi iki ayrı sınıfa bölmek.** Reddedildi (Karar k) — o bölünmenin gerekçesi (token-refresh servisiyle şifreleme mantığının paylaşılması, ADR-0012) burada yok; bu görevde kimlik-bilgisi saklama tek bir CRUD yüzeyi, gereksiz dosya bölünmesi kod-okunabilirliğini azaltırdı.
- **Bağlayıcı sağlık kontrolünü mevcut `HealthService`/`/health` uç noktasına eklemek.** Reddedildi (Karar m) — `/health` global altyapı sağlığı (DB/Redis) için; bağlayıcı sayısı F2-T10 ile büyüyecek ve bağlayıcı-başına sağlık, altyapı-sağlığından kavramsal olarak farklı bir tüketici kitlesine (Connected Search'ün "bu kaynak şu an erişilebilir mi" sorusu, F2-T11) hizmet edecek; ayrı `ConnectorHealthService`, `HealthService`'i şişirmeden aynı deseni yeniden kullanıyor.
- **Bu görevde gerçek bir REST uç noktası eklemek (ör. "bağlayıcıları listele").** Reddedildi (Karar n) — spec'in kendi Amaç/Kapsam-Dışı bölümü bu görevi framework-only olarak sınırlıyor; gerçek bağlayıcı yönetimi API'si, gerçek bağlayıcılarla (F2-T10) birlikte anlamlı hale geliyor.

## Sonuçlar / Ödünler

**Şimdi ne kazanıyoruz:**

- Repodaki İLK gerçek MCP protokol kodu, SDK'nın gerçek API yüzeyi hakkında hiçbir hayali varsayım kilitlemeden kuruluyor — `implementer`'ın `.d.ts` dosyalarını okuma zorunluluğu, yanlış bir sözleşmenin ADR'ye/koda sızma riskini koddan önce ortadan kaldırıyor.
- `CalendarConnector`'ın ayrı kalması (Karar b) ve `connector_credentials`'ın ayrı tablo olması (Karar d), ADR-0012'nin takvim tasarımını hiçbir riske atmadan MCP çatısının bağımsız evrilmesini sağlıyor.
- Oran-sınırlama artık `packages/integrations`'ta framework-free, saf, tekrar kullanılabilir bir `checkRateLimit` fonksiyonu olarak var — hem `ConnectorRateLimitService` hem de (gelecekte, kendi ADR'sini gerektirmeden) başka bir bağlayıcı-dışı oran-sınırlama ihtiyacı bunu tüketebilir.
- Sağlık-kontrolü deseni (`withTimeout`+`Promise.allSettled`) ikinci kez, farklı bir bounded context'te kanıtlanıyor — `HealthService`'in tek-seferlik bir çözüm olmadığını, gerçek bir tekrarlanabilir emsal olduğunu gösteriyor.
- F2-T10/F2-T11/F2-T12'nin üçü de bu görevden SONRA gelen, bu ADR'nin sabitlediği sözleşmeyi (registry, kimlik-bilgisi servisi, oran-sınırı servisi, sağlık servisi, `McpConnector` arayüzü) doğrudan tüketebilir — her biri kendi ADR'sini bu temel katmanları yeniden tartışmadan yazabilir.

**Neyi erteliyoruz / kabul ediyoruz:**

- Gerçek dış bağlayıcılar (Google Drive, Gmail, Slack, GitHub, Notion, Takvimler) yok — tüm kabul kriterleri `MockMcpConnector`'a karşı kanıtlanıyor, `CalendarConnector`'ın Mock-öncelikli emsaliyle (ADR-0012 §d) aynı bilinçli erteleme.
- `connector_rate_limit_buckets` tablosunun tam şema detayları bu ADR'de sabitlenmedi (yalnızca `RateLimitBucketState`'in alan listesi) — implementer'a bırakılan, kendi başına yeni bir mimari karar taşımayan bir DB-yansıma detayı; PR2 sırasında test-writer/implementer tarafından sonuçlandırılır.
- `encryptedCredentials`'ın tek bir JSON-blob sütunu olması, gelecekte bir bağlayıcı-tipine özel kimlik-bilgisi alanı üzerinde SQL-seviyesi sorgu/filtre yapma ihtiyacı doğarsa (bugün yok) yeniden değerlendirilmesi gereken bir ödün — bugünkü framework-only kapsamda bu ihtiyaç yok.
- Bağlayıcı yönetimi için hiçbir public API/UI yok (Karar n) — F2-T10'a bırakıldı; bu görev yalnızca alttaki servis katmanını kanıtlıyor.
- Çoklu-sunucu-örneği (yatay ölçekleme) altında oran-sınırı/kimlik-bilgisi kilitlerinin doğruluğu, ADR-0012 §b'nin "tek-örnek varsayımı" ile AYNI bilinen sınırlama olarak miras alınıyor — `pg_advisory_lock` PostgreSQL-seviyesinde zaten çoklu-sunucu-güvenli (kilit veritabanında, uygulama sürecinde değil), ama bu görev bunu ayrıca doğrulamıyor/test etmiyor.
