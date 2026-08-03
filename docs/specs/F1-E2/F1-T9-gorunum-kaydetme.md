# F1-T9 — Görünüm Kaydetme, Paylaşma ve İkonlama

**Epik:** F1-E2 · **Durum:** Tamamlandı
**Bağımlılık:** F1-T6, F1-T7, F1-T8

## Amaç

Kullanıcıların bir sorgu+görünüm-tipi kombinasyonunu (örn. "Bu haftaki acil görevler — Board görünümü, öncelik=yüksek filtresiyle") kaydedip tekrar kullanabilmesini ve isteğe bağlı olarak ekiple paylaşabilmesini sağlamak.

## Kapsam

1. **SavedView modeli** (event-sourced, F1-T2/T3'teki `FieldDefinition`/`Relation` deseniyle aynı disiplin — kendi stream'i, `SavedViewCreated`/`SavedViewUpdated`/`SavedViewDeleted` olayları): `{ id(ULID), workspaceId, name, icon, viewType: 'list'|'board'|'table'|'calendar'|'timeline', querySpec: QuerySpec, ownerId: string|null, objectType }`. `ownerId: null` → paylaşılan (workspace-wide) görünüm; dolu → yalnızca o kullanıcıya özel kişisel görünüm.
2. **İkon seçimi:** F0-T7'de zaten mevcut olan `lucide-react` ikon setinden seçim yapan basit bir seçici bileşen.
3. **API:** CRUD uçları (`POST/GET/PATCH/DELETE /workspaces/:workspaceId/views`); kişisel görünümler yalnızca sahibine, paylaşılanlar tüm workspace üyelerine listelenir.
4. **UI entegrasyonu:** F1-T7'deki görünüm sekmelerinin yanına "Kaydedilmiş Görünümler" listesi eklenir; bir kaydedilmiş görünüme tıklamak F1-T6'nın `QuerySpec`'ini ve doğru görünüm tipini (List/Board/vb.) yükler.
5. **Yeniden adlandırma/silme:** Sahibi (kişisel) veya admin+ (paylaşılan) tarafından yapılabilir — F1-T2'nin admin+ şema-yönetimi izin desenine benzer.

## Kapsam DIŞI

- Görünümler arası sıralama/yeniden düzenleme (basit liste yeterli, drag-reorder ileride).
- Varsayılan görünüm ayarlama.

## Kabul Kriterleri

- [x] Bir görünüm (filtre+sıralama+tip ile) kaydedilip, sayfa yenilendikten sonra listeden seçilip aynı sonuçları gösterdiği doğrulanır. QuerySpec round-trip API katmanında (PR1 entegrasyon testleri) ve component katmanında (`SavedViewsList`/`apiClient` testleri, PR2) kanıtlı. **Not:** gerçek tarayıcıda `pnpm dev` + `claude-in-chrome` ile kaydetme/yenileme/yeniden-seçme uçtan uca doğrulanmadı (bkz. Bilinen Sınırlamalar).
- [x] Kişisel bir görünüm başka bir kullanıcıya görünmez; paylaşılan görünüm tüm workspace üyelerine görünür (entegrasyon testli — PR1'in rol×sahiplik matrisi, 20 Testcontainers entegrasyon testi).
- [x] Paylaşılan bir görünümü yalnızca admin+ silebilir/düzenleyebilir; member/guest deneyince 403 (testli — aynı rol×sahiplik matrisi; kişisel görünümlerde sahiplik rol-rütbesinin önüne geçer, bu inceliği de kapsıyor).
- [x] İkon seçimi kaydedilir ve listede doğru ikonla görünür (`IconPicker`'ın `resolveIcon` testleri + backend'in opak-string round-trip'i, PR1+PR2).

## İlerleme Notu

- **PR1** (branch: `feature/f1-t9-pr1-saved-views-backend`, [#30](https://github.com/sirfurkansahin/luminaos/pull/30), main'e squash-merge edildi): `packages/core-objects/src/saved-views/` — saf `createSavedView`/`updateSavedView`/`deleteSavedView` komutları + `replaySavedView`, F1-T2/F1-T3'ün event-sourced varlık şablonu birebir izlenerek (kendi stream'i, `SavedViewCreated`/`SavedViewUpdated`/`SavedViewDeleted` olayları); viewType↔alan-seçimi değişmezi domain katmanında zorlanıyor (calendar yalnızca `dateField`, timeline yalnızca `startField`+`endField`, list/board/table hiçbiri gerektirmez). `apps/server/src/saved-views/` — CRUD API (`POST/GET/PATCH/DELETE /workspaces/:workspaceId/views`), `field_definitions`'ın desenini yansıtan `lifecycle` kolonuyla soft-delete, migration `0010_wet_toxin` + eşleşen down script. **Bu görevin gerçekten yeni tasarım parçası** (mevcut bir desenin kopyası değil): sahiplik-ya-da-rol izin dalı — kişisel görünümler (`ownerId` dolu) yalnızca kendi sahibi tarafından değiştirilebilir (workspace admin'i bile geçersiz kılamaz), paylaşılan görünümler (`ownerId: null`) yalnızca admin+ tarafından değiştirilebilir. Planlama sırasında insan onayıyla alınan iki karar: (a) paylaşılan görünüm oluşturmak admin+ gerektirir (kişisel görünüm oluşturma her üyeye açık kalır), (b) istemci `ownerId`'yi doğrudan asla sağlayamaz (yalnızca `shared: boolean`; sahiplik her zaman sunucu tarafından oturumdan türetilir). 630 domain birim testi + 98 server birim testi + 20 gerçek-Postgres/Redis entegrasyon testi (Testcontainers), rol×sahiplik matrisinin tamamını kapsıyor. **security-reviewer:** bulgu yok (bir eski doc-comment düzeltildi).
- **PR2** (branch: `feature/f1-t9-pr2-saved-views-frontend`, [#31](https://github.com/sirfurkansahin/luminaos/pull/31), main'e squash-merge edildi): `apiClient.ts`'e ekler (`getSavedViews`/`createSavedView`/`updateSavedView`/`deleteSavedView`), `useSavedViewsQuery.ts` (query + create/update/delete mutation'ları), `IconPicker.tsx` (yeni `lucide-react` bağımlılığı — **not:** spec'in "F0-T7'den zaten mevcut" iddiası hatalıydı, F0-T7 bu bağımlılığı hiç eklememişti; ~30 ikonluk küratörlü bir seçici sıfırdan oluşturuldu), `SavedViewsList.tsx` (kişisel+paylaşılan görünümleri render eder, tıklama querySpec/viewType'ı yükler), `SaveViewButton.tsx` (mevcut görünümü kaydetme diyaloğu — isim/ikon/paylaş-checkbox'ı). `CalendarView`/`TimelineView`'a `initialDateField`/`initialStartField`/`initialEndField` prop'ları (kaydedilmiş bir görünümün alan seçimini geri yükler — F1-T9-planlama kararı gereği, kaydedilmiş Calendar/Timeline görünümleri yalnızca hangi tarih alanı/alanlarının seçildiğini kalıcı tutar, donmuş bir tarih aralığını değil, çünkü bu görünümlerin bütün amacı canlı ay/pencere navigasyonudur) **ve** `onDateFieldChange`/`onStartFieldChange`/`onEndFieldChange` callback prop'ları eklendi (görünüm içindeki canlı alan seçimini `App.tsx`'e yukarı taşır, böylece "mevcut görünümü kaydet" ekranda gerçekten görünen şeyi yakalar, kullanıcının yeniden yazması gereken bir değeri değil — bu callback bağlantısı implementer'ın ilk geçişinde eksikti ve PR2 açılmadan önce doğrudan düzeltme olarak eklendi, çünkü plan'ın kendi belirttiği amacın merkezindeydi, kapsam kayması değil). 226 frontend testi, typecheck/lint temiz. **security-reviewer:** iki düşük-önem bulgusu — (1) `App.tsx`'teki `matchingSavedView`, yalnızca `viewType`/`objectType` kontrol ediyordu, `savedView.workspaceId`'yi kontrol etmiyordu — doğrudan düzeltildi (derinlemesine-savunma; bugün `DEV_WORKSPACE_ID` tek bir sabit sağladığından zararsız, ama F0-T5'in workspace-switcher'ı geldiğinde önem kazanacak); (2) `selectingSavedViewRef`, kullanıcı şu an aktif olan sekmeyle aynı `viewType`'a sahip bir kayıtlı görünüm seçtiğinde "takılı" true kalabiliyor, `activeSavedView`'in temizlenmesini bir sonraki manuel sekme değişimine erteliyor — istismar edilemez olduğu doğrulandı (izlendi: `matchingSavedView` her okumada `viewType`/`objectType`/`workspaceId`'yi zaten yeniden kontrol ediyor, dolayısıyla hiçbir uyumsuz querySpec/dateField sızmıyor), kozmetik/güvenlik-dışı bir zamanlama tuhaflığı olduğundan düzeltilmeden bilinen küçük bir UX kenar durumu olarak bırakıldı.

## Bilinen Sınırlamalar / Takip

- `App.tsx`'teki `canManageSavedView()` her zaman `false` döner (tüm yeniden adlandırma/silme UI'ını gizler) — `apps/web`'de henüz oturum-açmış-kullanıcı/rol kavramı bağlanmadığından; gerçek yetkilendirme her durumda backend'in 403'üne dayanır, dolayısıyla bu bir UI-nezaket eksiği, güvenlik açığı değil. F0-T5'in auth'u istemci tarafında geldiğinde yeniden ele alınacak.
- `selectingSavedViewRef`'in PR2 security-review'ünde tarif edilen UX kenar durumu (yukarıda açıklandı) — düzeltilmeden bırakıldı.
- Gerçek tarayıcıda `pnpm dev` + `claude-in-chrome` ile çok-kullanıcılı uçtan uca doğrulama henüz yapılmadı — F1-T7/F1-T8 ile aynı bilinen boşluk deseni; `apps/web`'e henüz bağlanmamış gerçek bir workspace/auth kurulumu gerektiriyor (`DEV_WORKSPACE_ID` hâlâ sabit bir dev sabiti).
- Görünümler arası sıralama/varsayılan görünüm ayarlama zaten Kapsam DIŞI (spec'in kendi metninde).
