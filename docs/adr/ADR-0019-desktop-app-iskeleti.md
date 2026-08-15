# ADR-0019: `apps/desktop` Uygulama İskeleti — Framework, Frontend, Paket Yapısı, CI, IPC Güvenlik Modeli

**Durum:** Kabul edildi
**Tarih:** 2026-08-15
**İlgili görev:** [F2-T2b — `apps/desktop` Uygulama İskeleti Kurulumu](../specs/F2-E1/F2-T2b-desktop-app-iskeleti.md)
**İlgili plan referansı:** `docs/PLAN.md` §2.1 "Önerilen Yığın" (satır 50-51, masaüstü kabuk + frontend önerisi) ve §2.2 "Monorepo Yapısı" (satır 73, `apps/desktop/ # Tauri kabuğu`) ve CLAUDE.md "ADR Ne Zaman Gerekir" maddesinin **(b)** fıkrası bu kararı tetikliyor — `apps/desktop` yalnızca F2-T3'e (masaüstü sinyal toplayıcılar) değil, Faz 3'ün birden fazla vizyonuna (Agent Runtime, Ambient Intelligence, Sakin Yazılım) dayatılan bir temel; framework/frontend/IPC seçimi bu görevlerin tümüne dayatılan bir sözleşim. Karar ikincil olarak **(a)** fıkrasıyla da gerilir: IPC güvenlik modeli (Karar e) CLAUDE.md'nin doğrudan bir mimari değişmezi olmasa da güvenlik disiplinini (en az ayrıcalık) somutlaştırıyor ve F2-T3'ün rıza modeli netleşmeden hiçbir native/OS-seviyesi yüzeyin açılmamasını garanti altına alıyor.

> `docs/PLAN.md` §2.1 bugüne kadar "Masaüstü kabuk: Tauri (Rust) — düşük bellek, OS API erişimi, güvenli IPC" öneriyordu, ama bu bağlayıcı olmayan bir plan-notuydu. Bu ADR o öneriyi resmi bir mimari karara çevirir: framework Tauri, Electron reddedildi. Kullanıcı bu yönü açıkça tercih ediyor; PLAN.md'nin kendi önerisi zaten yeterli gerekçe, yeni bir gerekçe icat edilmiyor.
>
> Karar ayrıca dört ikincil ama bağlayıcı sözleşim sabitliyor: (1) frontend katmanı React + `packages/ui`'nin yeniden kullanımı, workspace-linking gerçek bir import ile kanıtlanır; (2) paket/dizin yapısı F0-T1'in `apps/server`/`apps/web` şablonunu izler (`@luminaos/desktop`, kök `tooling/` tsconfig extend); (3) CI'ye Windows-only bir `desktop-build` job'u eklenir — yalnızca `cargo build` değil, mevcut Node-taraflı `quality` job'unun lint/typecheck gate'ine denk bir Rust-taraflı kalite kapısı (`cargo clippy -- -D warnings` + `cargo fmt --check`), zorunlu (required) check olarak; (4) IPC allowlist v1'de tamamen kapalı — sıfır native komut, en az ayrıcalık ilkesi F2-T3'ün rıza modeli netleşene kadar korunuyor.
>
> Bu ADR, F2-T3'ün ve Faz 3'ün Agent Runtime/Ambient Intelligence/Sakin Yazılım vizyonlarının üzerine inşa edeceği masaüstü temelini — framework, frontend, dizin yapısı, CI kalite kapısı ve IPC güvenlik sınırını — koddan önce sabitliyor.

## Bağlam

`apps/desktop` bugün tamamen yok — dizin, dosya, hiçbir şey. F0-T1 (monorepo iskeleti) desktop'ı bilinçli olarak kapsam dışı bırakmıştı ("Desktop (Tauri) ve mobile uygulamaları — sonraki görevler"), ama `apps/server` (NestJS) ve `apps/web` (Vite+React) için kurduğu iskelet deseni (`package.json` + `tsconfig.json` + minimal "merhaba dünya" + kök script'lere bağlanma, `@luminaos/<paket>` adlandırması) bu görevin izleyeceği referans şablon. `pnpm-workspace.yaml` yalnızca `apps/*`/`packages/*`/`tooling/*` glob'larını tanımlıyor — `apps/*` glob'u yeni `apps/desktop` klasörünü otomatik kapsıyor, workspace dosyasında değişiklik gerekmiyor.

F0-T3, `.github/workflows/ci.yml` içinde `quality` (checkout → pnpm/node setup → turbo cache → install → lint → typecheck → test → build, `ubuntu-latest`), `security` (gitleaks + `pnpm audit --audit-level critical`, `ubuntu-latest`), `ai-eval` (golden-set regresyon, `ubuntu-latest`), `pr-size-guard` (diff satır uyarısı) job'larını kurdu — bugüne kadar tamamen Node.js/pnpm öncelikli; Rust toolchain gerektiren bir adım henüz yok.

Keşif üç bulguyu doğruladı:

1. **`apps/web`'in şablonu somut ve tekrarlanabilir.** `apps/web/package.json`: `name: "@luminaos/web"`, `scripts: {dev, build, typecheck: "tsc --noEmit", test: "vitest run", lint: "eslint ."}`, `dependencies` içinde `@luminaos/core-objects`/`@luminaos/shared`/`@luminaos/ui` için `"workspace:*"` protokolü. `apps/web/tsconfig.json` yalnızca `{"extends": "../../tooling/tsconfig/react.json", "include": [...]}`. `apps/desktop/src/` bu deseni birebir izleyebilir (React frontend tarafı için).
2. **`tooling/tsconfig/` üç hazır konfig taşıyor:** `base.json`, `node.json`, `react.json`. `apps/desktop/tsconfig.json`, frontend React kodu içerdiği için `tooling/tsconfig/react.json`'ı extend eder — `apps/web` ile aynı desen.
3. **CI'nin mevcut `quality` job'u yalnızca Node/pnpm kurulumu yapıyor, Rust toolchain'i yok.** Yeni bir Rust-taraflı iş, mevcut job'a gömülürse (aynı job içine adım eklenirse) hem gereksiz bir `actions-rs`/`rustup` kurulumu tüm Node-only PR'ları yavaşlatır hem de F0-T3'ün `<5 dakika` CI süre hedefini riske atar — bu yüzden ayrı, paralel bir job gerekiyor.

Çözülmesi gereken merkezi sorular: (1) framework (Tauri vs Electron); (2) frontend katmanı ve `packages/ui` yeniden kullanımı; (3) paket/dizin yapısı; (4) CI platform kapsamı ve Rust kalite kapısı; (5) IPC güvenlik modeli; (6) minimal uygulamanın kapsamı.

## Karar

### (a) Framework — Tauri, Electron REDDEDİLDİ

`docs/PLAN.md:50` zaten "Masaüstü kabuk: Tauri (Rust) — düşük bellek, OS API erişimi, güvenli IPC" öneriyordu. Bu ADR o öneriyi bağlayıcı hale getirir.

**Karar:** Tauri. Rust tarafı `apps/desktop/src-tauri/` altında (`Cargo.toml`, `tauri.conf.json`, minimal `main.rs`), web frontend tarafı `apps/desktop/src/` altında (React) — Tauri'nin standart proje düzeni.

**Electron reddedildi:** daha yüksek bellek/paket boyutu ayak izi taşır ve PLAN.md'nin zaten önerdiği yönle çelişir. PLAN.md'nin kendi önerisi (düşük bellek, Rust-tabanlı güvenli IPC, OS API erişimi) bu kararı gerekçelendirmek için yeterli — F2-T3'ün OS-seviyesi sinyal toplama ihtiyacı (aktif pencere başlığı, takvim durumu) düşük ayak izli, native-yakın bir kabuk gerektiriyor, yeni bir karşı-gerekçe icat edilmiyor.

### (b) Frontend katmanı — React + `packages/ui`'nin yeniden kullanımı

`docs/PLAN.md:51` ("Frontend: React + TanStack Query/Router, tasarım sistemi paketi") ile tutarlı. `apps/desktop/src/` içinde React kullanılır. `apps/web`'in Vite kurulumuyla paralel gidilir — aynı `tooling/tsconfig/react.json` extend edilir, `apps/web/package.json`'daki `dev`/`build`/`typecheck`/`test`/`lint` script kalıbı birebir kopyalanır (Tauri'nin kendi `tauri dev`/`tauri build` komutları frontend'in Vite dev-server'ını sarmalar).

**Karar:** `apps/desktop/package.json`'ın `dependencies`'inde `@luminaos/ui: "workspace:*"` (ve gerekirse `@luminaos/shared: "workspace:*"`) tanımlanır; `apps/desktop/src/` içinden `packages/ui`'den gerçek bir bileşen/yardımcı import edilip kullanılarak workspace-linking kanıtlanır — spec'in Kabul Kriteri #6'nın karşılığı. Ayrı bir Vite config icat edilmez; `apps/web/vite.config.ts` deseni Tauri'nin beklediği `@tauri-apps/cli` dev-server entegrasyonuna (sabit port, `TAURI_DEV_HOST` ortam değişkeni) uyacak şekilde uyarlanır.

### (c) Paket/dizin yapısı

```
apps/desktop/
├── src-tauri/          # Rust: Cargo.toml, tauri.conf.json, src/main.rs
├── src/                # React frontend: main.tsx, App.tsx
├── package.json        # name: "@luminaos/desktop"
└── tsconfig.json        # extends "../../tooling/tsconfig/react.json"
```

**Karar:**

- `apps/desktop/package.json` adı `@luminaos/desktop` — F0-T1'in `@luminaos/<paket>` konvansiyonu.
- `apps/desktop/tsconfig.json`, `apps/web/tsconfig.json` ile aynı desen: `{"extends": "../../tooling/tsconfig/react.json", "include": ["src", "vite.config.ts", ...]}`, strict mode `tooling/tsconfig/base.json`'dan miras (F0-T2 ile tutarlı).
- `pnpm-workspace.yaml` değişikliği GEREKMİYOR — `apps/*` glob'u zaten `apps/desktop`'ı kapsıyor.
- `apps/desktop/src-tauri/Cargo.toml`, Rust tarafının kendi bağımlılık yönetimini taşır (pnpm workspace'in parçası değil, ama aynı dizin altında yaşar — Tauri'nin standart konvansiyonu).

### (d) Minimal çalışan uygulama

F0-T1'in `apps/web`/`apps/server` için uyguladığı "yalnız iskelet, gerçek iş mantığı yok" ilkesiyle tutarlı: boş bir pencere açılıp kapanabilen, "merhaba dünya" seviyesinde bir Tauri uygulaması. `packages/ui`'den import edilen bileşen bu boş pencere içinde render edilerek hem "merhaba dünya" hem workspace-linking kanıtı tek ekranda birleşir.

### (e) CI platform kapsamı — Windows-only v1 + Rust-taraflı lint/format kapısı

Rust toolchain kurulumu CI'de YALNIZCA Windows runner'ında yapılır — geliştirici ortamıyla tutarlı (bu repo Windows üzerinde geliştiriliyor), F0-T3'ün CI süre hedefini (`<5 dakika`) riske atmaz. Mac/Linux matrisi bu ADR'nin kapsamında DEĞİL — auto-update/dağıtım görevine ertelenir. Mevcut Node.js-öncelikli `quality`/`security`/`ai-eval`/`pr-size-guard` job'ları (hepsi `ubuntu-latest`) ETKİLENMEMELİ.

**Karar:** `.github/workflows/ci.yml`'e yeni, PARALEL bir job eklenir:

```yaml
desktop-build:
  name: desktop-build
  runs-on: windows-latest
  permissions:
    contents: read
  steps:
    - name: Checkout
      uses: actions/checkout@<pinned-sha> # mevcut job'larla aynı pinned sürüm

    - name: Setup pnpm
      uses: pnpm/action-setup@<pinned-sha>

    - name: Setup Node
      uses: actions/setup-node@<pinned-sha>
      with:
        node-version-file: .nvmrc
        cache: pnpm

    - name: Setup Rust
      uses: dtolnay/rust-toolchain@<pinned-sha-or-tag>
      with:
        toolchain: stable
        components: clippy, rustfmt

    - name: Cache cargo
      uses: actions/cache@<pinned-sha>
      with:
        path: |
          apps/desktop/src-tauri/target
          ~/.cargo/registry
        key: cargo-${{ runner.os }}-${{ hashFiles('apps/desktop/src-tauri/Cargo.lock') }}

    - name: Install dependencies
      run: pnpm install --frozen-lockfile

    - name: Rust fmt check
      working-directory: apps/desktop/src-tauri
      run: cargo fmt --check

    - name: Rust clippy
      working-directory: apps/desktop/src-tauri
      run: cargo clippy -- -D warnings

    - name: Build desktop app
      run: pnpm --filter @luminaos/desktop build
```

Bu job **yalnızca `cargo build` çalıştırmaz** — `cargo clippy -- -D warnings` VE `cargo fmt --check` adımlarını İÇERİR, mevcut Node tarafındaki `pnpm lint`/`typecheck` gate'ine Rust-taraflı DENK (parity) bir kalite kapısı olarak.

**Gerekçe:** CLAUDE.md'nin Tanım-of-Done'ı repodaki HER paket için lint+typecheck yeşilliğini şart koşuyor; bu adım olmadan `src-tauri/` hiçbir statik analiz kapısından geçmeyen tek yüzey olarak kalırdı ve F2-T3'ün üzerine inşa edeceği temel bu boşlukla başlamış olurdu. `clippy`/`fmt` kırmızıysa `desktop-build` job'u da kırmızı olmalı — diğer job'lar gibi merge'i engeller. Bu job GitHub branch-protection'da zorunlu/required check olarak işaretlenmeli (`docs/runbooks/branch-korumasi.md`'nin mevcut deseniyle tutarlı — F0-T3'ün diğer required check'leriyle aynı muamele).

`pr-size-guard` ve `ai-eval` job'ları değişmez; `desktop-build` bunlardan bağımsız, paralel çalışır.

### (f) IPC güvenlik modeli — v1'de tamamen kapalı allowlist

Hiçbir native Tauri komutuna (`#[tauri::command]`) izin verilmez — iskelet SIFIR-komut bir allowlist ile gelir. `apps/desktop/src-tauri/tauri.conf.json`'daki `allowlist`/capabilities yapılandırması en kısıtlı haliyle kurulur (Tauri'nin capability sisteminde hiçbir plugin/komut izni açılmaz; yalnızca pencere oluşturma/yaşam-döngüsü için gereken minimum çekirdek izin kalır).

**Karar:** F2-T3, kendi ihtiyaç duyduğu komutları (ör. `get_active_window`) kendi PR'ında, kendi security-review'ıyla, kendi rıza/yerinde-işleme modeli netleştikten SONRA ekleyecek — bu ADR o komutları ÖNCEDEN yer tutucu olarak eklemez. IPC çağırma paterni (Tauri `invoke()` frontend'den, `#[tauri::command]` Rust'ta) yalnızca kod-yorum/iskelet düzeyinde belgelenir, gerçek bir komut kaydedilmez.

**Gerekçe:** en az ayrıcalık ilkesi (CLAUDE.md güvenlik disiplini) — F2-T3'ün rıza modeli netleşmeden hiçbir native/OS-seviyesi yüzey açılmamalı. Bu, `security-reviewer`'ın spec Kabul Kriteri #8'inde ("Tauri allowlist/IPC yüzeyinin en az ayrıcalık ilkesine uyduğu denetlendi") kolayca doğrulayabileceği, minimal bir saldırı yüzeyi bırakır.

## Alt-PR ayrıştırması

Mimari-kritik görev — CLAUDE.md'nin ±400 satır rehberliğine tabi. Spec'in kapsamı (framework kurulumu + CI job'u + IPC iskeleti) tek bir bütünsel iskelet PR'ı olarak ele alınabilir çünkü alt-parçalar birbirinden bağımsız çalışmaz (CI job'u `apps/desktop` var olmadan test edilemez, `apps/desktop` CI'siz merge edilirse Rust tarafı denetimsiz kalır) — ama satır bütçesi zorlanırsa iki alt-PR'a bölünebilir:

- **PR1 — paket iskeleti:** `apps/desktop/src-tauri/` (Cargo.toml, tauri.conf.json, main.rs — sıfır komut), `apps/desktop/src/` (React, `packages/ui` import kanıtı), `apps/desktop/package.json`, `apps/desktop/tsconfig.json`.
- **PR2 — CI entegrasyonu:** `.github/workflows/ci.yml`'e `desktop-build` job'u (Karar e), `docs/runbooks/branch-korumasi.md` güncellemesi (yeni required check notu).

F2-T3'ün kendi sinyal toplama mantığı, gerçek UI/UX tasarımı, `apps/mobile`, auto-update/dağıtım/code-signing, F2-E2 (Memory Passport), yerel SQLite+CRDT (Yjs) senkron motoru entegrasyonu KAPSAM DIŞI.

## Alternatifler ve Reddedilme Gerekçeleri

- **Electron.** Reddedildi — Karar (a)'ya göre; daha yüksek bellek/paket boyutu ayak izi, PLAN.md'nin zaten önerdiği (ve kullanıcının tercih ettiği) yönle çelişir. Yeni bir karşı-gerekçe gerektirmiyor, PLAN.md'nin kendi önerisi yeterli.
- **Rust CI kalite kapısını mevcut `quality` job'una gömmek (ayrı job açmamak).** Reddedildi — Karar (e)'ye göre; Rust toolchain kurulumu tüm Node-only PR'ları (ör. salt `packages/shared` değişikliği) gereksiz yere yavaşlatır ve F0-T3'ün `<5 dakika` hedefini riske atar; paralel, bağımsız bir job hem izolasyon hem de hız sağlıyor.
- **Yalnızca `cargo build` çalıştırıp `clippy`/`fmt`'i atlamak.** Reddedildi — Karar (e)'ye göre; CLAUDE.md'nin Tanım-of-Done'ı her paket için lint+typecheck paritesini şart koşuyor, `src-tauri/` bu paritenin dışında bırakılamaz.
- **Mac/Linux'u da CI matrisine eklemek (v1'de tam platform kapsamı).** Reddedildi — Karar (e)'ye göre; kullanıcı kararı v1'i Windows-only'e sınırlıyor, CI süresini ve karmaşıklığını F2-T3 öncesinde büyütmemek için erteleniyor.
- **F2-T3'ün ihtiyaç duyacağı komutları (`get_active_window` vb.) gövdesiz yer tutucu olarak şimdiden allowlist'e eklemek.** Reddedildi — Karar (f)'ye göre; en az ayrıcalık ilkesi, F2-T3'ün rıza/yerinde-işleme modeli netleşmeden hiçbir native yüzeyin — boş gövdeli olsa bile — önceden açılmamasını gerektiriyor.

## Sonuçlar / Ödünler

**Şimdi ne kazanıyoruz:**

- Framework kararı (Tauri) ilk kez bağlayıcı bir ADR ile sabitleniyor — PLAN.md'nin bugüne kadar bağlayıcı olmayan notu artık F2-T3'ün ve Faz 3'ün üzerine inşa edeceği resmi bir temel.
- `apps/web`'in kanıtlanmış paket/tsconfig deseni yeniden kullanılıyor — yeni bir iskelet konvansiyonu icat edilmiyor, F0-T1/F0-T2 ile tutarlılık korunuyor.
- `src-tauri/`, ilk gününden itibaren Node tarafındaki lint/typecheck gate'ine denk bir statik analiz kapısına (`clippy`+`fmt`) sahip oluyor — CLAUDE.md'nin Tanım-of-Done paritesi Rust tarafında da baştan kuruluyor.
- IPC yüzeyi sıfır-komut başlıyor — F2-T3'ün rıza modeli netleşmeden hiçbir native/OS-seviyesi erişim mümkün değil, en az ayrıcalık ilkesi koddan önce garanti altına alınıyor.

**Neyi erteliyoruz / kabul ediyoruz:**

- CI'de yalnızca Windows runner'ı test ediliyor — Mac/Linux derleme regresyonları v1'de yakalanmaz; bu, dağıtım/CD görevine kadar bilinçli kabul edilmiş bir sınır.
- IPC allowlist'in gerçek komutlarla doldurulması tamamen F2-T3'e erteleniyor — bu ADR yalnızca çağırma paternini (iskelet düzeyinde) belgeliyor, hiçbir gerçek OS entegrasyonu sağlamıyor.
- Yerel SQLite+CRDT (Yjs) senkron motoru entegrasyonu bu ADR'nin kapsamı dışında kalmaya devam ediyor — PLAN.md §2.1'de bahsi geçse de ayrı bir görev gerektiriyor.
- Rust `Cargo.lock`/bağımlılık güvenlik taraması (Rust tarafının kendi `cargo audit`'i) bu ADR'de ele alınmadı — yalnızca `clippy`/`fmt` kalite kapısı kuruluyor, güvenlik açığı taraması (Node tarafındaki `pnpm audit`'in Rust dengi) ayrı bir kararla ele alınabilir.
