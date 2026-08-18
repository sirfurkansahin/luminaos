# F2-T6 — "Hakkımda Ne Biliyorsun?" Ekranı + Kaynak İzi

**Epik:** F2-E2 (Memory Passport) · **Durum:** Tamamlandı — PR #136.
**Bağımlılık:** F2-T5 (Memory Passport backend'i — `apps/server/src/memory/`, `packages/memory`, ADR-0022; merged), `apps/web`'in TanStack Query + `apiClient.ts` deseni (en yakın emsal: `useSavedViewsQuery.ts` + `SavedViewsList.tsx`), `@luminaos/ui`'nin `DialogRoot`/`DialogContent` bileşenleri (en yakın emsal: `CommandPalette.tsx`).

## Amaç

Kullanıcının, LuminaOS'in kendisi hakkında "bildiği" her bellek kaydını (F2-T5'in kurduğu Memory Passport API'si) kendi başına görebileceği, düzenleyebileceği ve silebileceği bir `apps/web` ekranı/paneli kurmak — her kayıt için ne zaman ve nasıl (elle) oluşturulduğunu gösteren bir "kaynak izi" ile birlikte. Bu görev F2-T5'in depolama/CRUD altyapısını ilk kez bir kullanıcı arayüzüne bağlar; F2-T7 (içe/dışa aktarım) ve F2-T8 (ajan erişim politikaları) bu ekranın üzerine değil, F2-T5'in API'si üzerine ayrı ayrı inşa edilecek.

## Mevcut Durum

- **F2-T5 API'si hazır ve merge edilmiş durumda** (`apps/server/src/memory/memory-records.controller.ts`): `@Controller('workspaces/:workspaceId/memory')`, guard'lar `SessionAuthGuard` + `WorkspaceMembershipGuard`. Rotalar: `GET /` → `{records: MemoryRecord[]}` (tombstone'lu kayıtlar zaten filtrelenmiş döner); `POST /` gövde `{content: string}` → `{record}`; `PATCH /:id` gövde `{content: string}` → `{record}`; `DELETE /:id` → `{}`. Kimlik her zaman `req.user.id`'den, gövdeden asla.
- **`MemoryRecord` tipi** (`packages/memory/src/memory-record.ts`): `{id, workspaceId, userId, content, kaynakOlayId, createdAt: Date, updatedAt: Date, deletedAt: Date | null}`.
- **`kaynakOlayId` v1'de her zaman kendine-referans** (ADR-0022 Karar b): kaydı yaratan `MemoryRecordAdded` olayının kendi id'sine eşit, `createdAt` ile aynı ana denk gelir. Otomatik AI çıkarımı henüz yok, dolayısıyla "hangi konuşmadan öğrenildi" gibi zengin bir kaynak izi bu görevde ANLAMSIZ — gösterilebilecek tek gerçek bilgi "ne zaman, kullanıcı tarafından elle eklendi".
- **Olay detayına REST erişimi YOK.** `EventStoreService.readStream`/`readByWorkspace`/`readAllFrom` (`apps/server/src/event-store/event-store.service.ts`) yalnızca sunucu-içi servis metotları; hiçbir `event*.controller.ts` yok (grep sıfır sonuç). Bu görev yeni bir olay-detay endpoint'i KURMAZ — kaynak izi tamamen `MemoryRecord`'ın zaten döndürdüğü `createdAt`/`kaynakOlayId` alanlarından türetilir.
- **`apps/web` mimarisi:** React + TanStack Query, router YOK (tek sayfa uygulama). Navigasyon `useViewParam.ts`'in `?view=` URL parametresiyle yönetiliyor, ama bu parametre `ViewKind = 'list'|'board'|'table'|'calendar'|'timeline'` ile SINIRLI — nesne-listesi görünüm modlarına özel, genel-amaçlı bir sayfa/ayarlar navigasyonu değil.
- **En yakın "kullanıcı kendi kaydını CRUD'lar" UI emsali — `useSavedViewsQuery.ts` + `SavedViewsList.tsx`:** hook'lar (`useXQuery`/`useXMutation`) `apiClient.ts`'teki `request<T>()` sarmalayıcısına (session cookie `credentials:'include'` ile) delege eder; mutation'lar `onSuccess`'te `queryClient.invalidateQueries(['savedViews', workspaceId])` çağırır; bileşen `isLoading`/`isError`/boş-liste durumlarını `@luminaos/ui`'nin `EmptyState`/`Skeleton` bileşenleriyle ele alır.
- **En yakın "kendi kendini açıp kapayan panel" UI emsali — `CommandPalette.tsx`:** `@luminaos/ui`'nin `DialogRoot`/`DialogContent`/`DialogTitle` bileşenleri + yerel `useState(false)` ile açık/kapalı durumu, `App.tsx`'te her zaman monte edilmiş halde bulunur. `AvailabilitySelector`/`CommandPalette` gibi header bileşenleri bu deseni izler.
- **`apps/server/src/context/desktop-signal-consents.controller.ts` (F2-T3) için hiçbir `apps/web` ekranı YOK** — grep sıfır sonuç. Bu görev, self-service/consent-tarzı bir controller'ı tüketen İLK `apps/web` ekranı olacak, dolayısıyla "böyle bir ekran nereden açılır" için repoda hazır bir navigasyon/giriş-noktası deseni yok.
- **[ÖNEMLİ ÇELİŞKİ] i18n kataloğu repoda HİÇ YOK.** CLAUDE.md: "UI metinleri i18n kataloğundan gelir; koda gömülü kullanıcı metni yasak." Ama `SavedViewsList.tsx` dahil mevcut HER ekran Türkçe metni doğrudan JSX içine gömüyor (`"Bir hata oluştu"`, `"Kaydedilmiş görünüm yok"` vb.) — repo genelinde `apps/web/src` içinde bir i18n kataloğu/hook'u (`useTranslation`, `t()` vb.) grep'te sıfır sonuç veriyor. Bu görev bu çelişkiyi miras alıyor, çözmüyor (bkz. Açık Soru 1).
- **`App.tsx`'te workspaceId hâlâ `DEV_WORKSPACE_ID` sabiti** — gerçek workspace seçimi/çoklu-workspace UI'ı henüz yok, bu görevin kapsamı dışında, mevcut desen izlenir.

## Kapsam

1. **"Hakkımda ne biliyorsun?" paneli:** `CommandPalette.tsx`'in `DialogRoot`/`DialogContent` deseniyle, `App.tsx`'te her zaman monte edilmiş, yerel `useState` ile açık/kapalı, header'daki bir düğmeyle (örn. kullanıcı menüsü) tetiklenir (bkz. Açık Soru 2).
2. **Listeleme:** `GET /workspaces/:workspaceId/memory` üzerinden kullanıcının kendi (tombstone hariç, backend zaten filtreliyor) kayıtları; `useMemoryRecordsQuery` hook'u `useSavedViewsQuery.ts` deseniyle (`apiClient.ts`'e `getMemoryRecords` fonksiyonu eklenir).
3. **Düzenleme:** `PATCH /workspaces/:workspaceId/memory/:id` ile `content` güncelleme (satır-içi düzenleme veya küçük bir form) — `apiClient.ts`'e `updateMemoryRecord` eklenir.
4. **Silme:** `DELETE /workspaces/:workspaceId/memory/:id`, başarılı silme sonrası `invalidateQueries` ile kayıt listeden kalkar — `apiClient.ts`'e `deleteMemoryRecord` eklenir.
5. **Yeni kayıt ekleme (bkz. Açık Soru 3):** `POST /workspaces/:workspaceId/memory` — dahil edilirse `apiClient.ts`'e `createMemoryRecord` eklenir.
6. **Kaynak izi:** her kayıt satırında `createdAt` (ve "elle eklendi" sabit etiketi) gösterimi — yeni bir backend endpoint'i KURULMAZ (Mevcut Durum'da açıklandığı gibi, `kaynakOlayId`'nin kendisi v1'de kullanıcıya gösterilecek ek bir bilgi taşımıyor).
7. **Boş durum + hata durumu:** `EmptyState`/`Skeleton` ile, `SavedViewsList.tsx`'in aynı deseni.
8. **Component testleri:** `SavedViewsList.test.tsx` deseniyle co-located `.test.tsx`, en azından listeleme/düzenleme/silme/boş-durum/hata-durum senaryoları.

## Kapsam Dışı

- **i18n kataloğunun inşası** — bu görev CLAUDE.md'nin i18n kuralını hayata geçirmez, mevcut (kuralla çelişen) hardcoded-Türkçe desenini izler (bkz. Açık Soru 1). Kataloğun gerçek kurulumu ayrı bir mimari karar/görev.
- **Zengin kaynak izi / event detay görüntüleme** — `kaynakOlayId` otomatik AI çıkarımıyla anlam kazanana kadar (Faz 3+), bu alanın kendisi UI'da ayrıştırılmaz; yalnızca `createdAt` gösterilir.
- **F2-T7** (içe/dışa aktarım sihirbazı, JSON-LD şema) — ayrı görev.
- **F2-T8** (ajanın hangi bellek segmentine erişebileceği UI'ı) — ayrı görev.
- **Workspace seçimi / çoklu-workspace UI'ı** — mevcut `DEV_WORKSPACE_ID` deseni izlenir.
- **`apps/desktop`/`apps/mobile` için ayrı bir ekran** — yalnızca `apps/web` kapsamında.

## Açık Sorular

1. **i18n:** Mevcut (CLAUDE.md ile çelişen) hardcoded-Türkçe desen mi izlenecek, yoksa bu görev CLAUDE.md'nin i18n kataloğu kuralını ilk kez mi hayata geçirecek?
   - **Öneri:** Mevcut deseni izle (hardcode). Repo genelinde 10+ ekran zaten bu kurala uymuyor; F2-T6'nın tek başına farklı bir standart kurması hem tutarsızlık yaratır hem de gerçek bir i18n altyapısı (kütüphane seçimi, dosya yapısı, extraction tooling) kendi başına bir mimari karar/görev gerektirir — bu görevin kapsamına sığmaz. İnsan onayı gerekiyor çünkü bu, CLAUDE.md'den BİLİNÇLİ bir sapma.
2. **Panel nasıl açılır?**
   - **Öneri:** `CommandPalette.tsx` deseni — `App.tsx`'te her zaman monte edilmiş bir `DialogRoot`/`DialogContent`, header'da bir "Hakkımda ne biliyorsun?" düğmesiyle açılır. `?view=` `ViewKind` param'ına EKLENMEZ (o nesne-listesi görünüm modlarına özel bir tip, genel navigasyon değil — oraya eklemek anlamsal karışıklık yaratır).
3. **Yeni kayıt ekleme bu ekrandan yapılabilecek mi?**
   - **Öneri:** Evet, dahil edilsin. F2-T5'in `POST` endpoint'i self-service CRUD API'sinin bir parçası; bu görev "kendi belleğini yönet" ekranını kurarken `create`'i dışarıda bırakmak, hiçbir UI'dan hiç erişilemeyen bir endpoint'e yol açar. Küçük bir ek (tek bir metin girişi + gönder düğmesi).
4. **Kaynak izi v1'de tam olarak ne gösterecek?**
   - **Öneri:** Yalnızca `createdAt` (ör. "12 Ağustos 2026'da elle eklendi"). `kaynakOlayId`'nin ham UUID değeri kullanıcıya hiç gösterilmez (anlamsız); yeni bir event-detay endpoint'i bu görevde kurulmaz.

## Kabul Kriterleri

- [x] Açık Soru 1-4'ün insan kararları bu plan onayı sırasında alındı.
- [x] Kullanıcı kendi memory passport kayıtlarını (tombstone hariç) panelde görebiliyor, testli.
- [x] Kayıt düzenleme (`PATCH`) çalışıyor, testli.
- [x] Kayıt silme (`DELETE`) çalışıyor ve silinen kayıt listeden kalkıyor, testli.
- [x] Yeni kayıt ekleme çalışıyor, testli (Açık Soru 3 kararı: dahil edildi).
- [x] Her kayıt satırında en azından `createdAt` tabanlı bir kaynak izi gösteriliyor.
- [x] Boş durum ve hata durumu `EmptyState` ile ele alınıyor, testli.
- [x] UI hiçbir zaman `userId`/`workspaceId`'yi istek gövdesinde göndermiyor — `security-reviewer` tarafından doğrulandı, bulgu yok.
- [x] `pnpm --filter @luminaos/web typecheck && lint && test` yeşil (455/455 test, 67'si yeni; regresyon yok).

---

**Sıradaki adım:** F2-T6 kapandı (PR #136). F2-E2'nin bir sonraki görevi F2-T7 ("İçe/dışa aktarım: açık şema (JSON-LD) + ChatGPT/Claude bellek içe aktarma sihirbazı", `docs/PLAN.md` satır 250). F2-T7'nin henüz bir spec dosyası yok — önce spec yazılmalı:

```
docs/specs/F2-E2/F2-T7-ice-disa-aktarim.md spec dosyasını yaz, sonra Plan Mode ile F2-T7'yi planla.
```
