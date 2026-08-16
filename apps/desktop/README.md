# apps/desktop

LuminaOS masaüstü uygulaması — Tauri 2 + React + Vite. Mimari genel bakış için `docs/adr/ADR-0019-tauri-cekirdek-secimi.md`, masaüstü sinyal toplayıcıları için `docs/adr/ADR-0020-masaustu-sinyal-toplayicilar.md`'ye bakın.

## Geliştirme

```
pnpm --filter @luminaos/desktop dev
```

`vite.config.ts`, ADR-0019'un `tauri.conf.json` `devUrl`'üne sabitlenmiş `http://localhost:1420` dev sunucusunu başlatır. Tauri kabuğunu birlikte çalıştırmak için `pnpm dev:desktop` (kök script) kullanılabilir.

## Manuel smoke-test — oturum ve workspace (F2-T3 PR4)

**Önemli:** `apps/desktop`'ta henüz gerçek bir login/oturum-açma veya workspace-seçim arayüzü YOK — bu, F2-T3b'ye ertelenmiş ayrı bir görevdir. Bu bölümdeki adımlar YALNIZCA geliştirme/manuel test amaçlıdır; hiçbiri üretim akışının parçası değildir.

`apps/desktop`'ın HTTP istemcisi (`src/api/http-client.ts`), `apps/web` ile aynı httpOnly session-cookie mekanizmasını kullanır (`credentials: 'include'`) — ama bu cookie'yi kendi başına ÜRETMEZ, sadece MEVCUT bir oturumu taşır. Masaüstü webview'i tarayıcıdan bağımsız kendi çerez deposuna sahiptir, bu yüzden `apps/web`'de açtığınız bir oturum otomatik olarak masaüstü webview'ine taşınmaz — aşağıdaki adımlarla webview içinden ayrıca giriş yapmanız gerekir.

1. **Sunucuyu ve masaüstü dev sunucusunu başlatın** (`pnpm dev` ile `apps/server`'ı, `pnpm --filter @luminaos/desktop dev` veya `pnpm dev:desktop` ile masaüstünü).
2. **Webview'in kendi devtools'unu açın** (Tauri dev modda genelde sağ tık → "Inspect Element" veya platform kısayolu).
3. **Konsoldan gerçek bir test kullanıcısıyla giriş yapın** — bu istek webview'in KENDİ çerez deposuna session cookie'sini yazar:

   ```js
   await fetch('http://localhost:3000/auth/login', {
     method: 'POST',
     headers: { 'Content-Type': 'application/json' },
     credentials: 'include',
     body: JSON.stringify({ email: '<test-kullanicisi-email>', password: '<sifre>' }),
   });
   ```

4. **`workspaceId`'yi `localStorage`'a yazın** — `src/workspace-context.ts`'in `getWorkspaceId()`'si bu anahtarı okur, başka hiçbir kaynağı değil:

   ```js
   localStorage.setItem('luminaos.workspaceId', '<gercek-workspace-id>');
   ```

5. Bundan sonra uygulamanın HTTP istemcisi (`credentials: 'include'` ile giden her istek) oturumu otomatik olarak taşır — rıza (consent) anahtarları (`src/consent/ConsentSettings.tsx`) ve sinyal toplayıcılar (`src/signals/active-window-poller.ts`, `src/signals/calendar-status-poller.ts`) artık gerçek bir workspace'e karşı çalışabilir.

Gerçek login/workspace-seçim arayüzü F2-T3b'de eklenecek; o zamana kadar yukarıdaki adımlar her dev-modu yeniden başlatmada tekrarlanmalıdır (webview'in `localStorage`'ı ve çerez deposu kalıcıdır, ancak farklı bir profil/temiz başlangıçta sıfırlanabilir).

## CORS

`apps/server`'ın `corsMiddleware`'i (`apps/server/src/common/cors.middleware.ts`), `env.webOrigin` (varsayılan `http://localhost:5173`, `apps/web`) ve `env.desktopOrigin` (varsayılan `http://localhost:1420`, bu paket) origin'lerini ayrı ayrı allowlist'e alır — jokerli (`*`) bir origin asla döndürülmez. `DESKTOP_ORIGIN` ortam değişkeniyle geçersiz kılınabilir.
