# ADR-0028: LuminaOS MCP Sunucusu v0 — PAT Tabanlı Inbound Kimlik Doğrulama, Workspace-Bağımsız `POST /mcp`, Tek `get_context` Tool'u

**Durum:** Kabul edildi
**Tarih:** 2026-08-21
**İlgili görev:** [F2-T12 — LuminaOS MCP Sunucusu v0: Dışarıya Güvenli Bağlam Sunumu](../specs/F2-E3/F2-T12-mcp-sunucusu-v0.md)
**İlgili plan referansı:** `docs/PLAN.md` §"Epik F2-E3: MCP-native Entegrasyon (Kapsam G)" (F2-T12 satırı) ve CLAUDE.md "ADR Ne Zaman Gerekir" maddesinin HER İKİ fıkrası — (a) bu görev LuminaOS'e İLK KEZ **içeri doğru** (inbound) bir güven sınırı ekliyor (bugüne kadarki F2-T9/F2-T10/F2-T11 hep LuminaOS'in KENDİSİNİN bir MCP/OAuth2 İSTEMCİSİ olduğu, dışarı çıkan yön), "hassas veri sınıfları buluta ham gönderilmez" ve "veri dışa aktarma hiçbir planda/kodda kısıtlanamaz" değişmezleriyle bu YENİ yönde kesişiyor; (b) `docs/PLAN.md`'nin F3-T14'ü ("Federatif Beyin v0") bu görevin token/scope/tool modelini doğrudan miras alacağını açıkça ilan ediyor.

> Bu ADR'nin (a)-(k) maddeleri, spec'in (`F2-T12-mcp-sunucusu-v0.md`) Açık Sorular 1-7'sine plan onayında verilen yanıtları AYNEN kayda geçiriyor — icat etmiyor. Bu ADR'nin KENDİ katkısı, insanın açıkça `architect`'e bıraktığı iki karar: **(l) varsayılan/önerilen token süresi ve "süresiz" seçeneğinin v0'da hiç sunulup sunulmayacağı**, ve **(m) `McpTokenAuthGuard` + `POST /mcp` wiring'inin literal kod şekli**. Bu iki madde insan onayı beklemeden implementer'a geçilmemeli — CLAUDE.md Çalışma Ritüeli madde 2.

## Bağlam

1. **`ContextService.getContext(workspaceId, objectId, callerRole, options?)` doğrulandı** (`apps/server/src/context/context.service.ts:83-88`) — imza tam olarak budur, `Role` tipi `@luminaos/core-objects`'ten. `ContextController` (`apps/server/src/context/context.controller.ts`) bunu `SessionAuthGuard`+`WorkspaceMembershipGuard` arkasında, `req.membership?.role`'ü `MembershipRole` olarak cast edip çağırıyor (`requireRole` metodu, satır 51-57) — bu ADR'nin `McpTokenAuthGuard`'ının `request.membership` doldurma sözleşimi BİREBİR bu deseni taklit edecek şekilde tasarlandı (Karar m), böylece `get_context` tool handler'ı `ContextController`'ın kendisiyle AYNI `req.membership.role` okuma kodunu kullanabilir.
2. **`request.user`/`request.sessionId`/`request.membership` declaration-merge şekli doğrulandı** (`apps/server/src/common/request-context.ts:13-25`): `user?: {id: string; email: string}`, `sessionId?: string`, `membership?: {workspaceId: string; role: string}`. `SessionAuthGuard` (`session-auth.guard.ts:39-46`) `user`/`sessionId`'yi, `WorkspaceMembershipGuard` (`workspace-membership.guard.ts:29-33`) `membership`'i dolduruyor — ikisi de `WorkspaceMembershipService.assertMembership(userId, workspaceId): Promise<{workspaceId: string; role: string}>` (`workspace-membership.service.ts:36-66`) üzerinden. Bu servis "kim olduğun" (401, `UnauthorizedError`, boş/eksik `userId`) ile "neye erişebildiğin" (403, `ForbiddenError`, üyelik yok) arasında BİLİNÇLİ bir ayrım yapıyor — `McpTokenAuthGuard` bu ayrımı AYNEN devralır (Karar i).
3. **`SessionService.findUserById(userId): Promise<SessionUser | null>`** (`apps/server/src/auth/session.service.ts:91-99`) doğrulandı — `{id, email, createdAt}` seçiyor, satır bulunamazsa `null`. `SessionAuthGuard` zaten bunu kullanıyor (satır 39); `McpTokenAuthGuard` da AYNI metodu, AYNI "bulunamazsa 401" semantiğiyle çağıracak.
4. **`hashPassword`/`verifyPassword`** (`apps/server/src/auth/password.ts`) argon2id, RASTGELE-tuzlu, düşük-entropili kullanıcı parolaları için tasarlanmış — her çağrıda FARKLI hash üretir, dolayısıyla bir DB sorgusuyla "bu hash'e sahip satırı bul" YAPILAMAZ (yalnızca "bildiğim bir satırın hash'i bu mu" doğrulanabilir). PAT'ler ~256 bit rastgele entropi taşıdığı için (kullanıcı seçmiyor, `crypto.randomBytes` üretiyor) bu yapıya ihtiyaç YOK — deterministik `sha256` + tek sorguluk tam-eşleşme yeterli ve doğru araç (Karar a).
5. **`crypto.randomBytes(32).toString('base64url')` deseni bu kod tabanında ZATEN kurulu emsal** — ADR-0026 Karar (i)'nin `OAuthStateService.issue`'sü `state`'i BİREBİR bu şekilde üretiyor ("opak, 256-bit entropi, imzalı bir taşıyıcı DEĞİL"). Bu ADR aynı deseni PAT üretimi için tekrar kullanıyor, yeni bir yöntem icat etmiyor.
6. **`connectorCredentials` tablosunda GERÇEK FK var** (`apps/server/src/db/schema/connector-credentials.ts:23-28`, `workspaceId`/`userId` → `workspaces.id`/`users.id`, `onDelete: 'cascade'`), **`connectorRateLimitBuckets`'ta İSE BİLİNÇLİ OLARAK YOK** (`apps/server/src/db/schema/connector-rate-limit-buckets.ts:24-32`, dosyanın kendi yorumu: `connector-rate-limit.integration.test.ts`'in `freshWorkspaceId()` yardımcısı sadece sözdizimsel-geçerli rastgele bir uuid üretiyor, gerçek bir `workspaces` satırı hiç INSERT etmiyor — gerçek bir FK burada HER testi kırardı). Bu asimetri gerçek ve kasıtlı, test-dosyası kısıtından kaynaklanıyor — icat edilen bir emsal değil.
7. **`ConnectorRateLimitService.assertNotRateLimited`** (`connector-rate-limit.service.ts:39-111`) `pg_advisory_lock` korumalı check-then-persist iskeleti, varsayılanları **`DEFAULT_BUCKET_CAPACITY = 60`, `DEFAULT_REFILL_PER_MS = 60 / 60_000`** (satır 19-20, "60 çağrı burst, dakikada 60 yenilenme"). `checkRateLimit(bucket: RateLimitBucketState, cost: number, nowMs: number): RateLimitCheckResult` (`packages/integrations/src/mcp/rate-limit-math.ts:39-74`) saf/durumsuz, `now` açık parametre — I/O yok.
8. **`@modelcontextprotocol/sdk@1.x`'in gerçek sunucu-tarafı tip yüzeyi bu oturumda doğrulandı** (`node_modules/.pnpm/@modelcontextprotocol+sdk@1_.../dist/esm/server/{mcp,streamableHttp}.d.ts`):
   - `McpServer` (`./server/mcp.js`): `constructor(serverInfo: Implementation, options?: ServerOptions)`; `connect(transport: Transport): Promise<void>`; `registerTool<OutputArgs, InputArgs>(name: string, config: {title?, description?, inputSchema?, outputSchema?, annotations?, _meta?}, cb: ToolCallback<InputArgs>): RegisteredTool`.
   - `StreamableHTTPServerTransport` (`./server/streamableHttp.js`): `constructor(options?: StreamableHTTPServerTransportOptions)` — **stateless mod** için dosyanın kendi doc-comment örneği `sessionIdGenerator: undefined` geçiriyor (satır 37-39); `handleRequest(req: IncomingMessage & {auth?}, res: ServerResponse, parsedBody?: unknown): Promise<void>` — ham Node `IncomingMessage`/`ServerResponse` alıyor (Express'in `Request`/`Response`'u ikisini de extend ettiği için doğrudan uyumlu).
9. **`MemoryAccessPolicy`** (`packages/memory/src/memory-access-policy.ts:8-15`, ADR-0024) grant/revoke şekli — satırın VARLIĞI + `revokedAt === null` = "izinli", ayrı bir enum YOK. Bu, `mcp_client_grants`'ın revoke semantiği için doğrudan örnek alınan emsal (Karar b) — ama `MemoryAccessPolicy` **event-sourced DEĞİL** (bkz. madde 10), bu ADR'nin de takip ettiği plain-CRUD emsal aslında `connector_credentials`/`connector_rate_limit_buckets`.
10. **CLAUDE.md'nin "Mimari Değişmezler"i:** _"Tek doğruluk kaynağı olay günlüğüdür; bağlam grafiği ve tüm projeksiyonlar türetilir."_ Bu değişmez, **çekirdek bağlam grafiğinin** (nesneler/alanlar/ilişkiler — `contextGraphNodes`/`contextGraphEdges`, ADR-0017) her zaman bir olay günlüğünden türetilen bir projeksiyon olmasını zorunlu kılıyor. `connector_credentials`/`connector_rate_limit_buckets`/`oauth_state_tokens` (hepsi ADR-0025/ADR-0026, halihazırda kabul edilmiş) hiçbiri event-sourced DEĞİL — bunlar bağlam grafiğinin bir parçası değil, güvenlik-yapılandırması/altyapı durumu (kimlik bilgisi saklama, oran sınırı sayacı, CSRF state). Bu ayrım YENİ icat edilmiyor, zaten kurulu pratik.
11. **`IntegrationsPanel.tsx`** (`apps/web/src/views/shared/`) düz-JSX, `App.tsx`'e kardeş montaj deseni — spec'in Açık Soru 7'sinin önerdiği `McpAccessPanel.tsx`'in izleyeceği desen (bu ADR'nin kapsamı değil, `implementer`'a bırakılır).

## Karar

### (a) Kimlik doğrulama modeli — PAT, `sha256` hash, `crypto.randomBytes(32).toString('base64url')` (insan kararı, aynen kayıt)

OAuth2 client-credentials DEĞİL, kullanıcının panelden oluşturduğu bir Kişisel Erişim Belirteci (PAT). Token üretimi: `crypto.randomBytes(32).toString('base64url')` (256 bit rastgele entropi, ~43 karakter) — Bağlam madde 5'in ZATEN kurulu deseni, yeni bir yöntem icat edilmiyor. Yalnızca oluşturma anında düz metin döner; sonrasında yalnızca `sha256` hash saklanır (`crypto.createHash('sha256').update(token).digest('hex')`). **Neden `argon2` DEĞİL:** Bağlam madde 4 — argon2'nin rastgele-tuzlu tasarımı düşük-entropili parolalar için doğru araç, ama bu özelliği tam olarak "hash'e göre DB'de arama" yapmayı İMKANSIZLAŞTIRIYOR (her hash farklı çıkar). PAT zaten yüksek entropili olduğu için sözlük/brute-force saldırısı argon2'nin çözdüğü tehdit modeli DEĞİL — deterministik `sha256` + tek `WHERE token_hash = $1` sorgusu hem doğru hem daha basit.

`tokenPrefix` kolonu: ham token'ın İLK 12 karakteri, düz metin olarak saklanır — SADECE kullanıcının yönetim panelinde "hangi token bu" diye görsel ayırt etmesi için (ör. `Ab3xK9mZ...`), bir arama/kimlik-doğrulama mekanizması DEĞİL (o iş zaten `tokenHash` tam-eşleşmesiyle çözülüyor).

### (b) `mcp_client_grants` tablosu — plain Drizzle tablosu

```ts
// apps/server/src/db/schema/mcp-client-grants.ts
export const mcpClientGrants = pgTable(
  'mcp_client_grants',
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
    name: varchar('name', { length: 200 }).notNull(), // kullanıcının verdiği ad, ör. "Kişisel Claude Desktop'ım"
    tokenHash: varchar('token_hash', { length: 64 }).notNull(), // sha256 hex, 64 karakter sabit
    tokenPrefix: varchar('token_prefix', { length: 12 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }), // nullable -- Karar (l)
    revokedAt: timestamp('revoked_at', { withTimezone: true }), // nullable -- MemoryAccessPolicy deseni
  },
  (table) => [uniqueIndex('mcp_client_grants_token_hash_key').on(table.tokenHash)],
);
```

`tokenHash` üzerinde `uniqueIndex` — hem tam-eşleşme aramasının O(1) index-lookup olmasını garanti eder hem de (istatistiksel olarak imkansız olsa da) bir hash çakışmasının sessizce iki farklı grant'a bağlanmasını DB seviyesinde engeller. Revoke, `MemoryAccessPolicy` deseninin AYNI: satır SİLİNMEZ, `revokedAt` doldurulur (denetim izi için — kim, ne zaman, hangi token'ı iptal etti bilgisi kalır).

### (c) Neden event-sourced DEĞİL — "Mimari Değişmezler"le gerilim YOK

CLAUDE.md'nin "tek doğruluk kaynağı olay günlüğüdür" maddesi **çekirdek bağlam grafiği** (nesneler/alanlar/ilişkiler, ADR-0017) için bağlayıcı — bu grafik her zaman bir olay günlüğünden türetilen bir projeksiyon olmalı, çünkü kullanıcıya görünen "gerçeklik" budur ve zaman-yolculuğu/denetim/çakışma-çözümü bu ilkeye dayanır. `mcp_client_grants` bu grafiğin bir parçası DEĞİL — bir kullanıcının "hangi dış istemciye eriştim verdiği" bilgisi, tıpkı `connector_credentials` (Bağlam madde 6, gerçek FK'lı ama event-sourced değil) ve `connector_rate_limit_buckets` gibi, **güvenlik-yapılandırması/altyapı durumu**. Bu tablolarda "geçmişte hangi durumdaydı" sorusuna olay-günlüğü seviyesinde cevap verme ihtiyacı hiç doğmadı (F2-T9/ADR-0025'ten bu yana hiçbir görev bunu talep etmedi) — grant/revoke zaten kendi başına yeterli denetim izini (`createdAt`/`revokedAt`) taşıyor. Bu bir YENİ istisna icat etmek değil, zaten iki emsalle (Bağlam madde 6) kurulu ayrımın üçüncü uygulaması.

### (d) Token→workspace bağlanması — token'ın KENDİSİNDEN, URL'den DEĞİL (insan kararı, aynen kayıt)

`POST /mcp` workspace-bağımsız — URL'de `:workspaceId` YOK. `mcp_client_grants.workspaceId`/`userId` token oluşturulduğu anda SABİTLENİR; guard token'ı çözüp bu ikisini ORADAN okur. F2-T10'un OAuth callback'inde bulunup düzeltilen AYNI güvenlik açığı SINIFI'nın (URL parametresi ile gerçek yetki kaynağının bağımsız iki kaynak olması, ADR-0026 Karar j) yapısal olarak burada da önlenmesi.

### (e) v0 tool seti — yalnızca `get_context(objectId)` (insan kararı, aynen kayıt)

Mevcut, DEĞİŞTİRİLMEMİŞ `ContextService.getContext(workspaceId, objectId, callerRole, options?)`'ı (Bağlam madde 1) saran TEK tool. `search` v0'da YOK.

### (f) v0 salt-okunur (insan kararı, aynen kayıt)

Hiçbir mutasyon tool'u/resource'u yok. `McpServer`'a `registerTool` yalnızca `get_context` için çağrılır.

### (g) Kapsam granülerliği — TEK kapsam (insan kararı, aynen kayıt)

Bir token, sahibi kullanıcının workspace'te zaten GÖREBİLDİĞİ her şeyi salt-okunur görebilir. `ContextService`'in mevcut alan-bazlı izin süzgeci (`canViewField`, ADR-0018) DEĞİŞMEDEN miras alınır — MCP'ye özel YENİ bir kısıtlama katmanı icat edilmez. Nesne-tipi bazlı kapsamlama v0'da YOK.

### (h) Inbound oran sınırlama — yeni tablo, GERÇEK FK, AYNI varsayılan sabitler (insan kararı, aynen kayıt)

`checkRateLimit` (Bağlam madde 7) yeniden kullanılır, ama `ConnectorRateLimitService`'in KENDİSİ değil — `(workspaceId, connectorType)` yerine `(workspaceId, mcpClientGrantId)` anahtarlı YENİ bir servis:

```ts
// apps/server/src/db/schema/mcp-rate-limit-buckets.ts
export const mcpRateLimitBuckets = pgTable(
  'mcp_rate_limit_buckets',
  {
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    mcpClientGrantId: uuid('mcp_client_grant_id')
      .notNull()
      .references(() => mcpClientGrants.id, { onDelete: 'cascade' }),
    capacity: integer('capacity').notNull(),
    tokensAvailable: doublePrecision('tokens_available').notNull(),
    refillPerMs: doublePrecision('refill_per_ms').notNull(),
    lastRefillAtMs: bigint('last_refill_at_ms', { mode: 'number' }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.mcpClientGrantId] })],
);
```

**Neden burada GERÇEK FK var, outbound tabloda YOKTU:** Bağlam madde 6'nın açıkladığı asimetri sentetik bir test-fixture kısıtından kaynaklanıyordu (`connector-rate-limit.integration.test.ts`'in gerçek `workspaces` satırı hiç INSERT etmeyen `freshWorkspaceId()` yardımcısı). Bu tablo İSE gerçek, üretimde-var-olan grant'lara bağlı — hiçbir test burada "sahte workspaceId" fikstürüne ihtiyaç duymuyor (bir grant zaten gerçek bir `mcp_client_grants` satırına, o da gerçek bir `workspaces` satırına FK'lı olmak ZORUNDA — token oluşturma akışı bunu doğal olarak garanti ediyor). FK eklemenin hiçbir testi kırma riski yok, veri bütünlüğü kazancı ücretsiz.

Varsayılan sabitler `ConnectorRateLimitService`'inkiyle AYNI: `DEFAULT_BUCKET_CAPACITY = 60`, `DEFAULT_REFILL_PER_MS = 60 / 60_000` — yeni bir sabit icat edilmiyor (spec Açık Soru 6'nın önerisi aynen kabul).

### (i) `McpTokenAuthGuard` mimarisi — `SessionAuthGuard`+`WorkspaceMembershipGuard`'ın YENİDEN KULLANIMI DEĞİL (insan kararı, aynen kayıt)

Çerez yok, URL'de `:workspaceId` yok — bu iki mevcut guard MCP protokol uç noktasına uygulanamaz. Yeni bir guard, ikisinin sorumluluğunu TEK adımda birleştirir:

1. `Authorization: Bearer <token>` başlığını çöz; yoksa/şekli bozuksa **401**.
2. `sha256(token)` hesapla, `mcp_client_grants`'ta TAM eşleşen satırı ara; bulunamazsa VEYA `revokedAt IS NOT NULL` VEYA `expiresAt IS NOT NULL AND expiresAt <= now()` ise **401** (`UnauthorizedError`) — üçü de AYNI 401'e indirgenir, saldırgana hangi durumun geçerli olduğunu SÖYLEMEMEK için (ADR-0026 Karar i'nin `OAuthStateService.consume`'unun "geçersiz" ile "süresi dolmuş" arasında BİLİNÇLİ ayrım yapmama ilkesiyle AYNI disiplin).
3. `SessionService.findUserById(grant.userId)` (Bağlam madde 3) — `null` ise **401** (kullanıcı silinmiş olabilir; token teknik olarak hâlâ "geçerli" görünse de sahibi yok).
4. `WorkspaceMembershipService.assertMembership(userId, grant.workspaceId)` (Bağlam madde 2) — **CANLI** üyelik kontrolü, token oluşturulduğu andaki DEĞİL. Kullanıcı workspace'ten çıkarılmışsa bu adım `ForbiddenError` (**403**) fırlatır — token'ın KENDİSİ iptal edilmemiş olsa bile, kullanıcı workspace'ten atıldığı ANDA bu token'la yapılan hiçbir çağrı başarılı olmaz, hiçbir manuel revoke-aksiyonu gerekmeden. "Kim olduğun" (401) ile "neye erişebildiğin" (403) ayrımı, `WorkspaceMembershipService`'in zaten kurduğu AYNI ilke.
5. `request.user = {id: user.id, email: user.email}`, `request.membership = {workspaceId: grant.workspaceId, role}` — `SessionAuthGuard`/`WorkspaceMembershipGuard`'ın doldurduğu AYNI şekil (Bağlam madde 2) — `ContextController.requireRole`'ün (Bağlam madde 1) okuduğu kodun MCP tool handler'ında SIFIR değişiklikle tekrar kullanılabilmesi için.

### (j) MCP sunucusu wiring'i — istek-başına TAZE `McpServer`+`StreamableHTTPServerTransport`, bağlantı havuzu YOK (insan kararı, aynen kayıt)

Her `POST /mcp` çağrısı YENİ bir `McpServer` + YENİ bir `StreamableHTTPServerTransport({sessionIdGenerator: undefined})` (Bağlam madde 8'in stateless-mod örneği) inşa eder, `get_context` tool'unu bu istek için çözülmüş `(workspaceId, userId, role)` kapanışıyla kaydeder, `transport.handleRequest(req, res, req.body)`'yi çağırır. Bu, ADR-0026 Karar (g)/ADR-0027 Karar (a)'nın OUTBOUND bağlayıcılar için kurduğu "istek-başına taze örnek, bağlantı havuzu YOK" felsefesinin **INBOUND aynası** — aynı YAGNI gerekçesi (ölçülmüş bir performans sorunu yok, oturum-durumu paylaşımı kullanıcılar-arası kirlenme riski taşır).

### (k) Token yönetimi uç noktaları — mevcut oturum-çerezi kimlik doğrulaması (insan kararı, aynen kayıt)

`POST/GET /workspaces/:workspaceId/mcp/grants`, `DELETE /workspaces/:workspaceId/mcp/grants/:grantId` — `SessionAuthGuard`+`WorkspaceMembershipGuard` (`ContextController`'ın AYNI guard yığını). Bunlar bir insanın TARAYICIDAN kendi token'larını yönettiği rotalar — MCP protokolüyle (Karar i) ilgisiz, DEĞİŞTİRİLMEZ.

---

### (l) [ARCHITECT KARARI — insan onayı gerekli] Varsayılan/önerilen token süresi: "süresiz" v0'da SUNULMAZ, sabit 30/90/365 gün menüsü, varsayılan 90 gün

**Karar:** Token oluşturma panelinde kullanıcıya "süresiz" seçeneği HİÇ SUNULMAZ. UI yalnızca sabit bir süre menüsü gösterir: **30 / 90 / 365 gün**, varsayılan seçili değer **90 gün**. `expiresAtDays` alanı zod ile `z.union([z.literal(30), z.literal(90), z.literal(365)])` olarak doğrulanır — sunucu bunu `createdAt + N gün` olarak MUTLAK bir `expiresAt` zaman damgasına çevirir; istemciden HİÇBİR ZAMAN ham/mutlak bir tarih kabul edilmez (ADR-0026 Karar j'nin "istemci-sağlanan bir hedefi asla yönlendirme kararına girdi yapma" ilkesinin, burada "istemci-sağlanan bir tarihi asla son-kullanma kararına girdi yapma" biçimine uyarlanmışı).

**Gerekçe:**

- Bu, LuminaOS'e İLK KEZ eklenen bir inbound güven sınırı (Bağlam) — sızması durumunda saldırganın eline geçen şey "bir workspace'in kullanıcının GÖREBİLDİĞİ HER ŞEYİNE salt-okunur erişim" (Karar g'nin tek-kapsam kararı gereği, nesne-tipi bazlı bir sınırlama bile yok). Süresiz bir PAT, bu genişlikte bir yetkiyi HİÇBİR doğal sona erme noktası olmadan taşır — kullanıcı unutursa (ki dış bir MCP istemcisine bir kere kurulup "hiç düşünülmeyen" bir kimlik bilgisi tam olarak bu unutma riskinin arketipi), sızıntı fark edilene kadar süresiz açık kalır.
- Bu kod tabanının mevcut kimlik-bilgisi hijyeni pratiği zaten "her şey sona erer" yönünde: `oauth_state_tokens`'ın 10 dakikalık TTL'i (ADR-0026 Karar i), OAuth erişim token'larının kendi `expiresAt`'i (ADR-0026 Bağlam madde 3'ün `exchangeAuthorizationCode` dönüş şekli, `expiresAt?: string`). Bu ADR'nin ilk INBOUND kimlik bilgisi türünü, kod tabanının şimdiye kadar hiç sınamadığı bir "süresiz" istisnasıyla başlatmak, bu tutarlı pratikten gerekçesiz bir SAPMA olurdu.
- Karşı-argüman (rotasyon sürtünmesi) gerçek ama v0'ın küçük gerçek kullanıcı sayısıyla orantısız: 365 günlük seçenek zaten "yıl-başına-bir-rotasyon" sürtünmesini pratik olarak "süresiz"e çok yaklaştırıyor (bir MCP istemcisi genelde kurulup uzun süre dokunulmadan kullanılıyor) — kullanıcı gerçekten çok-uzun-ömürlü bir token istiyorsa 365 gün seçip yılda bir kez yeniler; bu, "asla düşünmeme" ile "yılda bir kez kısa bir hatırlatma" arasında makul bir orta nokta, sıfır-sürtünme/sıfır-doğal-cutoff ikilisinden daha güvenli.
- DB kolonu (`expiresAt`, Karar b) yine de **nullable** bırakılıyor — bu, v0'ın API yüzeyinin `NULL` yazmasına asla izin vermeyeceği ama şemanın gelecekte (ör. F3-T14'ün kurumlar-arası federasyonunda bir admin'in KASITLI olarak süresiz bir federasyon-token'ı tanımlaması gerekirse) bu genişlemeye açık kalmasını sağlayan bir gelecek-uzantı noktası — v0'ın HİÇBİR kod yolu bunu kullanmıyor.

### (m) [ARCHITECT KARARI — insan onayı gerekli] `McpTokenAuthGuard` + `POST /mcp` — literal kod şekli

```ts
// apps/server/src/mcp-server/mcp-token-auth.guard.ts
import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';

import { UnauthorizedError } from '@luminaos/shared';

import { DATABASE_CONNECTION } from '../db/database-connection.token.js';
import { mcpClientGrants } from '../db/schema/mcp-client-grants.js';
import { SessionService } from '../auth/session.service.js';
import { WorkspaceMembershipService } from '../workspaces/workspace-membership.service.js';

import type { Database } from '../db/client.js';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

@Injectable()
export class McpTokenAuthGuard implements CanActivate {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly db: Database,
    private readonly sessionService: SessionService,
    private readonly membershipService: WorkspaceMembershipService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const authHeader = request.headers.authorization;
    const token = this.extractBearerToken(authHeader);
    if (!token) throw new UnauthorizedError();

    const tokenHash = createHash('sha256').update(token).digest('hex');
    const [grant] = await this.db
      .select()
      .from(mcpClientGrants)
      .where(eq(mcpClientGrants.tokenHash, tokenHash))
      .limit(1);

    const now = new Date();
    if (
      !grant ||
      grant.revokedAt !== null ||
      (grant.expiresAt !== null && grant.expiresAt <= now)
    ) {
      throw new UnauthorizedError(); // "yok"/"iptal"/"süresi dolmuş" hep aynı 401
    }

    const user = await this.sessionService.findUserById(grant.userId);
    if (!user) throw new UnauthorizedError();

    // CANLI üyelik kontrolü -- token oluşturulduğu andaki değil (Karar i).
    // Üye değilse ForbiddenError (403) fırlatır, guard'ı burada durdurur.
    const { role } = await this.membershipService.assertMembership(user.id, grant.workspaceId);

    request.user = { id: user.id, email: user.email };
    request.membership = { workspaceId: grant.workspaceId, role };
    request.mcpGrant = { id: grant.id }; // rate-limit anahtarı için (Karar h)

    return true;
  }

  private extractBearerToken(header: string | undefined): string | undefined {
    if (!header || !header.startsWith('Bearer ')) return undefined;
    const token = header.slice('Bearer '.length).trim();
    return token.length > 0 ? token : undefined;
  }
}
```

`request-context.ts`'e (Bağlam madde 2) YENİ bir opsiyonel alan eklenir: `mcpGrant?: { id: string }` — `McpTokenAuthGuard`'a özel, `SessionAuthGuard` yolunda hiç dolmaz.

```ts
// apps/server/src/mcp-server/mcp.controller.ts
import { Controller, Post, Req, Res, UseGuards } from '@nestjs/common';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

import { McpTokenAuthGuard } from './mcp-token-auth.guard.js';
import { InboundMcpRateLimitService } from './inbound-mcp-rate-limit.service.js';
import { ContextService } from '../context/context.service.js';

import type { Request, Response } from 'express';
import type { Role } from '@luminaos/core-objects';

@Controller('mcp') // workspace-bağımsız -- Karar (d)
@UseGuards(McpTokenAuthGuard)
export class McpController {
  constructor(
    private readonly contextService: ContextService,
    private readonly rateLimit: InboundMcpRateLimitService,
  ) {}

  @Post()
  async handleMcp(@Req() req: Request, @Res() res: Response): Promise<void> {
    const workspaceId = req.membership!.workspaceId;
    const role = req.membership!.role as Role;
    const grantId = req.mcpGrant!.id;

    await this.rateLimit.assertNotRateLimited(workspaceId, grantId, 1);

    const server = new McpServer({ name: 'luminaos', version: '1.0.0' });
    server.registerTool(
      'get_context',
      {
        description: 'Bir LuminaOS nesnesinin 1-hop bağlam grafiğini getirir.',
        inputSchema: { objectId: z.string() },
      },
      async ({ objectId }) => {
        const result = await this.contextService.getContext(workspaceId, objectId, role);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      },
    );

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  }
}
```

`@UseGuards(McpTokenAuthGuard)` decorator sırası tektir (yalnızca bir guard) — `SessionAuthGuard`/`WorkspaceMembershipGuard`'ın iki-guard sıralı zincirinden farklı olarak, tüm sorumluluk (Karar i'nin 1-5 adımı) tek sınıfta toplanıyor, çünkü bu iki mevcut guard'ın hiçbiri ayrı ayrı yeniden kullanılabilir DEĞİL (biri çereze, öteki URL parametresine bağımlı). `InboundMcpRateLimitService.assertNotRateLimited`'ın kod şekli `ConnectorRateLimitService`'in (Bağlam madde 7) BİREBİR kopyası, yalnızca `connectorType` yerine `mcpClientGrantId` parametre adıyla ve `mcp-rate-limit-buckets` tablosuna yazarak.

## Mimari Değişmezlerle İlişki

- **"Hassas veri sınıfları buluta ham gönderilmez."** Bu ADR, harici, LuminaOS-DIŞI bir yazılımın (Claude Desktop vb.) workspace verisini doğrudan okuduğu İLK durum. Buradaki güvence YENİ icat edilmiyor — `ContextService.getContext`'in ZATEN uyguladığı alan-bazlı izin süzgeci (`canViewField`, ADR-0018) hiç değiştirilmeden miras alınıyor (Karar e/g): MCP istemcisi tam olarak token sahibi kullanıcının tarayıcıdan GÖRDÜĞÜ alanları görür, ne fazla ne eksik. Bu ADR'nin katkısı "hangi alanlar gizli kalsın" sorusunu YENİDEN çözmek değil, bu ZATEN doğrulanmış süzgecin yeni bir giriş kapısında (MCP protokolü) da aynen çalıştığını garanti etmek (Kabul Kriteri: "hiçbir gizli alan sızmaz").
- **"Veri dışa aktarma hiçbir planda/kodda kısıtlanamaz."** Bu MCP sunucusu, tanım gereği bir veri dışa aktarma biçimidir (workspace bağlamının LuminaOS DIŞINA, başka bir yazılıma okunması). ADR-0016'nın kurduğu kural — okuma/dışa-aktarım rol-kapılı DEĞİL, yalnızca ÜYELİK-kapılı — bu ADR'de de AYNEN geçerli: `McpTokenAuthGuard`'ın tek erişim şartı canlı workspace üyeliği (Karar i madde 4), token sahibinin ROLÜ `get_context`'in çağrılıp çağrılamayacağını değil, yalnızca (mevcut alan-bazlı süzgeç aracılığıyla) HANGİ alanların göründüğünü etkiler. Hiçbir plan-katmanı/lisans kontrolü bu uç noktayı KISITLAMIYOR — ADR-0016'nın önceden ilan ettiği kuralla tam tutarlı.

## Değerlendirilip reddedilen alternatifler

- **OAuth2 client-credentials akışı (tam kaynak-sunucu akışı).** Reddedildi (Karar a) — v0'ın hedefi tek kullanıcının kendi MCP istemcisine erişim vermesi; PAT bunun için GitHub/Notion emsaliyle tutarlı, çok daha az karmaşık bir çözüm. Gerçek kurumlar-arası federasyon (F3-T14) gerektiğinde ayrı bir karar.
- **`argon2` ile PAT hash'leme.** Reddedildi (Karar a, Bağlam madde 4) — PAT'in yüksek entropisi argon2'nin çözdüğü tehdit modelini (düşük-entropili parola sözlük saldırısı) geçersiz kılıyor; deterministik `sha256` + tek sorgu daha basit VE doğru.
- **`SessionAuthGuard`+`WorkspaceMembershipGuard`'ı MCP uç noktasında yeniden kullanmak.** Reddedildi (Karar i) — biri httpOnly çerez, öteki URL'deki `:workspaceId`'ye bağımlı; MCP isteğinde ikisi de yok. Ayrı bir guard, sorumluluğu tek sınıfta birleştirerek daha az yüzey.
- **`ConnectorRateLimitService`'i doğrudan yeniden kullanmak.** Reddedildi (Karar h) — anahtarı `(workspaceId, connectorType)`'a sabit; `(workspaceId, mcpClientGrantId)` anahtarına genişletmek metodun imzasını (ve dolayısıyla mevcut, gözden geçirilmiş outbound tüketicilerini) değiştirirdi. `checkRateLimit`'in kendisi saf/durumsuz olduğu için YENİDEN KULLANILIYOR, servis sarmalayıcısı YENİ.
- **Bağlantı havuzlama/oturum yeniden kullanımı (MCP sunucusu tarafında).** Reddedildi (Karar j) — ADR-0026/ADR-0027'nin OUTBOUND tarafta zaten reddettiği alternatifin aynısı; ölçülmüş bir performans sorunu yok, paylaşılan durum kullanıcılar-arası kirlenme riski taşır.
- **Token oluşturma panelinde "süresiz" seçeneğini varsayılan-DEĞİL ama sunulan bir seçenek olarak bırakmak.** Reddedildi (Karar l) — bu, "unut ve sonsuza kadar açık kal" yolunu HİÇ engellemeden sadece görünmez kılardı; bu ADR'nin gerekçesi seçeneğin kendisinin var OLMAMASI gerektiği, varsayılanının farklı olması değil.
- **`expiresAt`'i istemcinin gönderdiği mutlak bir tarihten hesaplamak.** Reddedildi (Karar l) — istemci-kontrollü bir mutlak tarih, sunucu tarafında hiçbir üst sınır garantisi taşımaz (istemci teorik olarak 100 yıl sonrasını gönderebilir); sabit bir gün-sayısı enum'undan sunucu tarafında hesaplamak, ADR-0026 Karar (j)'nin "istemci girdisini asla kritik bir karara doğrudan girdi yapma" ilkesiyle tutarlı.

## Sonuçlar / Etkiler

**Şimdi ne kazanıyoruz:**

- LuminaOS'e ilk kez GERÇEK bir inbound güven sınırı ekleniyor — "hassas veri sınıfları buluta ham gönderilmez" ve "veri dışa aktarma kısıtlanamaz" değişmezlerinin bu YENİ yönde de tutarlı kaldığı, mevcut `ContextService`/ADR-0016 emsallerini YENİDEN İCAT ETMEDEN kanıtlanıyor.
- `checkRateLimit`'in (ADR-0025 §h) İKİNCİ gerçek tüketicisi (ilki `ConnectorRateLimitService`, ADR-0027) — saf fonksiyonun genellenebilirliği doğrulanıyor.
- F3-T14'ün ("Federatif Beyin v0") doğrudan miras alacağı token/scope/tool modeli somut, test edilebilir bir temelle kuruluyor.

**Neyi erteliyoruz/kabul ediyoruz (Bilinen Sınırlamalar):**

- **(a) v0 tek-workspace/tek-kullanıcı PAT'tir — kurumlar-arası federasyon YOK.** Çift-taraflı denetim günlüğü, paylaşılan proje alanı kavramı F3-T14'e ertelendi.
- **(b) Token rotasyonu/yenileme mekanizması YOK.** Bir token ya geçerlidir ya iptal edilmiştir/süresi dolmuştur — "yakında yenile" gibi ara bir sinyal yok; kullanıcı süresi dolan bir token için panelden manuel olarak yeni bir token oluşturmalı.
- **(c) Nesne-tipi bazlı kapsam daraltma YOK.** Karar (g)'nin tek-kapsam modeli — gerçek bir kullanım ihtiyacı ortaya çıkarsa ayrı bir gelecek görev.
- **(d) Inbound oran sınırı varsayılanları outbound bağlayıcı limitlerinden AYNEN kopyalandı, inbound MCP trafik desenleri için bağımsız ayarlanmadı** — bu sabitler (`60`/dakika) ölçülmüş bir inbound-trafik verisine değil, mevcut outbound emsale dayanıyor; gerçek kullanım verisi toplandıkça ayrı bir ayar görevi gerekebilir.

---

**Sıradaki adım:** Bu ADR insan onayına sunulur — özellikle Karar (l) (süresiz seçeneğinin v0'da hiç sunulmaması) ve Karar (m)'nin (guard/wiring kod şekli) onaylanması gerekiyor. Onaylanırsa `test-writer` → `implementer` → `security-reviewer` ritüeline geçilir (spec'in önerdiği PR bölünmesi: PR1 auth+grant modeli+rate-limit servisi+minimal MCP wiring; PR2 token yönetimi UI'ı).
