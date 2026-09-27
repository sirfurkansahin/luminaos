# KVKK Madde 9 — Oracle aktarım hazırlık paketi

**Durum:** Hukuk incelemesine hazır taslak — imza ve Kurum bildirimi bekliyor

**Son doğrulama:** 27 Eylül 2026

**Yayın etkisi:** Dış beta davetleri için P0 kapısı

> Bu belge hukuki görüş değildir. Kod, canlı ortam ve resmî kaynaklardan
> çıkarılmış bir çalışma kâğıdıdır. Standart sözleşmeye aktarılacak bilgiler,
> imza yetkileri ve hukuki dayanaklar bir KVKK uzmanı tarafından onaylanmalıdır.

## 1. Önerilen yol ve karar özeti

LuminaOS'un Oracle Cloud Infrastructure'ın Frankfurt ticari bölgesinde çalışması,
Türkiye'deki veri sorumlusundan yurt dışındaki bir altyapı veri işleyene düzenli
kişisel veri aktarımı oluşturur. Mevcut rol dağılımı doğrulanırsa uygun sözleşme
adayı, Kurulun **Standart Sözleşme 2 — Veri Sorumlusundan Veri İşleyene**
metnidir. Nihai model ve ithalatçı tarafın tam tüzel kişiliği hukuk uzmanı ile
Oracle tarafından teyit edilmeden sözleşme imzalanmamalıdır.

Standart sözleşmenin gövdesi değiştirilmez. Ekler tamamlanır, iki tarafın yetkili
imzaları alınır ve imzaların tamamlanmasını izleyen beş iş günü içinde Kuruma
bildirim yapılır. İmza veya bildirim tamamlanmadan dış beta kullanıcısı davet
edilmez.

| Öncelik | İş                                                          | Etki       | Çaba  | Risk       | Sahip                |
| ------- | ----------------------------------------------------------- | ---------- | ----- | ---------- | -------------------- |
| P0      | Oracle'ın sözleşme tarafını ve SS-2 imza sürecini doğrula   | Çok yüksek | Orta  | Çok yüksek | Ürün sahibi + Oracle |
| P0      | Bu envanteri ve hukuki dayanakları uzmanla onayla           | Çok yüksek | Orta  | Çok yüksek | KVKK uzmanı          |
| P0      | Değiştirilmemiş SS-2 ve eklerini imzala                     | Çok yüksek | Orta  | Çok yüksek | Yetkili taraflar     |
| P0      | Beş iş günü içinde Kurum bildirimini ve delilini arşivle    | Çok yüksek | Düşük | Çok yüksek | Veri sorumlusu       |
| P1      | Oracle alt işleyen listesini ve değişiklik bildirimini izle | Yüksek     | Düşük | Orta       | Operasyon            |
| P1      | İşleme envanterini her sürümde güncelle                     | Yüksek     | Düşük | Orta       | Ürün + güvenlik      |

## 2. Taraflar ve roller

| Alan                   | Taslak bilgi                                        | Durum                                                         |
| ---------------------- | --------------------------------------------------- | ------------------------------------------------------------- |
| Veri aktaran           | Muhammed Furkan ŞAHİN                               | Kullanıcı tarafından doğrulandı                               |
| Rol                    | Türkiye'deki veri sorumlusu                         | Hukuk uzmanı onayı gerekli                                    |
| İletişim               | `sir.furkansahin@gmail.com`                         | Kullanıcı tarafından doğrulandı                               |
| Adres / kimlik bilgisi | Doldurulmadı                                        | İmza öncesi güvenli kanaldan tamamlanmalı; repoya yazılmamalı |
| Veri alıcısı           | Oracle hesabındaki sözleşmeci Oracle tüzel kişiliği | **Oracle'dan teyit bekliyor**                                 |
| Alıcının rolü          | Barındırma hizmeti için veri işleyen                | DPA ve hesap sözleşmesiyle teyit edilmeli                     |
| Bölge                  | OCI `eu-frankfurt-1`, Frankfurt, Almanya            | Canlı ortamda doğrulandı                                      |
| Hizmet                 | Compute, ağ ve Object Storage tabanlı şifreli yedek | Canlı ortamda doğrulandı                                      |
| Sözleşme modeli        | Aday: SS-2                                          | Hukuk uzmanı onayı gerekli                                    |

`eu-frankfurt-1` ticari OCI bölgesidir; Oracle EU Sovereign Cloud ile aynı ürün
veya sözleşme alanı olduğu varsayılmamıştır.

## 3. SS-2 Ek I için işleme ve aktarım envanteri

Bu tablo doğrudan Ek I doldurma görüşmesinde kullanılabilir. “Aday” yazan
hukuki değerlendirmeler kesin karar değildir.

| Ek I alanı                            | LuminaOS taslağı                                                                                                                                                                                                    |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Veri aktaranın faaliyetleri           | Türkiye'deki kapalı beta kullanıcılarına çalışma alanı, görev, belge, arama, takvim ve iş birliği yazılımı sunmak                                                                                                   |
| Veri alıcının faaliyetleri            | Uygulama ve veritabanı barındırma, veri iletimi, güvenlik/izleme, bakım, destek, felaket kurtarma ve şifreli yedek nesnesi saklama                                                                                  |
| İlgili kişi grupları                  | Beta hesap sahipleri ve çalışma alanı üyeleri; kullanıcı içeriğinde yer alan kişiler; isteğe bağlı bağlantılarda hesap/etkinlik kişileri                                                                            |
| Kimlik ve iletişim                    | Kullanıcı UUID'si, e-posta adresi, hesap oluşturma/güncelleme zamanları                                                                                                                                             |
| Kimlik doğrulama ve güvenlik          | Argon2id parola özeti; opak oturum kimliği, oturum zamanları ve iptal durumu; güvenlik ve hata günlükleri                                                                                                           |
| Kullanıcı içeriği                     | Çalışma alanları, görevler, belgeler, yorumlar, özel alanlar, görünümler, ilişkiler, arama dizini ve değişmez olay kayıtları                                                                                        |
| İş birliği ve otomasyon               | Üyelikler, bildirim tercihleri, agent/otomasyon yapılandırmaları, öneriler ve kullanıcı-agent mesajları                                                                                                             |
| İsteğe bağlı bağlayıcı verisi         | Takvim hesabı ve etkinlikleri; AES-256-GCM ile şifrelenmiş OAuth/bağlayıcı kimlik bilgileri; özellik etkinleştirilirse federasyon/webhook verileri                                                                  |
| İsteğe bağlı masaüstü/toplantı verisi | Ayrıntılı rızaya bağlı aktif pencere/takvim sinyal izinleri; toplantı URL'si, kayıt URL'si ve transkript                                                                                                            |
| Veri hakkı kayıtları                  | Talep UUID'si, kullanıcı UUID'si, tür, durum ve zaman damgaları                                                                                                                                                     |
| Özel nitelikli veri                   | Ürün özellikle talep etmez. Serbest metin, belge veya transkripte kullanıcı tarafından girilebilir; kabul politikası ve ek tedbir kararı hukuk uzmanına açık                                                        |
| Aktarım sıklığı                       | Hizmet kullanıldıkça sürekli/tekrarlanan; yedekler günlük                                                                                                                                                           |
| İşlemenin niteliği                    | Alma, iletme, kaydetme, düzenleme, sorgulama, görüntüleme, şifreli yedekleme, geri yükleme ve silme/anonimleştirme                                                                                                  |
| Amaç                                  | Beta hizmetini sunmak; hesabı ve oturumu yönetmek; çalışma alanı işlemlerini yürütmek; güvenlik, hata giderme, yedekleme ve veri hakkı taleplerini sağlamak                                                         |
| İşleme hukuki şartı                   | Adaylar: KVKK m.5/2(c) sözleşmenin kurulması/ifası, m.5/2(ç) hukuki yükümlülük ve m.5/2(f) temel haklara zarar vermeyen meşru menfaat. Her amaç/veri kategorisi için hukuk uzmanı onayı gerekir                     |
| Saklama                               | Aktif hesap ve içerik hizmet sürdükçe; onaylanan talepte silme/anonimleştirme; şifreli yedekler 30 günlük yaşam döngüsü; oturumlar süre sonu/iptal alanlarıyla; uygulama logları 10 MB × 5 dosya döngüsüyle sınırlı |
| Alıcı grupları                        | Oracle'ın hesap sözleşmesindeki tüzel kişiliği ve yalnızca hizmet için kullandığı onaylı alt işleyenler; kesin liste Oracle portalından eklenmeli                                                                   |
| Sonraki aktarımlar                    | Oracle destek/operasyon ve alt işleyen konumları henüz doğrulanmadı; Oracle'ın güncel listesi ve uzaktan erişim yerleri alınmalı                                                                                    |
| VERBİS                                | Kayıt yükümlülüğü veya istisna durumu hukuk uzmanı tarafından doğrulanmalı; Ek I'e sonuç yazılmalı                                                                                                                  |

### Kapsam sınırı

Kapalı beta yayın sınırında agents, federasyon, otomatik not alma ve zorunlu
olmayan bağlayıcılar özellik bayrağıyla kapalıdır. Bunlardan biri açılmadan önce
işleme envanteri, alıcılar, aydınlatma metni ve gerekiyorsa standart sözleşme
ekleri yeniden değerlendirilir.

## 4. SS-2 Ek II için teknik ve idari tedbir taslağı

| Kontrol alanı       | Uygulanan tedbir / kanıt                                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| İletim güvenliği    | HTTPS/TLS sonlandırması ve güvenli oturum çerezi; veri tabanı ve Redis doğrudan internete yayımlanmıyor                  |
| Kimlik doğrulama    | Argon2id parola karması, sunucu taraflı opak oturum, yetkisiz API isteklerinde 401/403 kontrolleri                       |
| Yetkilendirme       | Çalışma alanı üyeliği ve kaynak bazlı erişim kontrolleri; çapraz çalışma alanı testleri                                  |
| Sır yönetimi        | Sırlar kaynak koduna yazılmıyor; çalışma zamanında enjekte ediliyor; bağlantı/OAuth sırları AES-256-GCM ile şifreleniyor |
| Yedek               | Günlük AES-256 şifreli PostgreSQL dökümü, OCI Object Storage, `daily/` için 30 günlük silme yaşam döngüsü                |
| Geri yükleme        | Ayrı hacimde başarılı geri yükleme provası ve migrasyon doğrulaması kayda alındı                                         |
| En az ayrıcalık     | VM'nin Object Storage erişimi OCI instance principal ile sınırlandırıldı; yönetim SSH anahtarıyla                        |
| Günlükler           | Yapılandırılmış/redakte edilmiş uygulama logları; Docker log döngüsü 10 MB × 5 dosya; kimlik bilgileri loglanmıyor       |
| Güvenli geliştirme  | CI'da test, tür/lint, bağımlılık ve sır kontrolleri; güvenlik odaklı incelemeler                                         |
| Veri sahibi hakları | JSON dışa aktarma ve kimlik doğrulamalı silme talebi; en geç 30 günlük operasyon rehberi                                 |
| Süreklilik          | Sağlık kontrolü, üretim izleme işi, şifreli yedek ve belgelenmiş geri alma prosedürü                                     |
| Veri minimizasyonu  | Kapalı beta dışı özellikler kapalı; açık rıza gerektiren masaüstü sinyalleri tür bazında ayrı izinli                     |

Oracle'ın kendi teknik ve idari tedbirleri, güvenlik eki ve denetim belgeleri
Oracle sözleşme paketiyle ayrıca alınmalı; LuminaOS kontrolleri Oracle adına
beyan edilmemelidir.

## 5. SS-2 Ek III — alt işleyenler

Bu ek tahminle doldurulmaz. Oracle Services Privacy Policy, güncel alt işleyen
listesini müşterinin destek portalındaki ilgili dokümana yönlendirir.

- [ ] My Oracle Support / ilgili destek aracı üzerinden güncel Oracle Cloud alt
      işleyen listesi alındı.
- [ ] Her alt işleyen için tam unvan, adres, ülke, faaliyet, veri kategorisi ve
      süre çıkarıldı.
- [ ] Oracle iştiraklerinin ve uzaktan destek ekiplerinin erişim ülkeleri
      doğrulandı.
- [ ] Alt işleyen değişiklik bildirim aboneliği etkinleştirildi ve sahibi
      belirlendi.
- [ ] Hukuk uzmanı Ek III kapsamını ve itiraz/değişiklik prosedürünü onayladı.

## 6. Oracle'a gönderilecek bilgi ve imza talebi

Hesabın destek kanalında aşağıdaki metin açılabilir. Göndermeden önce tenancy
OCID ve hesap e-postası özel destek kaydına eklenir; genel issue'ya yazılmaz.

> Subject: Turkey KVKK Article 9 Standard Contract (Controller-to-Processor)
>
> We operate an invite-only service from Türkiye using OCI commercial region
> eu-frankfurt-1. Please confirm (1) the exact Oracle contracting legal entity,
> registered address and authorized signature process for our account, (2)
> whether the current Oracle Services DPA is incorporated into our Free Tier/
> account agreement, (3) Oracle's process for executing the Turkish KVKK Board
> Standard Contract 2 without altering its mandatory text, (4) the current
> subprocessor list and change-notification method, (5) processing and remote
> support locations applicable to our services, and (6) the applicable
> technical/organizational measures, deletion/return terms and incident contact.
> This information is required before we invite external beta users.

Oracle'dan alınacak deliller:

- [ ] Hesap sözleşmesi/sipariş ve yürürlükteki hizmet politikaları.
- [ ] Hesaba uygulanabilir DPA sürümü ve dahil edilme kanıtı.
- [ ] Tam Oracle tüzel kişiliği, kayıtlı adresi ve imza yetki belgesi.
- [ ] Oracle'ın SS-2 imzalama yanıtı ve yetkili imzalı nüsha.
- [ ] Güncel alt işleyen listesi ile değişiklik bildirim yöntemi.
- [ ] Veri/uzaktan erişim ülkeleri ve hizmete uygulanabilir güvenlik eki.
- [ ] Silme/iade, ihlal bildirimi ve denetim süreçleri.

### İletişim kaydı

| Tarih         | Kanal                               | Sonuç                                                                                                        | Sonraki adım                                                                 |
| ------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| 27 Eylül 2026 | Oracle Türkiye satış iletişim formu | Talep başarıyla gönderildi; Oracle temsilcisinin iletişime geçeceği doğrulandı. Referans numarası verilmedi. | Yazılı Oracle yanıtını bekle ve yukarıdaki delil listesini yanıtla eşleştir. |

Başvuruda teknik destek veya ücretli hesap yükseltmesi istenmedi; herhangi bir
ücretli plan ya da ücret gerekliyse bunun işlemden önce açıkça bildirilmesi
talep edildi. Pazarlama izni verilmedi. Kişisel iletişim bilgileri bu depoya
kaydedilmemiştir. Oracle yanıtı alınana kadar açık maddeler tamamlanmış sayılmaz
ve dış beta yayın kapısı kapalı kalır.

## 7. Hukuk uzmanına teslim kontrol listesi

- [ ] Bu paketteki taraf rolleri ve SS-2 seçimi onaylandı.
- [ ] Her amaç/veri kategorisi için KVKK m.5/m.6 işleme şartı onaylandı.
- [ ] Serbest metinde özel nitelikli veri riski ve beta kabul politikası karara bağlandı.
- [ ] VERBİS yükümlülüğü/istisnası yazılı olarak belirlendi.
- [ ] Aydınlatma metni; kesin Oracle tüzel kişiliği, alıcı grupları ve aktarım güvencesiyle güncellendi.
- [ ] Saklama ve imha çizelgesi, özellikle operasyon logları ve olay günlüğü için onaylandı.
- [ ] Oracle DPA, hesap sözleşmesi, SS-2 ve ekler birlikte tutarlılık kontrolünden geçti.
- [ ] İmza yetki belgeleri ve yabancı belgeler için apostil/tercüme gerekliliği belirlendi.
- [ ] Bildirimi yapacak kişi, kanal ve son tarih hesabı atandı.

## 8. İmza, bildirim ve delil zinciri

1. KVKK sitesinden güncel SS-2 dosyasını yeniden indirin ve SHA-256 özetini
   kayıt altına alın.
2. Zorunlu metni değiştirmeden yalnızca taraf alanları ve Ek I–III'ü hukuk
   uzmanının onayladığı bilgilerle doldurun.
3. Her iki tarafın imza tarihi, yetkili kişi adı/unvanı ve yetki delilini alın.
4. **Son imza tarihini 0. gün** kabul edin; resmî tatilleri dikkate alarak beş
   iş günlük bildirim son tarihini hukuk uzmanıyla kaydedin.
5. Kurumun Standart Sözleşme Bildirim Modülü, KEP veya izin verilen fiziksel
   kanal üzerinden nihai imzalı sözleşmeyi süresinde bildirin.
6. İmzacı yetki belgelerini ve gerekiyorsa noter onaylı tercüme/apostil
   belgelerini ekleyin.
7. Başvuru numarası, zaman damgası, teslim/alındı kanıtı ve gönderilen dosyaların
   özetlerini erişimi kısıtlı hukuk arşivinde saklayın; kişisel belgeleri Git'e
   koymayın.
8. Hukuk uzmanı bildirimin usulen tamamlandığını yazılı teyit ettikten sonra
   release-readiness kapısını kapatın ve dış davetleri etkinleştirin.

Bildirim yükümlülüğünün sözleşmede açıkça veri alıcısına verilmediği durumda
veri aktaranın sorumluluğunda olduğu varsayımıyla hareket edilir; nihai görev
dağılımını hukuk uzmanı onaylar.

## 9. Değişiklik yönetimi ve periyodik kontrol

- Oracle tarafı, bölge, hizmet, alt işleyen, erişim ülkesi veya veri kategorisi
  değişirse dış aktarım değerlendirmesini yayın öncesinde yeniden açın.
- Alıcı grubu/alt işleyen değişikliği ve sözleşmenin sona ermesi için gereken
  takip bildirimini hukuk uzmanıyla değerlendirin.
- Oracle bildirimleri aylık; envanter ve saklama çizelgesi her sürümde; aktarım
  paketi en az yılda bir gözden geçirilir.
- Yeni AI, takvim, MCP, not alma, federasyon veya native mobil sağlayıcısı
  eklenirse ayrı alıcı/alt işleyen ve aktarım analizi yapılır.

## 10. Yayın kapısını kapatma ölçütü

Dış beta daveti ancak aşağıdakilerin tamamı kanıtlandığında açılır:

- [ ] Oracle taraf bilgileri ve güncel alt işleyenler doğrulandı.
- [ ] Hukuk uzmanı model, ekler, hukuki şartlar ve aydınlatma metnini onayladı.
- [ ] Değiştirilmemiş SS-2 iki yetkili tarafça imzalandı.
- [ ] Beş iş günlük Kurum bildirimi süresinde tamamlandı ve alındı kanıtı arşivlendi.
- [ ] Yayımlanmış aydınlatma metni nihai bilgilerle güncellendi ve test edildi.
- [ ] Go/no-go kaydında hukuk kapısı “geçti” olarak işaretlendi.

## Resmî kaynaklar

- KVKK, [Standart Sözleşmeler duyurusu](https://www.kvkk.gov.tr/Icerik/7938/Standart-Sozlesmeler-ve-Baglayici-Sirket-Kurallarina-Iliskin-Dokumanlar-Hakkinda-Kamuoyu-Duyurusu)
- KVKK, [Yurt Dışına Aktarım Rehberi](https://www.kvkk.gov.tr/Icerik/8142/Kisisel-Verilerin-Yurt-Disina-Aktarilmasi-Rehberi)
- KVKK, [Standart Sözleşme 2](https://www.kvkk.gov.tr/Icerik/7931/Kisisel-Verilerin-Yurt-Disina-Aktarilmasinda-Kullanilacak-Standart-Sozlesme-2-Veri-Sorumlusundan-Veri-Isleyene-)
- Oracle, [Data Processing Agreement for Oracle Services — 14 Ağustos 2025](https://www.oracle.com/contracts/docs/data-processing-agreement-oracle-services-081425.pdf)
- Oracle, [Services Privacy Policy](https://www.oracle.com/legal/privacy/services-privacy-policy/)
- Oracle, [Cloud Services Contracts](https://www.oracle.com/contracts/cloud-services/)
- Oracle, [Suppliers and subprocessors](https://www.oracle.com/corporate/security-practices/corporate/supply-chain/suppliers/)
