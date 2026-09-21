# Veri hakları başvurusu operasyon rehberi

Bu rehber kapalı beta sırasında `data_rights_requests` tablosuna kaydedilen
hesap silme taleplerini güvenli ve izlenebilir biçimde sonuçlandırmak içindir.
Hukuki değerlendirme gereken bir talep için profesyonel görüş alınır.

## Hizmet seviyesi ve sorumluluk

- Sorumlu: Muhammed Furkan ŞAHİN (`sir.furkansahin@gmail.com`).
- Bekleyen talepler her iş günü kontrol edilir.
- Kimlik doğrulamalı başvuru en kısa sürede, her durumda 30 gün içinde
  cevaplanır.
- Operatör, talep kaydını silmeden önce kararın ve kullanıcıya gönderilen
  cevabın tarihini güvenli olay/olgu kaydına işler.

## 1. Bekleyen talepleri listeleme

Yalnızca üretim VM'sindeki yönetici oturumundan, salt-okunur sorguyla başlayın:

```sql
SELECT d.id, d.user_id, u.email, d.requested_at
FROM data_rights_requests d
JOIN users u ON u.id = d.user_id
WHERE d.status = 'pending'
ORDER BY d.requested_at ASC;
```

Takip numarasını destek kaydına kopyalayın. E-posta adresini genel issue,
uygulama logu veya sohbet kanalına taşımayın.

## 2. Kapsamı belirleme ve dışa aktarma

1. Oturumdaki e-posta ile talebin kullanıcı kimliğini eşleştirin.
2. Kullanıcıya ait tüm workspace üyeliklerini ve sahip olduğu kişisel
   görünümleri listeleyin.
3. Kullanıcının üye olduğu her workspace için mevcut JSON dışa aktarmayı alın;
   dosyayı şifreli ve süreli bir konumda tutun.
4. Paylaşılan içerikte başka üyelerin haklarını etkileyebilecek nesneleri,
   federation bağlantılarını ve immutable event kayıtlarını ayrı işaretleyin.
5. Yasal saklama zorunluluğu veya uyuşmazlık varsa kapsamı ve gerekçeyi
   kaydedin; kapsam dışı tüm kişisel veriler silinir ya da anonimleştirilir.

## 3. Uygulama ve doğrulama

Kullanıcı satırında doğrudan `DELETE` çalıştırmayın. Bazı yabancı anahtarlar
federation ve paylaşılan çalışma alanı verilerini zincirleme silebilir. Önce
güncel şema üzerinde referans/etki analizi yapın ve doğrulanmış yedek alın.

- Tüm aktif oturumları iptal edin ve yeni girişleri durdurun.
- OAuth/bağlayıcı kimlik bilgileri, masaüstü izinleri, bellek kayıtları ve
  kişisel tercihler gibi kullanıcıya özel kayıtları temizleyin.
- Paylaşılan çalışma alanı içeriğinde gerekli veriyi anonimleştirin; başka
  kullanıcıların içeriğini silmeyin.
- Olay günlüğü gibi değişmez kayıtlarda kullanıcı tanımlayıcılarını, bütünlük
  korunarak geri döndürülemez takma kimlikle değiştirin.
- İşlem sonrası kullanıcı e-postasıyla oturum açılamadığını ve kişisel API
  sorgularının veri döndürmediğini doğrulayın.
- Yedeklerde kalan kopyalar normal 30 günlük yaşam döngüsüyle silinir; geri
  yükleme yapılırsa tamamlanmış silme kayıtları yeniden uygulanır.

İlk gerçek talep gelmeden önce bu adımlar anonim test verisiyle staging'de
uçtan uca prova edilmelidir. Fiziksel silme/anonimleştirme henüz otomatik
değildir; bu nedenle prova kapalı beta yayın kapısıdır.

## 4. Talebi kapatma

Uygulama tamamlandıktan veya gerekçeli biçimde reddedildikten sonra yalnızca
ilgili takip numarasını güncelleyin:

```sql
UPDATE data_rights_requests
SET status = 'completed', resolved_at = now()
WHERE id = '<TAKIP_UUID>' AND status = 'pending';
```

Reddedilen bir talepte `completed` yerine `rejected` kullanın ve hukuki
gerekçeyi güvenli destek kaydında saklayın. Güncellenen satır sayısı tam olarak
bir değilse işlemi durdurup inceleyin. Kullanıcıya takip numarası, karar,
uygulanan işlemler ve tamamlanma tarihiyle e-posta yanıtı gönderin.

## Kontrol listesi

- [ ] Talep ve oturum kimliği eşleşti.
- [ ] Tüm workspace kapsamı ve paylaşılan veri etkisi incelendi.
- [ ] Şifreli kullanıcı dışa aktarımı hazırlandı.
- [ ] Geri yüklenebilir yedek doğrulandı.
- [ ] Oturumlar/bağlayıcılar iptal edildi.
- [ ] Silme veya anonimleştirme staging'de prova edilmiş prosedürle uygulandı.
- [ ] Sonuç API ve veritabanı üzerinden doğrulandı.
- [ ] Talep durumu ve `resolved_at` güncellendi.
- [ ] Kullanıcıya 30 gün dolmadan güvenli yanıt gönderildi.
- [ ] Geçici dışa aktarma dosyası güvenli biçimde kaldırıldı.
