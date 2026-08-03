# F1-T13 — Global Arama (Tam Metin + Vektör; Komut Paleti)

**Epik:** F1-E3 (Görev + Doküman + Takvim Çekirdeği) · **Durum:** Yapılacak
**Bağımlılık:** F1-T1 (varlık çekirdeği), F1-T5 (ai-gateway deseni), F1-T11 (doküman içeriği), F0-T5 (RBAC), F0-T7 (tasarım sistemi)

## Amaç

Nesne başlığı ve doküman içeriğinde hem anahtar kelime hem de anlamsal (semantic) arama; komut paleti (Cmd/Ctrl+K) içinde sunulur.

## Kapsam

1. **`object_search_index` projeksiyonu** (F0-T6 projeksiyon çatısı kullanılır): `{ objectId, workspaceId, tsvector, embedding: vector, updatedAt }`. Kaynak: nesne `title` + `doc` tipi için F1-T11'deki blok ağacından türetilmiş düz metin. **v1'de Custom Field metin değerleri indexlenmez** (bilinçli kapsam sınırlaması, bkz. Kapsam Dışı).
2. **Embedding üretimi yalnızca `ai-gateway` üzerinden** (F1-T5 desenine uyar — sağlayıcı SDK'sı doğrudan import edilmez). İçerik değiştikten sonra debounce'lu (5 sn, F1-T5'teki `AIRefreshScheduler` deseninin genellenmiş hâli) yeniden hesaplama.
3. **Hibrit sıralama:** Anahtar kelime skoru (`ts_rank`) birincil sıralama kriteri; anlamsal (cosine similarity) skor ikincil re-rank için kullanılır. Ağırlıklar sabit config değeridir (ileride ayarlanabilir).
4. **API:** `POST /workspaces/:workspaceId/search { query, limit }`. **Güvenlik kuralı:** RBAC süzgeci sorgu SIRASINDA uygulanır (post-filter değil) — erişimi olmayan bir nesnenin varlığı sonuç sayısı veya zamanlamayla bile sızdırılmaz.
5. **Komut paleti UI** (`packages/ui` bileşenleri, `apps/web`): Cmd/Ctrl+K ile açılır, 250ms debounce, sonuçlar tipe göre gruplanır (Görevler/Dokümanlar/Notlar), klavye navigasyonu (yukarı/aşağı/enter).

## Kapsam DIŞI

- Custom Field metin değerlerinin indexlenmesi (ileride ayrı görev).
- Dış kaynak (MCP) arama birleşimi — Connected Search (F2-T11).
- Yazım hatası toleransı/fuzzy match ötesinde gelişmiş NLP sorgu ayrıştırma.

## Kabul Kriterleri

- [ ] Tam eşleşen başlık, anahtar kelime aramasında ilk sırada döner (testli).
- [ ] Anlamsal arama, farklı kelimelerle ama anlamca yakın içeriği bulur (MockProvider ile deterministik testli — F1-T5'teki gibi).
- [ ] Guest/yetkisiz kullanıcı erişimi olmayan bir nesneyi ne sonuç listesinde ne de sayaçta/zamanlamada görebilir (security-reviewer + testli).
- [ ] Doküman içeriği değiştikten debounce (5 sn) sonrası embedding güncellenir (testli).
- [ ] Komut paleti 250ms debounce ile gereksiz istek göndermediği testli.
