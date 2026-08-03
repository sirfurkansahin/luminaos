# F1-T11 — Doküman Editörü (Blok Tabanlı, Katlanabilir Başlıklar, CRDT İşbirliği)

**Epik:** F1-E3 (Görev + Doküman + Takvim Çekirdeği) · **Durum:** Yapılacak
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

- [ ] ADR yazıldı ve insan onayı alındı (koddan ÖNCE).
- [ ] İki simüle istemci aynı dokümanı eşzamanlı düzenlediğinde (entegrasyon testi, iki Yjs istemcisi + WS gateway) patch'lerin kayıpsız birleştiği doğrulanır.
- [ ] Workspace/nesne erişimi olmayan kullanıcının WS odasına bağlanma denemesi reddedilir (401/403, testli).
- [ ] Sunucu yeniden başlatıldıktan sonra son snapshot'tan doküman içeriği kayıpsız yeniden kurulur (testli).
- [ ] Katlanabilir başlık aç/kapa durumu diğer istemciye senkron OLARAK YANSIMADIĞI testle kanıtlanır (bilinçli tasarım kararı).
- [ ] security-reviewer: WS bağlantı kimlik doğrulama akışı ve snapshot boyut sınırı (DoS önleme) denetlendi.
