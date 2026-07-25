# F1-T9 — Görünüm Kaydetme, Paylaşma ve İkonlama

**Epik:** F1-E2 · **Durum:** Yapılacak
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

- [ ] Bir görünüm (filtre+sıralama+tip ile) kaydedilip, sayfa yenilendikten sonra listeden seçilip aynı sonuçları gösterdiği doğrulanır.
- [ ] Kişisel bir görünüm başka bir kullanıcıya görünmez; paylaşılan görünüm tüm workspace üyelerine görünür (entegrasyon testli).
- [ ] Paylaşılan bir görünümü yalnızca admin+ silebilir/düzenleyebilir; member/guest deneyince 403 (testli).
- [ ] İkon seçimi kaydedilir ve listede doğru ikonla görünür.
