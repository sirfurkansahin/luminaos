# F2-T2b — `apps/desktop` Uygulama İskeleti Kurulumu

**Epik:** F2-E1 (Lumina Context Fabric) · **Durum:** Tamamlandı — ADR-0019 (#121), implementasyon PR (bkz. commit geçmişi)
**Bağımlılık:** F0-T1 (monorepo + paket iskelet deseni), F0-T2 (ortak lint/format/tsconfig kuralları), F0-T3 (CI boru hattı)

> ⚠️ MİMARİ-KRİTİK GÖREV: `apps/desktop` yalnızca F2-T3'e (masaüstü sinyal toplayıcılar) değil, Faz 3'ün birden fazla vizyonuna (Agent Runtime, Ambient Intelligence, Sakin Yazılım) dayatılan bir temel — CLAUDE.md'nin ADR kriteri (b)'ye ("birden fazla pakete veya gelecekteki görevlere dayatılan bir sözleşim tanımlıyorsa") tam giriyor. `docs/PLAN.md` §2.1 masaüstü kabuk için Tauri'yi öneriyor ama bu bugüne kadar bağlayıcı olmayan bir plan-notu; bu görev, framework seçimini, frontend katmanını, IPC/güvenlik modelini ve CI entegrasyonunu resmi bir ADR ile sabitler — architect taslağı + insan onayı, koddan önce. Sıfırdan app iskeleti + framework + build/paketleme kendi başına büyük bir iş; dar kapsamlı sinyal-toplama görevinin (F2-T3) PR'ına sığdırılmaz, bilinçli olarak ayrı bir görev olarak açıldı.

## Amaç

`apps/desktop` altında, F2-T3'ün üzerine inşa edeceği çalışan, derlenebilir, paketlenebilir bir masaüstü uygulama iskeleti kurmak: framework seçimi (Tauri) ADR ile sabitlenir, monorepo konvansiyonlarına (F0-T1/F0-T2/F0-T3) uyar, `packages/ui`/`packages/shared`'dan gerçek bir import ile workspace-linking kanıtlanır, ve minimal bir IPC deseni yer tutucu olarak kurulur. Gerçek OS-seviyesi sinyal toplama mantığı bu görevin kapsamında DEĞİL.

## Mevcut Durum

- **`apps/desktop` bugün tamamen yok.** Dizin, dosya, hiçbir şey — repo genelinde sıfır sonuç.
- **`pnpm-workspace.yaml`** (kök) yalnızca `apps/*`, `packages/*`, `tooling/*` glob'larını tanımlıyor; masaüstüne özel bir giriş yok, ama `apps/*` glob'u yeni bir `apps/desktop` klasörünü otomatik kapsayacak — workspace dosyasında değişiklik gerekmiyor.
- **F0-T1** (`docs/specs/F0-E1/F0-T1-monorepo-kurulumu.md`), desktop'ı bilinçli olarak "Kapsam DIŞI" bırakmıştı ("Desktop (Tauri) ve mobile uygulamaları — sonraki görevler"), ama `apps/server` (NestJS) ve `apps/web` (Vite+React) için kurduğu iskelet deseni (package.json + tsconfig.json + minimal "merhaba dünya" + kök script'lere bağlanma) bu görevin izleyeceği referans şablon.
- **F0-T3** (`docs/specs/F0-E1/F0-T3-ci-boru-hatti.md`) `.github/workflows/ci.yml` içinde `quality` (lint→typecheck→test→build), `security` (gitleaks + `pnpm audit`), `pr-size-guard` job'larını kurdu — bugüne kadar tamamen Node.js/pnpm öncelikli; Rust toolchain gerektiren bir iş adımı henüz yok.
- **`docs/PLAN.md` §2.1** (satır 47-57): "Masaüstü kabuk: Tauri (Rust) — düşük bellek, OS API erişimi, güvenli IPC" ve "Frontend: React + TanStack Query/Router, tasarım sistemi paketi (`packages/ui`)" öneriliyor. **§2.2** (satır 59-93) monorepo ağacında `apps/desktop/ # Tauri kabuğu` olarak gösteriyor. Bu görev bu plan-notunu bağlayıcı bir mimari karara çevirir.
- **`packages/ui`** ve **`packages/shared`** F0-T1'den beri var ve `apps/web`/`apps/server` tarafından zaten tüketiliyor — bu görev, `apps/desktop`'ın da aynı workspace-linking deseniyle bunlardan gerçek bir import yapabildiğini kanıtlamalı.
- **F2-T3** (`docs/specs/F2-E1/F2-T3-*.md`) henüz yazılmadı; bu görev tamamlandığında F2-T3'ün spec'i bu görevi bağımlılık olarak referans alacak şekilde güncellenmeli (bkz. Kabul Kriterleri).

## Kapsam

1. **Framework kararı ve ADR:** `docs/PLAN.md`'nin Tauri önerisini architect subagent ile bir ADR taslağında (beklenen numara: `ADR-0019`, `docs/adr/` içindeki mevcut son numara `ADR-0018` — architect yazarken teyit etsin) Seçenek A (Tauri, öneri) olarak sabitler; insan onayından önce kod yazılmaz.
2. **Yeni `apps/desktop` paketi:**
   - `apps/desktop/src-tauri/` — Rust tarafı (Tauri kabuğu, Cargo.toml, `tauri.conf.json`).
   - `apps/desktop/src/` — web frontend tarafı (React, `packages/ui`'yi yeniden kullanan, PLAN.md §2.1 ile tutarlı).
   - `apps/desktop/package.json`, `apps/desktop/tsconfig.json` — F0-T1'in `apps/server`/`apps/web` şablonunu izler; `tsconfig.json` kök `tooling/` konfigini extend eder, strict mode açık.
3. **`pnpm-workspace.yaml`'a otomatik dahil olma:** `apps/*` glob'u zaten kapsıyor, workspace dosyasında değişiklik gerekmiyor; ama `package.json`'da paket adı `@luminaos/desktop` konvansiyonunu izler (F0-T1 Notlar: "Paket adlandırma: `@luminaos/<paket>`").
4. **Lint/format:** F0-T2'nin kurduğu ortak ESLint/Prettier/tsconfig'i izler (Rust tarafı için `rustfmt`/`clippy` ayrıca eklenir, aynı disipline paralel).
5. **CI entegrasyonu:** F0-T3'ün `.github/workflows/ci.yml`'ine `apps/desktop` dahil edilir — bu, Rust toolchain gerektiren yeni bir CI adımı/job'u anlamına gelir (bkz. Açık Soru 4); mevcut Node.js-öncelikli `quality`/`security`/`pr-size-guard` job'ları etkilenmemeli.
6. **Minimal çalışan uygulama:** Boş pencere açıp kapanabilen, "merhaba dünya" seviyesinde bir Tauri uygulaması — F0-T1'in `apps/web`/`apps/server` için uyguladığı "yalnız iskelet, gerçek iş mantığı yok" ilkesiyle tutarlı.
7. **`packages/ui`/`packages/shared`'dan örnek import:** en az bir bileşen/yardımcı fonksiyonun `apps/desktop/src/` içinden gerçekten import edilip kullanıldığı, workspace-linking'in çalıştığının kanıtı.
8. **IPC/native-modül temel deseni:** Tauri komutları (`#[tauri::command]`) çağırma paterni kurulur — ama gerçek OS API entegrasyonu (aktif pencere başlığı okuma, takvim erişimi vb.) F2-T3'e bırakılır. IPC izin modeli en az ayrıcalık ilkesiyle başlar (bkz. Açık Soru 5).
9. **F2-T3 spec güncellemesi (not):** bu görev tamamlandığında F2-T3'ün (henüz yazılmamış) spec dosyası, F2-T2b'yi bağımlılık olarak referans alacak şekilde yazılmalı/güncellenmeli.

## Kapsam DIŞI

- F2-T3'ün kendi sinyal toplama mantığı (takvim durumu okuma, aktif pencere başlığı okuma, rıza akışı) — bu görevde YOK.
- Gerçek UI/UX tasarımı — yalnızca boş pencere/iskelet düzeyinde.
- `apps/mobile` (React Native) — ayrı, bu görevde YOK.
- Auto-update, dağıtım, code-signing — ayrı, gelecekte ele alınacak.
- F2-E2 (Memory Passport) ile ilgili hiçbir şey.
- Yerel-öncelikli SQLite + CRDT (Yjs) senkron motoru entegrasyonu (PLAN.md §2.1'de bahsi geçiyor ama bu görevin kapsamında değil — ayrı bir görev gerektirir).

## Açık Sorular

1. **[KRİTİK — mimari karar]** Framework: Tauri (PLAN.md'nin önerisi) mi, Electron mu, başka bir seçenek mi?
   - **Seçenek A (öneri):** Tauri — PLAN.md §2.1'in zaten önerdiği, düşük bellek ayak izi, Rust tabanlı güvenli IPC, kullanıcı bu yönde tercih belirtiyor. ADR ile resmi olarak sabitlenmesi isteniyor.
   - **Seçenek B:** Electron — daha olgun ekosistem, ama daha yüksek bellek/paket boyutu; PLAN.md'nin önerisiyle çelişir.
   - ADR'de karara bağlanmalı; Seçenek A öneriliyor, insan onayı gerekiyor.
2. Frontend katmanı: Tauri içinde hangi web frontend kullanılacak? Öneri: React + `packages/ui`'nin yeniden kullanımı, PLAN.md §2.1 ("Frontend: React + TanStack Query/Router, tasarım sistemi paketi") ile tutarlı. `apps/web`'in Vite kurulumuyla ne kadar paralel gidileceği (aynı Vite config'i mi, ayrı mı) ADR'de netleştirilmeli.
3. Paket/dizin yapısı: `apps/desktop/src-tauri/` (Rust) + `apps/desktop/src/` (frontend) ayrımı nasıl olacak; `packages/ui`/`packages/shared` gibi mevcut paketlerin workspace-linking ile nasıl import edileceği (pnpm workspace protokolü, `tsconfig` path mapping) ADR'de somutlaştırılmalı.
4. CI'de Tauri build'i (Rust toolchain gerektirir) mevcut Node.js-öncelikli CI pipeline'ına (F0-T3) nasıl entegre edilecek — yeni bir CI job'u mu gerekiyor, platform-matrisi (Windows/Mac/Linux) mu, yoksa v1'de tek platformla mı başlanacak (ör. yalnız Windows, geliştirici ortamıyla tutarlı)? Bu, CI süresini (F0-T3'ün `<5 dakika` hedefi) etkileyebilir.
5. IPC güvenlik modeli: Tauri'nin allowlist tabanlı komut izin sistemi ilk kurulumda ne kadar kısıtlı/açık olacak? En az ayrıcalık ilkesiyle (CLAUDE.md güvenlik disiplini) v1'de hiçbir native komuta izin verilmeyen tamamen kapalı bir iskelet mi, yoksa F2-T3'ün ihtiyaç duyacağı komutlar için yalnızca isimlendirilmiş, gövdesiz bir yer tutucu mu? ADR'de karara bağlanmalı.

## Kabul Kriterleri

- [x] Framework kararı (Tauri) `docs/adr/ADR-0019-desktop-app-iskeleti.md` ile sabitlendi ve insan tarafından onaylandı.
- [x] `apps/desktop` paketi F0-T1/F0-T2 konvansiyonlarına uygun kuruldu: `package.json` (`@luminaos/desktop`), `tsconfig.json` (kök `tooling/` konfigini extend eden, strict), `src-tauri/` + `src/` ayrımı.
- [x] `pnpm --filter @luminaos/desktop build` (frontend, `tsc && vite build`) hatasız tamamlanır; Rust linklemesi CI'nin `desktop-build` job'undaki ayrı `cargo build` adımıyla doğrulanır (bu makinede MSVC linker yok, implementer-seviyesi CI tasarım düzeltmesi — bkz. commit geçmişi).
- [x] CI'ye bağlı: `.github/workflows/ci.yml`'e Windows-only `desktop-build` job'u eklendi (`cargo fmt --check` + `cargo clippy -D warnings` + `cargo build`), mevcut job'lar kırılmadı.
- [x] Minimal pencere açılıp kapanabiliyor (`App.test.tsx` smoke testi ile doğrulandı).
- [x] `packages/ui`'den en az bir gerçek import çalışıyor (workspace-linking kanıtı, `App.test.tsx` ile testli).
- [x] IPC/native-modül temel deseni: v1'de SIFIR komut/plugin (ADR Karar f) — `src-tauri-config.integration.test.ts` bunu regresyon testiyle sabitliyor.
- [x] security-reviewer: Tauri allowlist/IPC yüzeyinin en az ayrıcalık ilkesine uyduğu denetlendi (bulgu: CSP `null` yerine kısıtlayıcı bir politika ayarlandı, testle sabitlendi).
- [x] **Not:** F2-T3'ün spec dosyası bu görevden SONRA yazılacak, F2-T2b'yi bağımlılık olarak referans alacak.
