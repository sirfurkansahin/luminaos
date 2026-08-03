# F1-T8 — Calendar + Timeline Görünümleri

**Epik:** F1-E2 · **Durum:** Tamamlandı
**Bağımlılık:** F1-T6, F1-T7 (aynı veri/etkileşim altyapısını paylaşır)

## Amaç

Tarih alanlarına dayalı iki görsel görünüm eklemek: aylık/haftalık takvim ve yatay zaman çizelgesi (basit Gantt öncüsü).

## Kapsam

1. **Calendar görünümü:** Ay/hafta modu; bir `date`/`datetime` tipi custom field'a göre nesneleri günlere yerleştirir (hangi alanın kullanılacağı görünüm ayarında seçilir); sürükle-bırak ile tarih değiştirme (`setFieldValues` tetikler).
2. **Timeline görünümü:** Yatay çubuklar, başlangıç+bitiş tarih alanı olan nesneler için tarih aralığını gösterir; yatay kaydırma ile zaman ekseninde gezinme.
3. **Her ikisi de F1-T6'nın sorgu katmanını** (tarih aralığı filtresiyle: yalnızca görünen ay/hafta aralığındaki nesneler çekilir — performans için tam liste değil).
4. **Bugün işareti** (calendar'da bugünün günü vurgulanır), **F1-T3'ün ilişkileri** ile bağlantılı nesneler arasında görsel bağlantı (opsiyonel, basit çizgi — karmaşık layout algoritması gerekmez).

## Kapsam DIŞI

- Sürükle-bırakta bağımlılık zincirinin otomatik kayması (Faz 2 — otomasyon işleri).
- Kaynak/kişi bazlı satır gruplaması (Workload görünümü, ayrı bir görev).

## Kabul Kriterleri

- [x] Calendar: bir nesnenin tarih alanı, doğru günde/hücrede görünür; sürükle-bırak ile tarih değişir ve API'ye yazılır (PR1, birim/component testleriyle kanıtlı — `CalendarView.test.tsx`, `dragEndUpdate.test.ts`). **Not:** gerçek tarayıcıda `claude-in-chrome` ile ayrıca doğrulanmadı.
- [x] Timeline: başlangıç/bitiş tarihli bir nesne doğru pozisyon ve genişlikte çubuk olarak render edilir (PR2, birim/component testleriyle kanıtlı — `timelineLayout.test.ts` [`computeBarLayout` saf-fonksiyon testleri, kırpma/clamp dahil], `TimelineView.test.tsx` [component seviyesinde çubuk pozisyonu (`left`/`width`) doğrulaması]).
- [x] Görünen tarih aralığı dışındaki nesneler sorguya dahil edilmez (performans testi — sorgu her ay/pencere değiştiğinde yeniden tetiklenir, tüm veri bir kerede çekilmez). Hem Calendar tarafı (`calendarQuery.test.ts`) hem Timeline tarafı (`timelineQuery.test.ts`) sorgunun aralık/pencere ile sınırlı olduğunu ve navigasyonda yeniden tetiklendiğini (queryKey aralığı/pencereyi içerir) doğruluyor.
- [x] Her iki görünüm de F0-T7 tema sistemiyle (light/dark) uyumlu render edilir. Calendar (`CalendarView.module.css`) ve Timeline (`TimelineView.module.css`) ikisi de token-only CSS Module (`var(--color-*)`/`var(--space-*)`), sabit renk/ölçü değeri yok.

## İlerleme Notu

- **PR1** (branch: `feature/f1-t8-pr1-calendar-view`, [#25](https://github.com/sirfurkansahin/luminaos/pull/25), main'e squash-merge edildi): Calendar görünümü — `apps/web/src/lib/dateMath.ts` (UTC-anchored ay/hafta ızgara matematiği, kütüphane eklenmeden), `dateFieldCandidates.ts` (tarih alanı tespiti — henüz kayıtlı görünüm ayarı olmadığından bootstrap sorgusuyla ilk sayfadan türetiliyor), `apps/web/src/views/calendar/calendarQuery.ts` (F1-T6'nın `between` operatörüyle yalnızca görünen aralığı sorgulama), `dragEndUpdate.ts` + `CalendarGrid`/`CalendarObjectChip`/`CalendarView` (Board'daki (F1-T7 PR3) per-drag optimistic override + per-call `onError` deseni tekrarlandı). `ViewSwitcher`/`useViewParam`/`App.tsx`'e Takvim sekmesi eklendi. **security-reviewer bulgusu (kapatıldı):** `computeVisibleRange`'in çıplak `throw new RangeError`'ı `packages/shared/errors`'ın `ValidationError`'ına çevrildi.
- **PR2** (branch: `feature/f1-t8-pr2-timeline-view-v2`, [#27](https://github.com/sirfurkansahin/luminaos/pull/27), main'e squash-merge edildi): Timeline görünümü — `apps/web/src/views/timeline/timelineQuery.ts` (gerçek tarih-aralığı overlap sorgusu; `before`/`after` operatörleri ±1 gün pad'lenerek kullanılıyor, çünkü tarih alanlarında `gte`/`lte` operatörü yok — **bilinen sınırlama:** `datetime` tipi alanlarda bu ±1 günlük pad, her sınırda ~24 saate kadar fazla-dahil etmeye yol açabilir; gün-altı hassasiyette kesin overlap için `DATE_OPERATORS`'ın genişletilmesi gerekir, bu görevin kapsamı dışında, F1-T6'ya dokunur), `timelineLayout.ts` (gün-ofsetinden piksele saf çubuk matematiği, uç kırpma/clamp dahil), `TimelineAxis`/`TimelineBar`/`TimelineView` (Prev/Next ile gezilen sabit 30 günlük pencere — **belgelenen yorum:** spec'teki "yatay kaydırma ile zaman ekseninde gezinme" burada sürekli kaydırma-tetiklemeli artımlı veri çekme yerine pencereli sayfalama (paging) olarak uygulandı; bu, ayrı ve daha büyük bir iş parçası olurdu. Çubuk canvas'ının kendisi yüklü pencere içinde CSS `overflow-x: auto` ile hâlâ yatay kaydırılabilir). `ViewSwitcher`/`useViewParam`/`App.tsx`'e "Zaman Çizelgesi" sekmesi eklendi. **security-reviewer:** bulgu yok.
  - **PR mekaniği notu:** Orijinal branch `feature/f1-t8-pr2-timeline-view` idi ve ilk PR'ı (#26), yığılı (stacked) base branch'i merge sonrası silindiğinde otomatik kapandı. Aynı commit main üzerine rebase edilip yeniden adlandırılan `feature/f1-t8-pr2-timeline-view-v2` branch'inden #27 olarak yeniden açıldı. Bu bir kapsam değişikliği değil, salt PR mekaniğidir.

## Bilinen Sınırlamalar / Takip

- İlişki bağlantı çizgileri (F1-T3'ün ilişkileriyle görsel bağlantı — opsiyonel, bu spec'in kabul kriterlerinde yer almıyor) PR1 kapsamı dışında bırakıldı.
- Tarih alanı/mod (ay/hafta) seçimi şu an yerel component state'inde tutuluyor, URL'e veya kalıcı bir görünüm ayarına senkron değil — F1-T9 (kayıtlı görünüm ayarları) tamamlanınca ele alınacak.
- **Timeline — `datetime` alanlarda ±1 gün pad'leme:** `timelineQuery.ts`'nin overlap sorgusu, `DATE_OPERATORS`'ta `gte`/`lte` olmadığı için `before`/`after`'ı ±1 gün pad'leyerek kullanıyor; `datetime` tipi alanlarda bu her sınırda ~24 saate kadar fazla-dahil etmeye yol açabilir. Gün-altı hassasiyette kesin overlap, `DATE_OPERATORS`'ın genişletilmesini gerektirir (F1-T6 kapsamı, bu görevde ele alınmadı).
- **Timeline — pencereli sayfalama vs. sürekli kaydırma:** Spec'teki "yatay kaydırma ile zaman ekseninde gezinme" ifadesi, sürekli kaydırma-tetiklemeli artımlı veri çekme yerine Prev/Next ile gezilen sabit 30 günlük pencere olarak yorumlanıp uygulandı; sürekli kaydırma ayrı, daha büyük bir iş parçası olur.
- Gerçek tarayıcıda `pnpm dev` + `claude-in-chrome` ile uçtan uca doğrulama hem Calendar hem Timeline için henüz yapılmadı — yalnızca birim/component test seviyesinde kanıtlı.
