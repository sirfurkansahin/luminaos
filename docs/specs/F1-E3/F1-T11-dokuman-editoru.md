# F1-T11 — Doküman Editörü (Blok Tabanlı, Katlanabilir Başlıklar, CRDT İşbirliği)

**Epik:** F1-E3 (Görev + Doküman + Takvim Çekirdeği) · **Durum:** Tamamlandı (Kabul Kriterleri 6/6, otomatik testlerle kanıtlı; tam-UI iki-sekme görsel doğrulaması F0-T5 auth-wiring apps/web'e bağlanınca yapılacak — bkz. aşağıdaki "Kalan elle-adım")
**Bağımlılık:** F1-T1 (`doc` tipi), F0-T7 (tasarım sistemi), F0-T6 (event store)

> ⚠️ MİMARİ-KRİTİK GÖREV: Gerçek zamanlı CRDT işbirliği, "tek doğruluk kaynağı olay günlüğüdür" mimari değişmezine (CLAUDE.md) doğrudan dokunuyor — her tuş vuruşunu ayrı bir olay yapmak pratik değil. Bu görev, ADR yazılıp insan onayı alınmadan koda geçmez. Plan aşamasında en güçlü model kullanılmalı.

## Amaç

`doc` nesne tipi için blok tabanlı, katlanabilir başlıklı, gerçek zamanlı çoklu-kullanıcı düzenlemeye açık bir editör kurmak.

## Kapsam

1. **Blok şeması** (`packages/core-objects/src/doc` — saf tip tanımları): `Block { id(ULID), type: 'paragraph'|'heading1'|'heading2'|'heading3'|'bulletList'|'numberedList'|'todo'|'code'|'quote'|'divider', content: InlineRichText[], children: Block[] }`. Bu saf paket yalnızca tipleri ve değişmezleri (örn. `divider`'ın çocuğu olamaz) taşır; Yjs/React bağı burada YOK (domain paketleri framework import edemez kuralı).
2. **CRDT senkron katmanı** (`apps/server/src/docs` — framework'e bağlı, bilerek `apps/` altında): Doküman başına bir Yjs `Y.Doc`; blok ağacı `Y.XmlFragment` ile temsil edilir. `apps/server` bir WebSocket gateway (`DocCollabGateway`) sunar; istemciler arasında Yjs update'lerini ve awareness (imleç/presence) verisini iletir. Odaya katılım, F0-T5 RBAC kontrolünden geçer (workspace + nesne erişimi olmayan kullanıcı bağlanamaz).
3. **Kalıcılık köprüsü (mimari-kritik karar, ADR'de detaylandırılır):** Her tuş vuruşu değil, periyodik (10 sn hareketsizlik VEYA art arda N update) `DocumentContentSnapshotted { docId, snapshot: base64(Yjs update), version }` olayı event store'a yazılır. Ayrıca hafif bir denetim olayı `DocumentEdited { docId, actorId, at }` her oturum için bir kez üretilir (kimin ne zaman düzenlediğinin izlenebilirliği için — içerik detayı taşımaz). Sunucu yeniden başlarsa son snapshot + varsa sonrasındaki update log'undan doküman yeniden kurulur.
4. **Katlanabilir başlıklar:** `heading1/2/3` bloklarının açık/kapalı durumu paylaşılan CRDT belgesinin PARÇASI DEĞİLDİR — yalnızca istemci-yerel UI durumu (kullanıcı A'nın kapattığı başlık, kullanıcı B'nin ekranında etkilenmez).
5. **Editör UI** (`apps/web`, `packages/ui` bileşenleriyle): Blok render/düzenleme, sürükle-bırak blok yeniden sıralama, `/` komut menüsü (blok tipi ekleme), eşzamanlı imleç renkleri (awareness verisinden).
6. **ADR:** `architect` ile CRDT↔event-sourcing köprüsü (madde 3) ve blok şeması belgelenir, insan onayından önce uygulamaya geçilmez.

## Kapsam DIŞI

- Yorum sistemi (comments), sürüm geçmişi UI'ı (yalnızca veri modeli — snapshot geçmişi bu görevde saklanır ama gösterilmez).
- Çevrimdışı-öncelikli tam senkron/çakışma çözümü senaryoları (istemci SQLite + Yjs kalıcı depo entegrasyonu Faz 2/3'te).
- Doküman şablonları, dışa aktarım formatları (Markdown/PDF export — F1-T18 kapsamına yakın, ayrı ele alınır).

## Kabul Kriterleri

- [x] ADR yazıldı ve insan onayı alındı (koddan ÖNCE). — [ADR-0011](../../adr/ADR-0011-dokuman-crdt-koprusu.md), PR [#54](https://github.com/sirfurkansahin/luminaos/pull/54).
- [x] İki simüle istemci aynı dokümanı eşzamanlı düzenlediğinde (iki gerçek Yjs istemcisi + WS gateway) patch'lerin kayıpsız birleştiği doğrulanır. — PR4a entegrasyon testi (map + Y.Text eşzamanlı birleşme), PR [#58](https://github.com/sirfurkansahin/luminaos/pull/58).
- [x] Workspace/nesne erişimi olmayan kullanıcının WS odasına bağlanma denemesi reddedilir (401/403, testli). — PR4a: 401 (session), 403 (cross-workspace IDOR + CSWSH Origin), 404 (yok doc), 400 (eksik param), PR [#58](https://github.com/sirfurkansahin/luminaos/pull/58).
- [x] Sunucu yeniden başlatıldıktan sonra son snapshot'tan doküman içeriği kayıpsız yeniden kurulur (testli). — PR4b: graceful-restart (SIGTERM→senkron flush) kayıpsız; simüle-çökme yalnızca debounce penceresini kaybeder (AYRI test, ADR-0011 §c), PR [#59](https://github.com/sirfurkansahin/luminaos/pull/59).
- [x] Katlanabilir başlık aç/kapa durumu diğer istemciye senkron OLARAK YANSIMADIĞI (bilinçli tasarım kararı). — BlockNote toggle durumunu `window.localStorage`'da (`toggle-${block.id}`) tutar, paylaşılan `Y.Doc`'ta DEĞİL → istemci-yerel; kaynak incelemesiyle teyit, PR [#61](https://github.com/sirfurkansahin/luminaos/pull/61).
- [x] security-reviewer: WS bağlantı kimlik doğrulama akışı ve snapshot boyut sınırı (DoS önleme) denetlendi. — PR4a (auth/CSWSH/IDOR, 2 HIGH bulundu ve kapatıldı), PR4b (append-öncesi snapshot boyut tavanı + unhandled-rejection MEDIUM kapatıldı), PR6/PR7 frontend denetimleri temiz.

## İlerleme Notu (Tamamlandı)

Görev, ADR-0011 (mimari-kritik, insan onaylı) + 7 alt-PR ile gerçekleştirildi (plan: `precious-roaming-harbor`, tek onay tüm alt-PR'ları kapsadı):

- **ADR-0011** ([#54](https://github.com/sirfurkansahin/luminaos/pull/54)): CRDT↔olay-günlüğü köprüsü — periyodik TAM-durum snapshot'ları nesnenin kendi event stream'ine, yalnızca sunucu yazar; graceful shutdown senkron flush; RBAC çekirdeği WS için servise çıkarılır; ayrı `document_snapshots` tablosu.
- **PR1** ([#55](https://github.com/sirfurkansahin/luminaos/pull/55)): `packages/core-objects/src/doc` — saf `Block`/`InlineRichText` tipleri + `validateBlock` (divider değişmezi). _Mimari not:_ editör (BlockNote) içeriği runtime'da `Y.XmlFragment`'te tutulur ve snapshot'lar opak Yjs blob'u olduğu için bu saf şema editör tarafından runtime'da KULLANILMAZ — ileride export/sunucu-işleme için korunur (spec §1 domain ≠ §5 editör).
- **PR2** ([#56](https://github.com/sirfurkansahin/luminaos/pull/56)): `DocumentContentSnapshotted`/`DocumentEdited` zod şemaları (5MB decoded snapshot tavanı), `document_snapshots` tablosu + migration (down dahil), `DocumentSnapshotsProjection` (idempotent) + `DocumentReconstructionService`.
- **PR3** ([#57](https://github.com/sirfurkansahin/luminaos/pull/57)): `WorkspaceMembershipService.assertMembership` çıkarıldı (davranış-koruyan; 286-test regresyon ağı yeşil), guard ince sarmalayıcıya indi — WS gateway HTTP bağlamı dışında aynı RBAC'i çağırır.
- **PR4a** ([#58](https://github.com/sirfurkansahin/luminaos/pull/58)): `DocCollabGateway` — ham `ws` `WebSocketServer(noServer)` HTTP upgrade'e bağlanır; auth sırası Origin(CSWSH)→docId→session→doc'un workspace'ini `objects_view`'dan yetkili çöz→membership; oda başına `Y.Doc`, y-protocols sync + awareness. security-reviewer 2 HIGH (CSWSH + cross-workspace IDOR) bulup kapattı.
- **PR4b** ([#59](https://github.com/sirfurkansahin/luminaos/pull/59)): debounce'lu snapshot yazımı (append-öncesi doğrulama HIGH kontrolü), oturum başına `DocumentEdited`, SIGTERM senkron flush + boş-oda flush, DoS tavanları (503) + `maxPayload`. security-reviewer MEDIUM (unhandled-rejection) kapatıldı.
- **PR5:** ayrı `packages/ui` bileşeni GEREKMEDİ — editör motoru **BlockNote** seçildi (kullanıcı onayı), slash-menü/drag-drop/awareness hazır gelir (PR6'ya katlandı).
- **PR6** ([#60](https://github.com/sirfurkansahin/luminaos/pull/60)): `apps/web` BlockNote editörü + özel `DocGatewayProvider` (gateway'in `/ws/docs?docId=` protokolü, PR4a test istemcisiyle aynı), `withCollaboration` + `y-prosemirror` ile gerçek işbirliği aktivasyonu.
- **PR7** ([#61](https://github.com/sirfurkansahin/luminaos/pull/61)): `ObjectDetailHost` dispatcher (`doc`→`DocEditorPanel`, aksi→`TaskDetailPanel`), App.tsx entegrasyonu.

**Kalan elle-adım (F0-T5 auth-wiring'e bağımlı):** Tam-UI iki-sekme görsel doğrulama — `pnpm dev` + iki tarayıcı sekmesinde aynı dokümanı açıp gerçek-zamanlı birleşme + awareness imleçlerini görsel teyit — **F0-T5 (auth-wiring) apps/web'e bağlanınca yapılacaktır**. Şu an dev harness bunu desteklemiyor (apps/web'de login akışı yok, `DEV_WORKSPACE_ID` sahte sabit, Vite proxy yok). Bu bekleyen adım F0-T5'in "Sonraki İş" bölümüne de ileri-referansla işlendi (`docs/specs/F0-E2/F0-T5-veritabani-ve-auth.md`) ki auth wiring tamamlanınca unutulmasın. İşbirliğinin kendisi (kayıpsız birleşme + awareness) PR4a/4b entegrasyon testlerinde iki gerçek Yjs istemcisi + gerçek gateway ile zaten kanıtlı; bekleyen yalnızca uçtan-uca tarayıcı görsel teyidi. Frontend wiring birim-testli + build-doğrulanmış.

**İleriye-dönük (F1-T11 kapsamı dışı, planda kayıtlı):** `DocGatewayProvider` reconnect'ine exponential backoff; gerçek kullanıcı kimliği gelince awareness `user.name` XSS doğrulaması; `DocEditor`'ı `React.lazy` ile code-split (BlockNote ~1MB'ı başlangıç bundle'ından çıkarmak); sürüm geçmişi UI'ı (snapshot verisi saklanıyor, gösterilmiyor); çoklu-sunucu-örneği yatay ölçekleme (ADR-0011 §b bilinen sınırlama).
