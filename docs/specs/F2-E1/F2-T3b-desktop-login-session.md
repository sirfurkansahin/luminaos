# F2-T3b — `apps/desktop` Login/Session Mekanizması

**Epik:** F2-E1 (Lumina Context Fabric) · **Durum:** Tamamlandı — plan onaylandı, implementasyon PR'ı merge edildi (bkz. commit geçmişi). Karar özeti: (Açık Soru 1) Seçenek B + planlama sırasında bulunan düzeltme — `GET /me` yanıtı `workspaces: {id,name}[]` alanıyla genişletildi (yeni bir ROUTE değil); (Açık Soru 2) Seçenek B — yeni bağımlılık yok, `useState`/`Context`; (Açık Soru 3-5) önerilen varsayılanlar kabul edildi.
**Bağımlılık:** F2-T2b (`apps/desktop` iskeleti — Tauri v2, ADR-0019)

> ⚠️ MİMARİ-KRİTİK GÖREV (kısmi): Bu görev CLAUDE.md'nin "Mimari Değişmezler" listesinden hiçbirine dokunmuyor ve yeni bir güvenlik modeli icat etmiyor — yalnızca `apps/server`'ın zaten var olan `/auth/login`/`/auth/logout`/`/auth/refresh`/`GET /me` session-cookie modelini tüketiyor (bkz. Mevcut Durum). Bu nedenle F2-T3/F2-T2b'deki gibi ADR kriteri (a)'ya girmiyor. Ancak ADR kriteri (b)'ye ("birden fazla pakete veya gelecekteki görevlere dayatılan bir sözleşim tanımlıyorsa") giriyor: bu görev `apps/desktop`'ın (a) HTTP istemcisinin oturum-farkında hale gelme deseni, (b) login/uygulama arasındaki gezinme (routing/state-management) mimarisi ve (c) workspace-context'in nereden geldiği konusunda ilk kararı verecek — bunlar F2-T3'ün geri kalanına (henüz UI'ı olmayan PR4) ve Faz 3'ün tüm masaüstü-bağımlı görevlerine (Agent Runtime, Ambient Intelligence, Sakin Yazılım) dayatılacak. Bu yüzden architect taslağı + insan onayı koddan önce isteniyor, ama F2-T2b/F2-T3'ün aksine tam bir ADR şart değil — Açık Sorular 1 ve 2'nin insan tarafından kararlaştırılması, gerekirse kısa bir ADR ile (architect ikinci bir tur olarak) sabitlenmesi yeterli olabilir (bkz. Açık Soru 1/2'nin sonundaki not).

## Amaç

`apps/desktop` (Tauri) içine, `apps/server`'ın mevcut `/auth/login` / `/auth/logout` / `/auth/refresh` / `GET /me` session-cookie modelini kullanan **gerçek bir login/session UI akışı** kurmak: kullanıcı email/şifre ile giriş yapabilir, oturumu webview'de kalıcı olarak tutulur, uygulama açılışında mevcut oturum kontrol edilir, workspace context'i manuel `localStorage.setItem` yerine gerçek bir akıştan gelir, ve çıkış yapabilir. Bu, `apps/desktop`'ın F2-T3'ün sinyal toplayıcıları da dahil TÜM gelecekteki özelliklerinin üzerine kurulacağı kimlik doğrulama temelidir.

## Mevcut Durum

- **Sunucu-taraflı login/session altyapısı tamamen hazır, bu görevde sunucu tarafında ek iş gerekmiyor:**
  - `POST /auth/register`, `POST /auth/login` (`loginSchema` — email + password), `POST /auth/logout`, `POST /auth/refresh` (`apps/server/src/auth/auth.controller.ts`) — hepsi çalışıyor, `sid` httpOnly cookie (`sameSite:'lax'`, `maxAge: 7 gün`, `secure` yalnızca production'da) döndürüyor.
  - `GET /me` (`apps/server/src/auth/me.controller.ts`) — `SessionAuthGuard` korumalı, `{user:{id,email,createdAt}}` döner; masaüstü uygulamasının açılışta "zaten giriş yapılmış mı" kontrolü için doğrudan kullanılabilir.
  - Session 7 gün TTL, rotation-tabanlı (sliding DEĞİL), `/auth/refresh` ile yenilenebilir.
  - CORS zaten F2-T3'ten beri `env.desktopOrigin`'i kapsıyor; `/auth/login`'e özel bir CORS/CSRF davranışı yok, global middleware'den geçiyor. `apps/desktop/README.md`'nin mevcut manuel smoke-test'i bunu zaten kanıtlıyor (webview devtools'undan çıplak `fetch(..., {credentials:'include'})` ile login çalışıyor).
- **KRİTİK: `apps/web`'de de hiç login UI'ı yok.** `apps/web/src` içinde login formu/sayfası/auth-client çağrısı sıfır (grep 0 sonuç). `apps/web/src/App.tsx`'te `DEV_WORKSPACE_ID = 'dev-workspace'` hardcode edilmiş, workspace-seçim UI'ı yok. `apps/web/src/lib/apiClient.ts`'de `login`/`register`/`logout` fonksiyonu yok (endpoint'ler var ama hiçbir client'tan çağrılmıyor). **Bu, F2-T3b'nin "`apps/web`'in login akışını masaüstüne taşıma" görevi olmadığı, tüm monorepo'da ilk gerçek login UI'ını inşa etme görevi olduğu anlamına geliyor** — kapsam beklenenden büyük, bu bilinçli olarak açıkça not ediliyor.
- **Workspace listeleme endpoint'i yok:** `apps/server/src/workspaces/workspaces.controller.ts`'de yalnızca `POST /workspaces` (oluştur) ve `GET /workspaces/:workspaceId` (tekil, membership-gated) var — bir kullanıcının üye olduğu tüm workspace'leri listeleyen bir `GET /workspaces` (liste) endpoint'i yok. `workspace-membership.service.ts` bir kullanıcının birden fazla workspace'e üye olabileceğini doğruluyor (unique kısıt yok). Çok-workspace'li bir kullanıcı için gerçek bir "workspace seç" ekranı yeni bir sunucu endpoint'i gerektirir — bu görevin kapsamına girip girmediği Açık Soru 1.
- **`apps/desktop`'ın mevcut durumu:**
  - `apps/desktop/README.md` bugün manuel dev-only session/workspace enjeksiyon adımlarını dokümante ediyor (webview devtools'unda çıplak `fetch` + `localStorage.setItem('luminaos.workspaceId', ...)`) — bu görev bunu gerçek bir UI akışıyla değiştirecek (bkz. Kabul Kriterleri).
  - `apps/desktop/src/api/http-client.ts` — mutlak-URL `request<T>()` deseni (F2-T3'ten), yeni `login`/`logout`/`register`/`getMe` fonksiyonlarıyla genişletilecek.
  - `apps/desktop/src/workspace-context.ts` — `getWorkspaceId()` `localStorage`'dan okuyor; gerçek seçim akışı bu anahtara yazacak.
  - `apps/desktop/src/App.tsx` / `main.tsx` — tamamen boş iskelet (yalnızca `<h1>` + `Button`), hiçbir router/state-management kütüphanesi kurulu değil (`package.json`'da yalnızca `react`/`react-dom`/`@luminaos/ui`/`@tauri-apps/api` var) — bu görev bunu sıfırdan seçecek/kuracak (bkz. Açık Soru 2).
- **Tauri-spesifik notlar:**
  - `apps/desktop/src-tauri/tauri.conf.json`'ın CSP'si (`connect-src 'self' ipc: http://ipc.localhost`) sunucu origin'ini (`http://localhost:3000`) açıkça listelemiyor — ama F2-T3'ün mevcut sinyal-gönderme `fetch()` çağrıları (`http-client.ts`) zaten çalışıyor (merge edildi, testleri geçti), bu CSP'nin pratikte engelleyici olmadığını gösteriyor. Bu repoda hiç test edilmemiş/doğrulanmamış bir gözlem, bkz. Açık Soru 5.
  - WebView2'nin çerez deposunun uygulama yeniden başlatıldığında kalıcı olup olmadığı repoda hiç doğrulanmamış/test edilmemiş — README bunu varsayıyor ("kalıcıdır, ancak farklı profilde sıfırlanabilir"), ama gerçek davranış onaylanmamış, bkz. Açık Soru 3.
  - Bugüne kadar hiçbir HTTP-ilişkili Tauri plugin/komut kullanılmadı — tüm ağ trafiği düz tarayıcı `fetch()` ile. Login için de yeni bir Tauri komutu gerekmediği görünüyor (mevcut desen zaten çalışıyor), ama bu görev sırasında doğrulanmalı/onaylanmalı.

## Kapsam

1. **`apps/desktop/src/api/http-client.ts` genişletmesi:** `login(email, password)`, `logout()`, `register(...)` (bkz. Açık Soru 4), `getMe()` fonksiyonları — mevcut mutlak-URL `request<T>()` deseninin üzerine, `credentials:'include'` ile.
2. **Login ekranı:** email/şifre formu, sunucunun `loginSchema`'sıyla tutarlı istemci-taraflı doğrulama, hata durumu gösterimi (yanlış kimlik bilgisi, ağ hatası).
3. **Açılış oturum kontrolü:** uygulama başlarken `GET /me` çağrılır; başarılıysa doğrudan ana uygulamaya, başarısızsa (401) login ekranına yönlendirilir (bkz. Açık Soru 3).
4. **Login ↔ ana uygulama geçiş mimarisi:** router/state-management kararı (bkz. Açık Soru 2) uygulanır; `apps/desktop/src/App.tsx`/`main.tsx` bu karara göre yeniden yapılandırılır.
5. **Workspace context akışı:** `workspace-context.ts`'in `getWorkspaceId()`'i artık manuel `localStorage.setItem` yerine gerçek bir akıştan (Açık Soru 1'in kararına göre: otomatik-tekli-üyelik ata VEYA gerçek seçim ekranı) besleniyor.
6. **Logout:** ana uygulamadan erişilebilir bir çıkış aksiyonu, `/auth/logout`'u çağırır, oturum durumunu temizler, login ekranına döner.
7. **`apps/desktop/README.md` güncellemesi:** manuel dev-only session/workspace enjeksiyon adımları kaldırılır veya "yalnızca acil durum / otomasyon testleri için" notuyla ikinci plana düşürülür; gerçek UI akışı birincil yol olarak dokümante edilir.
8. **(Açık Soru 1'in kararına bağlı, koşullu) Sunucu tarafı `GET /workspaces` endpoint'i:** kullanıcının üye olduğu workspace'leri listeler, `SessionAuthGuard` korumalı — yalnızca Seçenek A seçilirse kapsama girer.
9. **Testler:** frontend-taraflı login/session akışı `@tauri-apps/api/mocks` + `fetch` mock'larıyla, OS/gerçek sunucu bağımlılığı olmadan test edilir; sunucu tarafında (kapsama girerse) yeni `GET /workspaces` endpoint'i için entegrasyon testi.

## Kapsam DIŞI

- **F2-T3'ün sinyal toplama mantığı** (takvim durumu, aktif pencere başlığı, rıza akışı) — ayrı görev, zaten tamamlandı (ADR-0020), bu görev yalnızca onun bağımlı olduğu login/session temelini kurar.
- **`apps/web`'e login UI ekleme** — Mevcut Durum'da tespit edilen boşluk (`apps/web`'de de login yok) bu görevin kapsamında DEĞİL; yalnızca not olarak kayda geçiyor, ayrı bir görev/spec gerektirir.
- **OIDC/SSO** — F0-T4 (`docs/adr/ADR-0004-oidc-sso-erteleme.md`) ile bilinçli olarak ertelendi; bu görev de yalnızca mevcut email/şifre modelini tüketir, yeni bir kimlik sağlayıcısı eklemez.
- **Workspace OLUŞTURMA UI'ı** (`POST /workspaces`) — yalnızca üyelik listeleme/seçim (Açık Soru 1) kapsamda; yeni workspace kurma akışı ayrı görev.
- **Çoklu-hesap / hesap değiştirme (account switching)** — v1'de tek oturum, tek kullanıcı varsayılıyor.
- **Biyometrik/OS-native kimlik doğrulama (Windows Hello vb.)** — yalnızca email/şifre; native kimlik doğrulama entegrasyonu Faz 3'e (Sakin Yazılım/Agent Runtime bağlamında yeniden değerlendirilebilir) bırakılıyor.
- **Şifre sıfırlama / "şifremi unuttum" akışı** — sunucu tarafında da böyle bir endpoint yok; bu görev icat etmiyor.

## Açık Sorular

1. **[KRİTİK]** Workspace-seçim kapsamı: bu görev yeni bir `GET /workspaces` (kullanıcının üye olduğu tüm workspace'leri listeleme) endpoint'i eklesin mi (çok-workspace'li kullanıcılar için gerçek bir seçim ekranı), yoksa v1'de tek workspace varsayımıyla mı sınırlı kalsın (ör. kullanıcı ilk/tek üyeliğine otomatik yönlendirilir, birden fazla üyeliği varsa manuel workspace-id girişi — README'nin mevcut manuel adımının hafifletilmiş bir versiyonu)?
   - **Seçenek A:** `GET /workspaces` endpoint'i eklenir (`SessionAuthGuard` korumalı, `workspace_memberships` üzerinden kullanıcının üye olduğu tüm workspace'leri döner), masaüstünde gerçek bir "workspace seç" ekranı kurulur. Daha eksiksiz, ama sunucu-taraflı yeni bir kontrat + endpoint anlamına gelir; PR boyutunu büyütür.
   - **Seçenek B (öneri):** v1'de tek-workspace varsayımı — login sonrası kullanıcının üyeliklerinden ilkine (veya tekine) otomatik geçilir; birden fazla üyeliği olan kullanıcılar için basit bir metin-girişi/dropdown (mevcut `GET /workspaces/:workspaceId` ile doğrulanan) geçici çözüm olarak kalır. Sunucu tarafında yeni endpoint gerekmez, PR dar kapsamlı kalır, gerçek çok-workspace seçim ekranı ayrı bir gelecek görev olarak not edilir.
   - Seçenek B öneriliyor: bugün pilot kullanıcı tabanının tek-workspace olduğu varsayımı (F1'in genel pilot-ekip modeliyle tutarlı) ve bu görevin zaten "tüm monorepo'da ilk login UI'ı" olmasından kaynaklanan kapsam şişmesini sınırlama isteği gerekçe; insan onayı gerekiyor. Seçenek A seçilirse bu görev mimari-kritik eşiğini daha net geçer (yeni bir sunucu kontratı) ve ayrı bir kısa ADR'ye taşınması düşünülebilir.

2. **[KRİTİK]** Router/state-management kütüphanesi seçimi: `apps/desktop` için hangi kütüphane(ler) kurulacak — `apps/web`'in hiç router kullanmadığı (yalnızca `@tanstack/react-query`) göz önüne alındığında, bu görev kendi kararını verecek.
   - **Seçenek A:** `react-router` (veya benzeri) kurulup gerçek bir routing çözümü kurulur — login/ana uygulama arasında URL-tabanlı gezinme, gelecekteki ek ekranlara (ayarlar, rıza yönetimi vb.) genişlemeye hazır.
   - **Seçenek B (öneri):** Yeni bağımlılık yok — React'in kendi `useState`/`Context` API'siyle basit bir koşullu render (`session === null ? <Login/> : <App/>`). `apps/desktop`'ın bugünkü küçük yüzeyi (tek ekran + login) için routing kütüphanesi erken bir soyutlama; CLAUDE.md'nin "salt görünüm-katmanı kütüphane seçimleri ADR gerektirmez, plan dosyasında kısaca gerekçelendirilip doğrudan implementer'a geçilir" ilkesiyle de uyumlu — bu küçük ölçekte kütüphane eklemek yerine sade bir çözüm tercih edilir.
   - Seçenek B öneriliyor; insan onayı gerekiyor. Not: bu, salt görünüm-katmanı bir seçim olduğu için tek başına ADR gerektirmez (CLAUDE.md istisnası), ama bu görevin genelinde tanımlanan HTTP-istemci/session sözleşimi (Açık Soru 1 ile birlikte) yine de insan onayı istiyor çünkü gelecekteki ekranlar bu karara göre inşa edilecek.

3. Oturum kalıcılığı: WebView2'nin çerez deposu davranışı bu repoda doğrulanmamış — bu görev, uygulama her açıldığında `GET /me` ile "zaten giriş yapılmış mı" kontrolü yapmalı mı?
   - **Öneri: Evet.** Çerez kalıcılığına dair varsayım yapmaya gerek kalmaz — `GET /me` çağrısı ucuzdur (tek round-trip) ve hem "çerez kalıcıydı, oturum hâlâ geçerli" hem "çerez silindi/süresi doldu, login'e dön" durumlarını aynı kod yoluyla doğru şekilde ele alır. İnsan onayı gerekmiyor (düşük riskli, tersine çevrilebilir bir uygulama detayı), ama Kabul Kriterleri'nde açıkça test edilecek.

4. Register (hesap oluşturma) akışı bu görevin kapsamında mı, yoksa yalnızca login mi?
   - **Öneri: v1'de yalnızca login.** Hesap oluşturma zaten `apps/web` (veya doğrudan `POST /auth/register`) üzerinden yapılabiliyor; masaüstü uygulamasının birincil kullanım senaryosu var olan bir hesapla giriş. `http-client.ts`'e `register()` fonksiyonu yine de eklenebilir (ucuz, sözleşimi tamamlar) ama register UI'ı bu görevde zorunlu değil — insan onayı gerekiyor, kapsam netleşsin diye.

5. CSP `connect-src` boşluğu — mevcut kod zaten çalıştığından bloklayıcı değil, ama bu görev `tauri.conf.json`'a sunucu origin'ini açıkça eklemeli mi (gelecekte CSP sıkılaştırılırsa sessizce kırılmaması için), yoksa mevcut haliyle mi bırakılmalı?
   - **Öneri: Açıkça eklensin** (`connect-src 'self' ipc: http://ipc.localhost http://localhost:3000` + prod origin'i env'den), security-reviewer'ın bu görevde zaten dokunacağı bir dosya olduğundan ek maliyeti düşük; sessiz varsayıma güvenmek yerine niyeti kodda görünür kılar. İnsan onayı gerekmiyor (düşük riskli, güvenliği sıkılaştırıyor, gevşetmiyor), ama security-reviewer tarafından doğrulanmalı.

## Kabul Kriterleri

- [x] Gerçek bir login formu çalışıyor: email/şifre girişi, mevcut `POST /auth/login`'i çağırıyor, başarı/hata durumları test edildi.
- [x] Başarılı login sonrası session cookie (`sid`) webview'de kalıcı, sonraki istekler (`GET /me` dahil) kimlik doğrulamalı — ayrı bir açılış/yeniden-yükleme senaryosunda testli.
- [x] Workspace context'i (Açık Soru 1'in kararına göre) gerçek bir akıştan geliyor, `localStorage`'a manuel `setItem` çağrısı gerektirmiyor.
- [x] Uygulama açılışında `GET /me` ile mevcut oturum kontrol ediliyor (Açık Soru 3): geçerli oturumda doğrudan ana uygulama, geçersiz/yok oturumda login ekranı gösteriliyor — her iki dal da testli.
- [x] Logout çalışıyor: `POST /auth/logout` çağrılıyor, oturum durumu temizleniyor, login ekranına dönülüyor — testli.
- [x] `apps/desktop/README.md`'nin manuel smoke-test bölümü güncellendi/kaldırıldı (artık gerçek bir UI akışı var; manuel `fetch`/`localStorage.setItem` adımları birincil yol olmaktan çıktı).
- [x] Router/state-management kararı (Açık Soru 2) uygulandı ve `App.tsx`/`main.tsx` buna göre yeniden yapılandırıldı.
- [ ] N/A — Açık Soru 1'de Seçenek A değil Seçenek B (+ `GET /me` genişletmesi) seçildi, ayrı bir `GET /workspaces` endpoint'i yok.
- [x] security-reviewer: login formu (kimlik bilgisi log'lanmıyor — CLAUDE.md "kullanıcı verisini veya API anahtarını log'a yazma"), CSP değişikliği (Açık Soru 5), session cookie kullanımı denetlendi.
- [x] `pnpm typecheck && pnpm lint && pnpm test:changed` yeşil.
