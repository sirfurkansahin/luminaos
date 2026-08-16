# apps/desktop

LuminaOS masaüstü uygulaması — Tauri 2 + React + Vite. Mimari genel bakış için `docs/adr/ADR-0019-tauri-cekirdek-secimi.md`, masaüstü sinyal toplayıcıları için `docs/adr/ADR-0020-masaustu-sinyal-toplayicilar.md`'ye bakın.

## Geliştirme

```
pnpm --filter @luminaos/desktop dev
```

`vite.config.ts`, ADR-0019'un `tauri.conf.json` `devUrl`'üne sabitlenmiş `http://localhost:1420` dev sunucusunu başlatır. Tauri kabuğunu birlikte çalıştırmak için `pnpm dev:desktop` (kök script) kullanılabilir.

## Oturum ve workspace (F2-T3b)

`apps/desktop` artık gerçek bir login/oturum akışına sahip (`src/auth/`): uygulama açılışında `GET /me` ile mevcut oturum kontrol edilir (`src/auth/SessionContext.tsx`); oturum yoksa `src/auth/Login.tsx` gösterilir, `apps/server`'ın mevcut `POST /auth/login` / `POST /auth/logout` endpoint'lerini (`src/api/http-client.ts`'in `login`/`logout`/`getMe` fonksiyonları) `credentials: 'include'` ile çağırır. Workspace context'i (`src/workspace-context.ts`) artık gerçek bu akıştan besleniyor: `GET /me`'nin döndürdüğü `workspaces` listesi tek üyelikliyse otomatik seçilir, birden fazlaysa `src/auth/WorkspacePicker.tsx` ile elle seçilir (bkz. `docs/specs/F2-E1/F2-T3b-desktop-login-session.md`, Açık Soru 1 — v1 tek-workspace varsayımı, ayrı bir `GET /workspaces` endpoint'i yok).

1. **Sunucuyu ve masaüstü dev sunucusunu başlatın** (`pnpm dev` ile `apps/server`'ı, `pnpm --filter @luminaos/desktop dev` veya `pnpm dev:desktop` ile masaüstünü).
2. **Uygulama açıldığında** login ekranı görünür (mevcut bir oturum yoksa); bir test kullanıcısının email/şifresiyle giriş yapın.
3. Giriş başarılıysa, tek workspace üyeliği varsa doğrudan ana uygulamaya geçilir; birden fazla üyelik varsa bir workspace seçim ekranı gösterilir.
4. Ana uygulamadaki "Çıkış yap" aksiyonu `POST /auth/logout`'u çağırır, oturumu temizler ve login ekranına döner.

Masaüstü webview'i tarayıcıdan bağımsız kendi çerez deposuna sahiptir, bu yüzden `apps/web`'de açtığınız bir oturum otomatik olarak masaüstü webview'ine taşınmaz — yukarıdaki login ekranından ayrıca giriş yapmanız gerekir.

### Acil durum / otomasyon testleri için manuel enjeksiyon (ikincil yol)

Yukarıdaki gerçek UI akışı birincil yoldur. Aşağıdaki adımlar yalnızca otomasyon testleri veya webview devtools'undan hızlı bir manuel doğrulama gerektiğinde kullanılır — normal geliştirme akışının parçası değildir:

```js
// 1. Webview'in KENDİ çerez deposuna session cookie'si yazar:
await fetch('http://localhost:3000/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  credentials: 'include',
  body: JSON.stringify({ email: '<test-kullanicisi-email>', password: '<sifre>' }),
});

// 2. workspace-context.ts'in setWorkspaceId()'sinin yazdığı anahtarı elle set eder:
localStorage.setItem('luminaos.workspaceId', '<gercek-workspace-id>');
```

## CORS

`apps/server`'ın `corsMiddleware`'i (`apps/server/src/common/cors.middleware.ts`), `env.webOrigin` (varsayılan `http://localhost:5173`, `apps/web`) ve `env.desktopOrigin` (varsayılan `http://localhost:1420`, bu paket) origin'lerini ayrı ayrı allowlist'e alır — jokerli (`*`) bir origin asla döndürülmez. `DESKTOP_ORIGIN` ortam değişkeniyle geçersiz kılınabilir.
