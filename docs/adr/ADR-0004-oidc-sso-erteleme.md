# ADR-0004: OIDC/SSO F0-T5 Kapsamı Dışına Alınıp Faz 3'e Ertelendi

**Durum:** Kabul edildi
**Tarih:** 2026-07-21
**İlgili görev:** [F0-T5 — Veritabanı Altyapısı + Kimlik Doğrulama + Çok Kiracılılık](../specs/F0-E2/F0-T5-veritabani-ve-auth.md)
**İlgili plan referansı:** `docs/PLAN.md` §6, Faz 3 → Epik F3-E1 (Agent Runtime + Skill SDK) civarına konumlanan otonomi/entegrasyon çalışmasıyla birlikte değerlendirilecek kimlik federasyonu genişlemesi; F0-T5 spec'inin kendi "Kapsam DIŞI" bölümü OIDC/SSO'yu doğrudan ileriki bir göreve erteler.

## Bağlam

F0-T5, LuminaOS'in ilk kimlik doğrulama sistemini kurar:

- E-posta + şifre ile kayıt/giriş; şifreler **argon2** ile hash'lenir (düz metin hiçbir yerde tutulmaz/loglanmaz).
- Sunucu taraflı, **httpOnly cookie tabanlı oturum**: Postgres'te bir `sessions` tablosu tutulur, cookie yalnızca opak bir oturum kimliğini (`session_id`) taşır — token içeriği veya kullanıcı verisi cookie'de saklanmaz.
- Çok kiracılılık (`workspaces` + `memberships`) ve kiracı yalıtım middleware'i aynı görevin parçası.

F0-T5 spec'inin "Kapsam DIŞI" bölümü açıkça şunu belirtir: _"OIDC/SSO, şifre sıfırlama e-postası, 2FA (ileriki görevler)."_ Yani bu üçü bilinçli olarak bu görevden çıkarılmıştır; unutulmuş değildir.

`docs/PLAN.md`'nin Faz 0 görev tablosunda F0-T5 satırı kısaca "Auth (OIDC + oturum)..." diye özetlenmiş olsa da, bu üst düzey bir yol haritası özetidir ve görev seviyesinde daha ayrıntılı olan spec dosyası (`F0-T5-veritabani-ve-auth.md`) bağlayıcıdır. Spec, OIDC'yi bu görevden çıkarıp sonraki bir faza itmiştir; harici kimlik sağlayıcı (Google/Microsoft vb.) entegrasyonu, çoklu-sağlayıcı girişi ve kurumsal SSO gereksinimleri gibi konular, ajan çalışma zamanı ve entegrasyon yüzeyinin olgunlaştığı ileriki bir fazda ele alınacaktır.

## Karar

F0-T5 kapsamında **yalnızca** e-posta + şifre kimlik doğrulaması ve sunucu taraflı oturum çerezi teslim edilir. OIDC/SSO, şifre sıfırlama e-postası ve 2FA bu görevin dışında bırakılır ve ileriki bir faza ertelenir.

`users` şeması, OIDC'yi yapısal olarak imkânsız kılmayacak şekilde tasarlanır (ör. tekil kullanıcı kimliği, e-posta alanı normalize edilmiş ve benzersiz), ancak bu görev kapsamında ekstra soyutlama (ör. ayrı bir `identities`/`credentials` tablosu) **eklenmez** — CLAUDE.md'nin "spec'te olmayan kapsamı ekleme" kuralına uygun olarak asgari, somut ihtiyacı karşılayan şema yazılır.

Bilinçli olarak kabul edilen bir yapısal borç: `users.password_hash` sütunu şu an **`NOT NULL`**'dur. Bu, her kullanıcının bir yerel şifresi olacağı varsayımına dayanır ve F0-T5 kapsamında doğrudur (yalnızca e-posta+şifre akışı var). OIDC eklendiğinde, yalnızca harici bir IdP üzerinden kimlik doğrulayan ve hiç yerel şifresi olmayan kullanıcılar ortaya çıkacaktır — bu noktada iki seçenekten biri uygulanmalıdır:

1. `users.password_hash` sütununu nullable yapmak (basit ama "auth yöntemi" kavramını örtük bırakır), veya
2. Şifre/kimlik bilgisini ayrı bir `credentials` veya `identities` tablosuna taşımak (bir kullanıcının 0..N kimlik doğrulama yöntemine sahip olabileceği genel model — çoklu-sağlayıcı girişi de doğal olarak destekler).

Bu karar OIDC görevi başladığında (muhtemelen kendi ADR'ıyla) netleştirilecektir; şu an için sadece bu geleceğin **bilinçli, planlı bir migration** olduğunu, gözden kaçmış bir tasarım hatası olmadığını kayda geçiriyoruz.

## Sonuçlar

**Şimdi ne kazanıyoruz:**

- Basit, tamamen kendi kendine yeten bir kimlik doğrulama akışı: yerel geliştirme ve testler (Testcontainers ile entegrasyon testleri dahil) herhangi bir harici IdP'ye veya ağ bağımlılığına ihtiyaç duymaz.
- F0-T5'in kabul kriterlerini (kayıt→giriş→workspace izolasyonu) doğrulamak için gereken yüzey minimal tutulur; PR boyutu (±400 satır) disiplinine daha kolay uyulur.
- `sessions` tablosu + opak cookie deseni, ileride OIDC eklendiğinde de (oturum katmanı aynı kalacağı için) değişmeden yeniden kullanılabilir — yalnızca oturumun _nasıl kurulduğu_ (kimlik doğrulama yöntemi) değişecek, oturumun _nasıl temsil edildiği_ değişmeyecek.

**Neyi erteliyoruz:**

- Çoklu-sağlayıcı giriş (Google, Microsoft, vb.) ve bunun gerektirdiği OAuth/OIDC akışları (redirect, state/PKCE, id_token doğrulama, sağlayıcı profil eşleme).
- Kurumsal SSO gereksinimleri (SAML/OIDC ile şirket IdP'sine bağlanma, otomatik provizyonlama/SCIM gibi konular) — bu, pilot ekip ölçeğinin ötesinde bir ihtiyaçtır ve şimdiden çözülmesi gereken bir sorun değildir.
- Yukarıda tarif edilen şema migration'ı (`password_hash` nullable yapmak ya da `credentials`/`identities` tablosuna taşımak). Bu migration OIDC görevi başladığında, CLAUDE.md kuralına uygun olarak down script'i ile birlikte yazılacaktır.
- Şifre sıfırlama e-postası ve 2FA — bunlar da ayrı görevler olarak ele alınacak, bu ADR yalnızca OIDC/SSO ertelemesini belgeler.
