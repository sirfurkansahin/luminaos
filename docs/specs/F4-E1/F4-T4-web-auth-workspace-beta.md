# F4-T4 — Web oturumu ve çalışma alanı seçimi

**Durum:** In Progress  
**Öncelik:** P0 — kapalı beta ön koşulu  
**Bağımlılıklar:** F0 kimlik doğrulama API'si, F4-T3 mobil/PWA kabuğu

## Amaç

Web/PWA istemcisindeki geliştirme amaçlı sabit kullanıcı ve çalışma alanı
kimliklerini kaldırmak; mevcut çerez tabanlı sunucu oturumunu, çalışma alanı
seçimini ve çıkışı kullanıcı arayüzüne bağlamak.

## Ürün kararları

- Kapalı beta süresince herkese açık kayıt ekranı yoktur. Hesaplar operatör
  tarafından davet/provizyon edilir; arayüz yalnızca giriş sunar.
- Yeni kimlik sağlayıcısı veya ücretli servis eklenmez. Mevcut `HttpOnly`,
  `SameSite=Lax`, üretimde `Secure` oturum çerezi kullanılır.
- Son seçili çalışma alanının yalnızca kimliği yerel depoda tutulur. Seçim,
  her oturum yüklenişinde sunucudan dönen üyelik listesine karşı doğrulanır.
- E2E'nin `e2eWorkspaceId` parametresi yalnızca oturum kullanıcısının eriştiği
  çalışma alanlarından biri olduğunda seçimi etkileyebilir.
- Rol, istemci tarafından varsayılmaz; seçili çalışma alanının korumalı API
  yanıtından alınır. Sunucu yetkilendirmesi nihai güvenlik sınırıdır.

## Kapsam

1. `POST /auth/login`, `POST /auth/logout`, `GET /me`, `POST /workspaces` ve
   `GET /workspaces/:id` için tipli web istemcisi fonksiyonları.
2. Oturum yükleme, giriş, genel hata ve yeniden deneme durumları.
3. Tek çalışma alanını otomatik seçme; birden çok çalışma alanı için seçici;
   geçerli seçimi cihazda hatırlama.
4. Çalışma alanı olmayan kullanıcı için ilk çalışma alanı oluşturma akışı.
5. Gerçek kullanıcı kimliği ve rolünün mevcut panellere aktarılması.
6. Çıkışta sorgu önbelleğini ve yerel çalışma alanı seçimini temizleme.
7. Yerel geliştirme proxy'sine `/auth` ve `/me` eklenmesi.

## Kapsam dışı

- Herkese açık self-servis kayıt, parola sıfırlama ve e-posta doğrulama.
- OAuth/SSO, davet yönetimi ve kullanıcı/üyelik yönetim ekranı.
- Sunucu kimlik doğrulama sözleşmesinin değiştirilmesi.

## Kabul kriterleri

- [ ] Oturumsuz ziyaretçi yalnızca erişilebilir giriş ekranını görür.
- [ ] Geçerli girişten sonra kullanıcıya ait çalışma alanı yüklenir.
- [ ] Geçersiz kimlik bilgisi anlaşılır ve hassas bilgi sızdırmayan hata verir.
- [ ] Birden fazla üyelikte seçim yapılabilir ve yalnızca geçerli üyelik
      yerel olarak hatırlanır.
- [ ] Üyeliksiz kullanıcı ilk çalışma alanını oluşturup uygulamaya geçebilir.
- [ ] Kullanıcı kimliği ve admin durumu sabit değerlerden değil oturum/API'den
      gelir.
- [ ] Çıkış sunucu oturumunu sonlandırır ve uygulama verisini temizler.
- [ ] 320 px genişlikte giriş ve çalışma alanı kontrolleri taşma yapmaz;
      klavye etiketleri ve en az 44 px dokunma hedefleri bulunur.
- [ ] Birim/entegrasyon testleri, typecheck, lint ve web build yeşildir.

## Güvenlik kontrolleri

- Parola hiçbir zaman depolanmaz, loglanmaz veya sorgu anahtarına eklenmez.
- Tüm oturum çağrıları `credentials: include` kullanır.
- 401 ile ağ/5xx hataları ayrılır; genel arıza giriş hatası gibi gösterilmez.
- Çalışma alanı query-param/localStorage değeri üyelik listesinde yoksa yok
  sayılır.
- Çıkış sonrası TanStack Query önbelleği temizlenir.

## Test planı

- API istemcisi: URL, yöntem, gövde, çerez ve hata sözleşmeleri.
- UI: yükleme, giriş başarı/hata, yeniden deneme, boş/tek/çoklu çalışma alanı,
  kalıcı seçim, güvenilmeyen seçim, oluşturma ve çıkış.
- Mevcut App kablolama testleri: gerçek `workspaceId`, `userId`, rol.
- Playwright: var olan çerezli fixture ile uygulamanın açılması.
