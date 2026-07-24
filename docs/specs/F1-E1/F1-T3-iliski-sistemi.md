# F1-T3 — İlişki Sistemi

**Epik:** F1-E1 · **Durum:** Tamamlandı
**Bağımlılık:** F1-T1

## Amaç

Nesneler arası üç ilişki türünü kurmak: ebeveyn-çocuk (alt görevler), referans (bağlantılı nesneler) ve bağımlılık (blocks/blocked-by) — çift yönlü tutarlılık garantisiyle.

## Kapsam

1. **Model:** `Relation { id, workspaceId, fromId, toId, kind: parentChild | reference | dependency }`. Olaylar: `RelationCreated`, `RelationRemoved`. Tek olay, iki yönü de temsil eder (ters yön projeksiyonda türetilir — çift kayıt YOK).
2. **Kurallar:**
   - parentChild: bir nesnenin en fazla 1 ebeveyni; kendi kendine/soyuna ebeveynlik reddi (döngü tespiti).
   - dependency: döngü reddi (A→B→C→A engellenir, hata döngüdeki zinciri raporlar).
   - reference: serbest; aynı çiftte aynı türden tekrar reddi (idempotent).
3. **Soft-delete etkileşimi:** nesne soft-delete olunca ilişkileri "askıya alınır" (projeksiyonda süzülür), restore'da geri gelir; purge tasarımında kalıcı temizlik notu düşülür.
4. **API + projeksiyon:** ilişki ekle/kaldır uçları; `getRelated(objectId)` tek çağrıda üç türü gruplu döner; alt görev sayısı/tamamlanma özeti projeksiyonu.

## Kapsam DIŞI

- İlişkiye göre görünüm gruplaması (F1-T6 sorgu katmanında).
- Otomatik zamanlama kaydırması (bağımlılık zinciri — Faz 2 takvim işlerinde).

## Kabul Kriterleri

- [x] Döngü senaryoları: kendine ebeveyn, torununa ebeveyn, 3'lü bağımlılık döngüsü → hepsi tanımlı hatayla reddedilir (testli).
- [x] 1000 nesnelik zincirde döngü tespiti < 50ms (performans testi).
- [x] Soft-delete → getRelated'dan düşer; restore → geri gelir (testli).
- [x] Replay determinizmi: ilişki olayları hangi sırayla gelirse gelsin projeksiyon aynı sonucu verir.

## Tamamlanma Notu

Dört commit halinde uygulandı (branch: `feature/f1-t3-iliski-sistemi`), `docs/adr/ADR-0006-iliski-sistemi.md`'de belgelendi:

- **PR-A** (`packages/core-objects/src/relations/`, saf domain): `Relation` +
  `createRelation/removeRelation` + `replayRelation`; `createRelation` merkezi
  mimari kararı — kendi geçmişi yerine workspace'in aynı-türden diğer aktif
  ilişkilerini parametre olarak alır (global graf doğrulaması: tekil-ebeveyn,
  döngü tespiti, yönsüz-çift referans tekrarı). `relation-graph.ts`'teki
  `findParentCycle`/`findDependencyCycle` saf, O(V+E) algoritmalar; 1000
  düğümlü zincirde <50ms performans testiyle kanıtlandı. 308 test (core-objects
  toplamı), ≥%95 kapsam.
- **PR-B** (`apps/server/src/relations/`, CRUD): `RelationsService`/
  `RelationsController` (`/workspaces/:workspaceId/relations`), rol kısıtı
  yok (herhangi bir workspace üyesi). 22 entegrasyon testi (Testcontainers).
- **PR-C** (`getRelated` + soft-delete etkileşimi): `GET .../relations/object/:objectId`
  üç türü gruplu döner; karşı-uçtaki nesne soft-delete olunca ilgili ilişki
  sorgu-anında JOIN filtresiyle süzülür, restore'da otomatik geri gelir.
  Replay determinizmi `ProjectionRunner.rebuild()` ile kanıtlandı. 11 yeni
  entegrasyon testi.
- **security-reviewer bulgusu ve düzeltmesi:** parentChild "tek aktif ebeveyn"
  kuralının DB seviyesinde hiçbir kısıtı olmadığı (iki eşzamanlı `create()`
  çağrısı ikisi de bellek-içi ön-kontrolü geçebilirdi) tespit edildi. Partial
  unique index (`relations_view_active_parent_key`) + projeksiyonda
  `onConflictDoNothing` + serviste post-catchUp varlık kontrolü ile kapatıldı
  (ADR-0005'in "poison pill" deseninin ikinci uygulanışı). `reference`'ın
  yönsüz-çift kuralı ve `dependency`'nin döngü-serbestliği için eşdeğer bir DB
  kısıtı bilinçli olarak ertelendi (ADR-0006'da gerekçeli).

Toplam 108 entegrasyon testi (Testcontainers, gerçek Postgres+Redis+HTTP,
tüm sunucu paketi) yeşil.
