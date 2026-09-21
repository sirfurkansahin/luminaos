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
- OCI bölgesi Türkiye dışındaysa KVKK m.9 kapsamındaki uygun aktarım güvencesi
  (ör. taraflara uygun standart sözleşme ve süresinde Kurum bildirimi) hukuki
  incelemeyle tamamlanmadan dış kullanıcı davet edilmez. Aydınlatma metni tek
  başına yurt dışı aktarımını hukuka uygun hâle getirmez.
- Paylaşılan çalışma alanları ve değişmez olay günlüğü nedeniyle hesap silme
  otomatik yapılmaz; kimliği doğrulanmış talep en geç 30 günde operatörce
  sonuçlandırılır.
- Veri sorumlusu `Muhammed Furkan ŞAHİN`, başvuru adresi
  `sir.furkansahin@gmail.com` olarak kullanıcı tarafından doğrulanmıştır.

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

- [x] Hukuki sayfalar oturumsuz ve mobil/klavye erişilebilir açılır.
- [x] Aydınlatma metni kimlik, amaç, veri kategorisi, aktarım, yöntem/hukuki
      sebep, saklama ve hak başlıklarını içerir.
- [x] Kullanıcı mevcut çalışma alanı verisini JSON olarak indirebilir.
- [x] Silme talebi yalnızca oturum sahibince oluşturulur ve yinelenmez.
- [x] Talep süreci 30 günlük cevap süresini ve yedek saklama sınırını açıklar.
- [ ] Birim, entegrasyon, E2E, erişilebilirlik ve güvenlik kontrolleri geçer.

## Öncelik değerlendirmesi

| İş                        | Etki   | Çaba       | Risk       | Sıra         |
| ------------------------- | ------ | ---------- | ---------- | ------------ |
| Kamuya açık aydınlatma    | Yüksek | Düşük      | Orta       | 1            |
| Görünür veri dışa aktarma | Yüksek | Düşük      | Düşük      | 2            |
| Kayıtlı silme talebi      | Yüksek | Orta       | Orta       | 3            |
| Otomatik fiziksel silme   | Yüksek | Çok yüksek | Çok yüksek | Beta sonrası |

## Açık yayın kapısı

- [ ] OCI hesap sözleşmesi ve seçilen bölge için KVKK m.9 aktarım mekanizması
      hukuk uzmanıyla doğrulandı; gerekiyorsa standart sözleşme imzalandı ve
      beş iş günü bildirim süreci işletildi.
- [x] Üretim yedek kovasında `daily/` nesneleri için 30 günlük silme yaşam
      döngüsü 21 Eylül 2026'da canlı ortamda doğrulandı.
