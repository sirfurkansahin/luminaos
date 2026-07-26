# F1-T7 — List + Board + Table Görünümleri (İlk Gerçek Arayüz)

**Epik:** F1-E2 · **Durum:** Devam Ediyor (PR1-2/3 tamamlandı)
**Bağımlılık:** F1-T6 (sorgu katmanı), F0-T7 (tasarım sistemi)

> 📌 ÖNEMLİ MİLESTONE: Bu görev, projenin başlangıcından beri backend'de inşa edilen her şeyin (event sourcing, custom fields, ilişkiler, formüller) **ilk kez tarayıcıda görülebilir hale geldiği** görevdir. Plan onaylanırken özellikle "kullanıcı bunu nasıl görecek/deneyimleyecek" açısından dikkatle okunmalı.

## Amaç

`apps/web`'de F1-T6'nın sorgu katmanını tüketen üç temel görünümü (List, Board/Kanban, Table) kurmak — F0-T7'nin tasarım sistemi bileşenleri üzerine inşa edilerek.

## Kapsam

1. **Veri katmanı:** TanStack Query ile F1-T6'nın `/objects/query` ucunu çağıran bir `useObjectsQuery(workspaceId, querySpec)` hook'u; cache invalidation (bir nesne değişince ilgili sorgular yenilenir).
2. **List görünümü:** Satır bazlı, sanallaştırılmış (10.000 satırda akıcı kaydırma — `@tanstack/react-virtual` veya benzeri); her satır başlık + birkaç öne çıkan custom field gösterir.
3. **Board (Kanban) görünümü:** `select` tipi bir alana göre gruplanmış sütunlar (F1-T6'nın `group` özelliğini kullanır); sürükle-bırak ile kart taşıma, bu bir `setFieldValues` API çağrısı tetikler (F1-T2).
4. **Table görünümü:** Çoklu sütun (her custom field bir sütun olabilir), satır içi düzenleme (F0-T7'nin Input/Select bileşenleri kullanılarak), sütun genişliği ayarlanabilir.
5. **Ortak durumlar:** Boş durum ("henüz nesne yok, oluştur"), yükleniyor durumu (skeleton), hata durumu (F0-T8'in ErrorBoundary'siyle uyumlu).
6. **Görünüm geçişi:** Aynı ekranda List/Board/Table arasında sekme ile geçiş (görünüm State'i şimdilik URL query param'da, kalıcı kayıt F1-T9'da).
7. **Nesne oluşturma:** Her görünümden "+ Yeni" butonu ile hızlı nesne oluşturma (F1-T1 API'sini çağırır).

## Kapsam DIŞI

- Calendar/Timeline (F1-T8).
- Kaydedilmiş/paylaşılan görünümler (F1-T9).
- Gelişmiş filtre arayüzü (görsel filtre kurucu) — v0'da basit bir filtre paneli yeterli, gelişmiş UI ileride.

## Kabul Kriterleri

- [ ] `pnpm dev` ile açılan tarayıcıda gerçek bir workspace'te List/Board/Table görünümleri arasında geçiş yapılabilir.
- [ ] 10.000 satırlık test verisinde List görünümü sanallaştırma sayesinde akıcı kaydırma sağlar (performans testi/ölçümü).
- [ ] Board görünümünde bir kartı sürükleyip başka sütuna bırakmak, alanın değerini gerçekten değiştirir (entegrasyon/E2E testi — Playwright).
- [x] Table görünümünde bir hücreyi düzenlemek API'ye yazar ve optimistic UI güncellemesi çalışır (PR2, testli — onMutate/onError optimistic+rollback).
- [ ] Her üç görünüm de klavye erişilebilir (F0-T7'nin a11y standardına uyar).
- [ ] Boş/yükleniyor/hata durumları her görünümde doğru render edilir (testli).

## İlerleme Notu

Plan onayı: görev 3 PR'a bölündü (PR1 veri+List, PR2 Table, PR3 Board) — her biri kendi test-writer → implementer → security-reviewer turunu aldı.

- **PR1** (branch: `feature/f1-t7-pr1-list-view`, [#15](https://github.com/sirfurkansahin/luminaos/pull/15), main'e squash-merge edildi): veri katmanı (`apiClient`, `useObjectsQuery`/`useSetFieldValuesMutation`, `useViewParam`), sanallaştırılmış List görünümü, `ViewSwitcher` sekme iskeleti, `CreateObjectButton`, `packages/ui`'ye `Skeleton`/`EmptyState` eklendi. Ayrıca plan onayı sırasında eklenen kapsam: `apps/server`'a origin-allowlist'li CORS middleware'i (`WEB_ORIGIN` env, credentials'lı cross-origin istekler için gerekliydi, önceden hiç CORS yapılandırması yoktu).
- **PR2** (branch: `feature/f1-t7-pr2-table-editing`, [#18](https://github.com/sirfurkansahin/luminaos/pull/18), main'e squash-merge edildi): Çoklu sütun `TableView`, satır içi düzenleme (`EditableCell` — tıkla/Enter ile düzenle, Enter/blur commit, Escape iptal), ok tuşlarıyla hücreler arası klavye navigasyonu (`role="grid"`), `useColumnWidths`. `useSetFieldValuesMutation`'a (PR1) optimistic update eklendi (`onMutate`/`onError`). **security-reviewer bulgusu (kapatıldı):** ilk implementasyon `onError`'da tüm sorgu snapshot'ını geri alıyordu — aynı nesnenin farklı alanlarında art arda hızlı iki düzenleme yapılırsa (ör. önce `status` sonra `priority`), ilk mutation başarısız olunca ikincinin optimistic yazımı da yanlışlıkla siliniyordu (race condition). Düzeltme: rollback artık yalnızca o mutation'ın değiştirdiği alanları geri alıyor.
- **PR3** (Board görünümü, sürükle-bırak, `@dnd-kit`): henüz başlanmadı.
