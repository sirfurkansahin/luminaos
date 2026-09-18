// F0-T9 (RED step) — @playwright/test henüz kurulu değil (apps/e2e paketinin
// `package.json`/`playwright.config.ts`'i implementer tarafından kurulacak).
// Bu dosya o zamana kadar import hatasıyla ("Cannot find package
// '@playwright/test'") kırmızı kalır — bu BEKLENEN durumdur, düzeltmeye
// çalışma.
//
// F1-T7'nin Board görünümü kabul kriterinin (bkz.
// docs/specs/F1-E2/F1-T7-list-board-table.md, "Board görünümünde bir kartı
// sürükleyip başka sütuna bırakmak, alanın değerini gerçekten değiştirir")
// şu ana kadar yalnızca birim seviyesinde kanıtlanan kısmını gerçek bir
// tarayıcıda, gerçek pointer olaylarıyla doğrular.
//
// TASARIM NOTU (test-writer sınırı): Bu görevin planı bu fixture mantığını
// ayrı `apps/e2e/fixtures/auth.ts` + `apps/e2e/fixtures/test-fixtures.ts`
// dosyalarında istiyordu. test-writer subagent'ı yalnızca `*.test.ts`/
// `*.spec.ts` dosyalarına yazabildiğinden (PreToolUse hook'u başka her yolu
// reddediyor), tüm fixture/yardımcı mantık bu tek spec dosyasında tutuldu.
// implementer, Playwright paketini kurarken bu bloğu (aşağıdaki
// "FIXTURE MANTIĞI" bölümü) davranışını DEĞİŞTİRMEDEN ayrı fixture
// dosyalarına taşıyabilir.
//
// API ROTALARI/YANITLARI — VARSAYIM DEĞİL, gerçek kaynak koddan çıkarıldı:
//  - `POST /auth/register` body `{ email, password }` (password min 8 karakter
//    — apps/server/src/auth/dto/register.schema.ts), başarıda
//    `Set-Cookie: sid=<...>; HttpOnly; ...` döner (SESSION_COOKIE_NAME='sid',
//    apps/server/src/auth/auth.controller.ts).
//  - `POST /workspaces` body `{ name }`, `sid` çerezi ile kimliklendirilir,
//    `{ workspace: { id, name, slug, createdAt } }` döner
//    (apps/server/src/workspaces/workspaces.controller.ts +
//    workspaces.service.ts). Yeni workspace otomatik olarak `task` tipi için
//    `status` (todo/doing/done) select alanını seed eder
//    (workspaces.service.ts `seedTaskFields`) — Board'un gruplayacağı alan
//    budur (bkz. apps/web/src/App.tsx `boardQuerySpec`, `group: 'status'`).
//  - `POST /workspaces/:workspaceId/objects` body `{ objectType, title }`,
//    `{ object }` döner (apps/server/src/objects/objects.controller.ts +
//    dto/create-object.schema.ts). Bu uç custom field değeri KABUL ETMEZ —
//    `status`'ü ayarlamak ayrı bir
//    `PATCH /workspaces/:workspaceId/objects/:objectId/fields` çağrısı
//    gerektirir (body `{ values: { status: '...' } }`, aynı controller'ın
//    `setFieldValues` handler'ı).
//  - `GET /workspaces/:workspaceId/objects/:objectId` -> `{ object }`
//    (`fieldValues.status` dahil) — sürükle-bırak sonrası GERÇEK veri
//    katmanını doğrulamak için kullanılıyor (yalnızca DOM'daki görsel sütun
//    konumuna güvenmek F1-T7'nin orijinal kriterinin tam karşılığı değil).
//
// DOM/testid'ler — apps/web/src/views/BoardView.tsx,
// apps/web/src/views/board/BoardColumn.tsx,
// apps/web/src/views/board/BoardCard.tsx, apps/web/src/views/ViewSwitcher.tsx
// üzerinden doğrulandı: `data-testid="board-card"` (kart kökü, tekil değil —
// başlık metniyle filtrelenmeli), `data-testid="board-card-title"` (kart
// başlığı, tıklanabilir), `data-testid="board-column"` (sütun kökü, tekil
// değil — `<h3>{groupValue}</h3>` ham `status` DEĞERini basar, `label`'ı
// DEĞİL — ör. "doing", "Sürüyor" değil), `data-testid="view-tab-board"`
// (Pano sekmesi).
//
// WORKSPACE KİMLİĞİ NOTU (bağlayıcı plan kararının İKİ önerilen mekanizmasından
// basit olanı seçildi -- build-time Vite env DEĞİL, RUNTIME URL query param):
// build-time `VITE_E2E_WORKSPACE_ID` yaklaşımı gerçek bir sıralama sorunu
// taşıyor -- Vite `import.meta.env.VITE_*`'ı dev sunucusu AÇILIRKEN bir kez
// okur, ama bu fixture'ın workspace'i yalnızca sunucu ZATEN ÇALIŞIRKEN
// (Playwright'ın webServer health-check'i geçtikten sonra) API'ye istek atarak
// oluşturulabiliyor -- yani ID, Vite'ın onu okuyabileceği andan SONRA ortaya
// çıkıyor. Bunun yerine `App.tsx`, `DEV_WORKSPACE_ID`'yi
// `new URLSearchParams(window.location.search).get('e2eWorkspaceId')`
// üzerinden RUNTIME'da (her sayfa yüklemesinde) okuyacak şekilde
// güncellenecek (implementer'ın işi) -- bu, Vite'ın kendi başlatma zamanından
// tamamen bağımsız, globalSetup'a hiç gerek yok. Bu fixture bu yüzden her
// testte taze bir kullanıcı/workspace oluşturur ve `page.goto` çağrısına
// `?e2eWorkspaceId=<workspaceId>` ekler (aşağıya bkz.).

import { test as base, expect } from '@playwright/test';

import type { Page } from '@playwright/test';

const SESSION_COOKIE_NAME = 'sid';
const API_BASE_URL = process.env['E2E_API_BASE_URL'] ?? 'http://localhost:3000';
const WEB_BASE_URL = process.env['E2E_WEB_BASE_URL'] ?? 'http://localhost:5173';

interface E2EAuthContext {
  cookie: string;
  workspaceId: string;
  apiBaseUrl: string;
}

interface CreateWorkspaceResponse {
  workspace: { id: string; name: string; slug: string; createdAt: string };
}

interface ObjectResponse {
  object: { id: string; title: string; fieldValues: Record<string, unknown> };
}

// ---------------------------------------------------------------------------
// FIXTURE MANTIĞI (implementer tarafından ayrı dosyalara taşınabilir — bkz.
// yukarıdaki "TASARIM NOTU")
// ---------------------------------------------------------------------------

/**
 * `Set-Cookie` header'ından yalnızca `sid=<value>` çiftini ayıklar —
 * `HttpOnly`/`SameSite`/`Path` gibi öznitelikler `context.addCookies`'e ayrı
 * alanlar olarak verilecek, ham header string'i olarak değil.
 */
function parseSessionCookieValue(setCookieHeader: string): string {
  const firstPair = setCookieHeader.split(';')[0] ?? '';
  const separatorIndex = firstPair.indexOf('=');
  const name = firstPair.slice(0, separatorIndex);
  const value = firstPair.slice(separatorIndex + 1);

  if (name !== SESSION_COOKIE_NAME || value.length === 0) {
    throw new Error(
      `E2E fixture: /auth/register yanıtında beklenen "${SESSION_COOKIE_NAME}" çerezi bulunamadı: ${setCookieHeader}`,
    );
  }

  return value;
}

function cookieHeaderFor(cookie: string): string {
  return `${SESSION_COOKIE_NAME}=${cookie}`;
}

/**
 * Rastgele benzersiz bir e-posta ile gerçek bir kullanıcı kaydeder, aynı
 * oturumla gerçek bir workspace oluşturur. Runtime URL-param mekanizması
 * sayesinde (dosya başı notuna bkz.) hiçbir globalSetup/önceden-pinlenmiş
 * ortam değişkenine ihtiyaç yok — her test kendi taze workspace'ini kurar.
 */
async function createE2EUserAndWorkspace(): Promise<E2EAuthContext> {
  const uniqueEmail = `e2e-${Date.now().toString()}-${Math.random().toString(36).slice(2)}@luminaos.test`;

  const registerResponse = await fetch(`${API_BASE_URL}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: uniqueEmail, password: 'e2e-test-password-123' }),
  });

  if (!registerResponse.ok) {
    throw new Error(
      `E2E fixture: POST /auth/register başarısız (${registerResponse.status.toString()}): ${await registerResponse.text()}`,
    );
  }

  const setCookieHeader = registerResponse.headers.get('set-cookie');
  if (setCookieHeader === null) {
    throw new Error('E2E fixture: /auth/register yanıtında Set-Cookie header yok.');
  }
  const cookie = parseSessionCookieValue(setCookieHeader);

  const createWorkspaceResponse = await fetch(`${API_BASE_URL}/workspaces`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookieHeaderFor(cookie),
    },
    body: JSON.stringify({ name: `E2E Workspace ${Date.now().toString()}` }),
  });

  if (!createWorkspaceResponse.ok) {
    throw new Error(
      `E2E fixture: POST /workspaces başarısız (${createWorkspaceResponse.status.toString()}): ${await createWorkspaceResponse.text()}`,
    );
  }

  const { workspace } = (await createWorkspaceResponse.json()) as CreateWorkspaceResponse;

  return { cookie, workspaceId: workspace.id, apiBaseUrl: API_BASE_URL };
}

/**
 * `POST /workspaces/:workspaceId/objects` ile bir `task` oluşturur, ardından
 * `PATCH .../:objectId/fields` ile `status` alanını istenen değere ayarlar
 * (create ucu custom field değeri kabul etmiyor — dosya başı notuna bkz.).
 */
async function createTaskWithStatus(
  auth: E2EAuthContext,
  title: string,
  status: string,
): Promise<string> {
  const createResponse = await fetch(`${auth.apiBaseUrl}/workspaces/${auth.workspaceId}/objects`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookieHeaderFor(auth.cookie),
    },
    body: JSON.stringify({ objectType: 'task', title }),
  });

  if (!createResponse.ok) {
    throw new Error(
      `E2E fixture: POST .../objects başarısız (${createResponse.status.toString()}): ${await createResponse.text()}`,
    );
  }

  const { object } = (await createResponse.json()) as ObjectResponse;

  const setStatusResponse = await fetch(
    `${auth.apiBaseUrl}/workspaces/${auth.workspaceId}/objects/${object.id}/fields`,
    {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookieHeaderFor(auth.cookie),
      },
      body: JSON.stringify({ values: { status } }),
    },
  );

  if (!setStatusResponse.ok) {
    throw new Error(
      `E2E fixture: PATCH .../fields başarısız (${setStatusResponse.status.toString()}): ${await setStatusResponse.text()}`,
    );
  }

  return object.id;
}

/** Sürükle-bırak sonrası GERÇEK veri katmanını doğrulamak için — yalnızca
 * DOM'daki görsel sütun konumuna güvenmek F1-T7'nin orijinal kabul
 * kriterinin ("alanın değerini gerçekten değiştirir") tam karşılığı değil. */
async function getObjectFieldValues(
  auth: E2EAuthContext,
  objectId: string,
): Promise<Record<string, unknown>> {
  const response = await fetch(
    `${auth.apiBaseUrl}/workspaces/${auth.workspaceId}/objects/${objectId}`,
    { headers: { Cookie: cookieHeaderFor(auth.cookie) } },
  );

  if (!response.ok) {
    throw new Error(
      `E2E fixture: GET .../objects/:objectId başarısız (${response.status.toString()}): ${await response.text()}`,
    );
  }

  const { object } = (await response.json()) as ObjectResponse;
  return object.fieldValues;
}

interface E2EFixtures {
  e2eAuth: E2EAuthContext;
  authenticatedPage: Page;
}

/**
 * `e2eAuth`: gerçek kullanıcı/workspace/oturum kurar (yukarıdaki fonksiyon),
 * ham `{ cookie, workspaceId, apiBaseUrl }`'ı teste açar — test bunu hem
 * fixture verisi oluşturmak (`createTaskWithStatus`) hem de sürükle-bırak
 * sonrası gerçek veri katmanını doğrulamak (`getObjectFieldValues`) için
 * kullanır.
 *
 * `authenticatedPage`: `e2eAuth`'ın üstüne taze bir browser context +
 * enjekte edilmiş oturum çerezi + hazır bir `Page` katar — hiçbir login/
 * register UI'sine dokunmadan (henüz böyle bir UI yok, ve bu test bir
 * auth-akışı testi değil, bir veri/etkileşim testi).
 */
const test = base.extend<E2EFixtures>({
  e2eAuth: async ({}, use) => {
    const auth = await createE2EUserAndWorkspace();
    await use(auth);
  },
  authenticatedPage: async ({ browser, e2eAuth }, use) => {
    const context = await browser.newContext();
    await context.addCookies([
      {
        name: SESSION_COOKIE_NAME,
        value: e2eAuth.cookie,
        url: WEB_BASE_URL,
        httpOnly: true,
        sameSite: 'Lax',
      },
    ]);
    const page = await context.newPage();
    await use(page);
    await context.close();
  },
});

// ---------------------------------------------------------------------------
// SENARYO
// ---------------------------------------------------------------------------

test.describe('Board görünümü — gerçek pointer sürükle-bırak (F1-T7 kabul kriteri, F0-T9 altyapısı)', () => {
  // Sayfada Board'dan ÖNCE onlarca ilgisiz panel var (entegrasyonlar, MCP
  // token'ları, webhook'lar, ajan aksiyonları, ...) -- standart 720px'lik bir
  // viewport'ta Board içeriği viewport kenarına çok yakın kalıyor, bu da
  // dnd-kit'in VARSAYILAN `autoScroll` özelliğini (pointer kenara yakınken
  // pencereyi otomatik kaydırır) sürükleme sırasında tetikliyor -- pointer
  // sabit tutulduğu her ekstra ms'de kayma birikip kartın gerçek hedeften
  // onlarca/yüzlerce piksel uzağa düşmesine yol açıyor (bkz. bu görevin
  // teşhis notları). Çok daha yüksek bir viewport, her iki sütunun da
  // kenarlardan güvenli mesafede kalmasını garanti ederek autoScroll'u hiç
  // tetiklemez.
  test.use({ viewport: { width: 1280, height: 2400 } });

  test('bir kartı başka bir sütuna sürüklemek, nesnenin status alanını API üzerinde gerçekten değiştirir', async ({
    authenticatedPage,
    e2eAuth,
  }) => {
    const todoObjectId = await createTaskWithStatus(e2eAuth, 'E2E Kartı — Yapılacak', 'todo');
    await createTaskWithStatus(e2eAuth, 'E2E Kartı — Sürüyor (dolgu)', 'doing');

    const page = authenticatedPage;
    await page.goto(`/?e2eWorkspaceId=${e2eAuth.workspaceId}`);

    await page.getByTestId('view-tab-board').click();

    const sourceCard = page.getByTestId('board-card').filter({ hasText: 'E2E Kartı — Yapılacak' });
    await expect(sourceCard).toBeVisible();

    // `<h3>{groupValue}</h3>` ham `status` DEĞERini basar ("doing"), select
    // seçeneğinin `label`'ını DEĞİL ("Sürüyor") — bkz.
    // workspaces.service.ts'nin `status` alanı seed konfigürasyonu.
    const targetColumn = page.getByTestId('board-column').filter({ hasText: 'doing' });
    await expect(targetColumn).toBeVisible();

    const sourceBox = await sourceCard.boundingBox();
    const targetBox = await targetColumn.boundingBox();
    if (sourceBox === null || targetBox === null) {
      throw new Error(
        "E2E: sürüklenecek kartın veya hedef sütunun bounding box'ı alınamadı (görünmüyor olabilir).",
      );
    }

    // dnd-kit'in `PointerSensor`'ü gerçek bir "pointer down -> birkaç ara
    // pointer move -> pointer up" dizisi bekler — Playwright'ın tek adımlı
    // `dragTo()` metodu PointerEvent-tabanlı kütüphaneleri (dnd-kit dahil)
    // güvenilir tetiklemez (bilinen topluluk sınırlaması). Ara `steps`'li
    // `mouse.move()` çağrıları, dnd-kit'in ardışık `pointermove` olaylarını
    // gerçekten görmesini sağlıyor.
    await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
    await page.mouse.down();
    // dnd-kit `onDragStart`'ta droppable'ların rect'lerini ölçer (ResizeObserver
    // tabanlı, bu yüzden en az bir render frame'i ister) -- bu ölçüm
    // tamamlanmadan hızlı ardışık `mouse.move()` çağrılarıyla devam etmek
    // `over`'ın hep `null` kalmasına (bkz. yukarıdaki `.mouse.up()` öncesi not)
    // yol açabiliyor.
    await page.waitForTimeout(100);
    await page.mouse.move(
      sourceBox.x + sourceBox.width / 2 + 15,
      sourceBox.y + sourceBox.height / 2 + 15,
      { steps: 5 },
    );
    await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, {
      steps: 10,
    });
    // dnd-kit'in `over` (hangi droppable'ın üzerinde olduğu) durumunu
    // requestAnimationFrame döngüsünde günceller -- son `mouse.move()`'dan
    // hemen sonra `mouse.up()` çağırmak bu güncellemeyi geride bırakabilir
    // (dnd-kit hâlâ `over: null` görürken bırakılır, "dropped" duyurusu
    // yapılır ama hiçbir alan değişmez). Kısa bir bekleme dnd-kit'in bir sonraki
    // frame'de hedef sütunu `over` olarak işaretlemesine izin veriyor.
    await page.waitForTimeout(150);
    await page.mouse.up();

    // Yalnızca DOM'daki görsel taşımaya değil, gerçek veri katmanına
    // (apps/server'ın event-sourced projeksiyonuna) bakılıyor — `setFieldValues`
    // mutasyonu asenkron olduğundan `expect.poll` ile bekleniyor.
    await expect
      .poll(
        async () => {
          const fieldValues = await getObjectFieldValues(e2eAuth, todoObjectId);
          return fieldValues['status'];
        },
        { message: 'nesnenin status alanı sürükle-bırak sonrası "doing" olmalı' },
      )
      .toBe('doing');
  });
});
