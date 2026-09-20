# F4-T9 — Kapalı beta gizlilik ve veri hakları

**Durum:** In Progress

**Öncelik:** P0 — kullanıcı davetinden önce

**Bağımlılıklar:** F4-T4, F4-T7, F1-T18 veri dışa aktarma

## Amaç

Kapalı beta kullanıcısına oturum açmadan erişilebilen aydınlatma/kullanım
metinleri ile oturum içinde veri dışa aktarma ve silme talebi akışları sunmak.

## Varsayımlar ve sınırlar

- İlk beta Türkiye'de yürütülür; metinler KVKK'nın resmî asgari aydınlatma
  başlıklarını temel alır. Bu çalışma hukuki danışmanlık yerine geçmez.
- Aydınlatma, açık rıza değildir ve ayrı sunulur.
- Paylaşılan çalışma alanları ve değişmez olay günlüğü nedeniyle hesap silme
  otomatik yapılmaz; kimliği doğrulanmış talep en geç 30 günde operatörce
  sonuçlandırılır.
- Veri sorumlusunun yayımlanacak gerçek/tüzel kişi adı kullanıcı tarafından
  doğrulanmadan üretim metni nihai kabul edilmez.

## Aşamalar

### PR1 — Hukuki merkez ve görünür dışa aktarma

- `?legal=privacy` ve `?legal=terms` oturum gerektirmeden açılır.
- Giriş ekranı ve uygulama içinden iki metne erişilir.
- Veri hakları paneli mevcut çalışma alanı JSON dışa aktarımını indirir.
- Veri sorumlusu adı ve iletişim adresi build-time yapılandırılır.

### PR2 — Kimliği doğrulanmış silme talebi

- Oturum gerektiren, tekrar çağrıldığında ikinci açık kayıt oluşturmayan talep.
- Kullanıcıya takip kimliği ve talep zamanı gösterimi.
- Operatörün inceleme, dışa aktarma, silme/anonimleştirme ve cevap adımları.

## Kabul kriterleri

- [ ] Hukuki sayfalar oturumsuz ve mobil/klavye erişilebilir açılır.
- [ ] Aydınlatma metni kimlik, amaç, veri kategorisi, aktarım, yöntem/hukuki
      sebep, saklama ve hak başlıklarını içerir.
- [ ] Kullanıcı mevcut çalışma alanı verisini JSON olarak indirebilir.
- [ ] Silme talebi yalnızca oturum sahibince oluşturulur ve yinelenmez.
- [ ] Talep süreci 30 günlük cevap süresini ve yedek saklama sınırını açıklar.
- [ ] Birim, entegrasyon, E2E, erişilebilirlik ve güvenlik kontrolleri geçer.

## Öncelik değerlendirmesi

| İş                        | Etki   | Çaba       | Risk       | Sıra         |
| ------------------------- | ------ | ---------- | ---------- | ------------ |
| Kamuya açık aydınlatma    | Yüksek | Düşük      | Orta       | 1            |
| Görünür veri dışa aktarma | Yüksek | Düşük      | Düşük      | 2            |
| Kayıtlı silme talebi      | Yüksek | Orta       | Orta       | 3            |
| Otomatik fiziksel silme   | Yüksek | Çok yüksek | Çok yüksek | Beta sonrası |
