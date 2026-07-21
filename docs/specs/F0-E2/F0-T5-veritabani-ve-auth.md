# F0-T5 — Veritabanı Altyapısı + Kimlik Doğrulama + Çok Kiracılılık

**Epik:** F0-E2 (Çekirdek servisler) · **Durum:** Tamamlandı
**Bağımlılık:** F0-T1..T4 tamamlandı

## Amaç

Uygulamanın kalıcı veri katmanını (PostgreSQL) kurmak ve kullanıcıların kayıt olup giriş yapabildiği, her workspace'in verisinin birbirinden yalıtıldığı temel kimlik sistemini inşa etmek.

## Kapsam

1. **Yerel geliştirme ortamı:** `docker-compose.yml` (PostgreSQL 16 + Redis); `pnpm dev` öncesi tek komutla ayağa kalkar; `README.md` güncellenir.
2. **ORM + migration altyapısı:** Drizzle ORM; `apps/server/src/db/` altında şema, migration üretme/koşma scriptleri (`pnpm db:migrate`, `pnpm db:generate`). Her migration'ın down/geri alma yolu zorunlu (CLAUDE.md kuralı).
3. **Auth:** e-posta + şifre kayıt/giriş (argon2 ile hash), httpOnly cookie tabanlı oturum, oturum yenileme ve çıkış uçları. (OIDC/SSO Faz 3'e ertelendi — ADR notu düşülür.)
4. **Çok kiracılılık:** `workspaces` + `memberships` tabloları; roller: `owner`, `admin`, `member`, `guest` (şimdilik yalnız veri modeli + basit yetki kontrol yardımcı fonksiyonu).
5. **Kiracı yalıtım middleware'i:** Her istekte oturumdan workspace bağlamı çözülür; workspace dışı veriye erişim denemeleri 403 döner.
6. **Testler:** Testcontainers ile gerçek Postgres üzerinde entegrasyon testleri (kayıt→giriş→workspace oluştur→ikinci kullanıcının erişemediğinin kanıtı).

## Kapsam DIŞI

- OIDC/SSO, şifre sıfırlama e-postası, 2FA (ileriki görevler).
- RBAC'in alan-bazlı ayrıntıları (F1-T2'de).

## Kabul Kriterleri

- [x] `docker compose up -d && pnpm db:migrate && pnpm dev` ile sistem sıfırdan ayağa kalkar.
- [x] API üzerinden kayıt + giriş + `GET /me` akışı çalışır (entegrasyon testiyle kanıtlı).
- [x] A workspace'indeki kullanıcı, B workspace'inin verisine erişemez (403) — testle kanıtlı.
- [x] Tüm migration'ların down script'i var ve `db:migrate:down` ile test edildi.
- [x] Şifreler düz metin olarak hiçbir yerde tutulmaz/loglanmaz (security-reviewer denetimi).

## Sonraki İş

security-reviewer denetiminden çıkan, bu görevin kapsamı dışında kalan ve bloklayıcı olmayan 2 bulgu — ileride ayrı görev olarak ele alınmalı:

- **E-posta enumeration (`POST /auth/register`):** Var olan e-postayla kayıt denemesi `409 ConflictError` ile e-postanın sistemde kayıtlı olduğunu doğrudan doğruluyor. Login akışında aynı sızıntıyı önlemek için zamanlama saldırısına karşı özel önlem (dummy-hash) alınmışken, register akışında bu tutarlılık yok. Karar gerekiyor: jenerik yanıt mı ("e-postanızı kontrol edin"), yoksa rate limiting mi.
- **Rate limiting eksikliği (`/auth/login`, `/auth/register`):** Hiçbir throttling yok. argon2'nin bilinçli olarak pahalı maliyeti (memoryCost 64 MiB, timeCost 3) hem başarılı hem başarısız denemelerde çalıştığından, kimliksiz bir saldırgan sınırsız sayıda tam maliyetli argon2 doğrulaması tetikleyebilir — brute-force ve CPU/bellek tükenmesi riski. `@nestjs/throttler` veya reverse-proxy/WAF seviyesinde rate limit önerilir.

## Tamamlanma Notu

- Gerçek Postgres üzerinde Testcontainers ile 4 entegrasyon testi (migration apply/rollback/re-apply + tam auth/tenant-isolation akışı) koşturuldu ve yeşil; ayrıca yerel `docker-compose.yml` yığınına karşı `db:migrate` → `db:migrate:down` → `db:migrate` döngüsü ve canlı `pnpm dev` sunucusuna karşı curl ile register→`/me` akışı manuel doğrulandı.
- Doğrulama sırasında bulunup düzeltilen 4 gerçek hata:
  1. `cookie-parser` ve global `AppErrorFilter` yalnızca `main.ts`'in `bootstrap()`'ında kuruluydu; `AppModule`'ü doğrudan inşa eden her host (ör. Nest test modülü) çerezleri hiç ayrıştıramıyordu. İkisi de `AppModule` içine taşındı (`NestModule.configure()` + `APP_FILTER`).
  2. `DbModule` kapanışta `pg.Pool`'unu kapatmıyordu (`OnModuleDestroy` yoktu); `onModuleDestroy` eklenerek `db.$client.end()` çağrılıyor.
  3. `migrate.ts`/`migrate-down.ts`'deki "ben mi ana modülüm" kontrolü Windows'ta hiçbir zaman eşleşmiyordu (`file://` string karşılaştırması sürücü harfli yollarda kayıyor) — yani **`pnpm db:migrate` Windows'ta sessizce hiçbir şey yapmıyordu**. `pathToFileURL(process.argv[1]).href` ile düzeltildi.
  4. `tsconfig.build.json`'ın `exclude` listesi `drizzle.config.ts`/`vitest.integration.config.ts`'i unutmuştu, bu da `pnpm dev`'in (`nest start --watch`) derlemesini kırıyordu.
- security-reviewer denetiminde bloklayıcı bulgu çıkmadı; kapsam dışı 2 küçük bulgu yukarıdaki "Sonraki İş" bölümüne işlendi.
