# LuminaOS — Claude Code ile Uçtan Uca Uygulama Planı

**Sürüm:** 1.0 · **Tarih:** 21 Temmuz 2026
**Kapsam:** Bölüm 3 ve 4'te kabul edilen tüm adaptasyonlar ve 10 inovatif vizyonun eksiksiz gerçekleştirilmesi.

---

## 0. "Eksiksiz ve Hatasız" Nasıl Sağlanır — Yönetici Özeti

Hiçbir yazılım "sıfır hata sözü" ile değil, **hatayı üretimden önce yakalayan bir sistemle** hatasız hale gelir. Bu plan üç sütun üzerine kuruludur:

1. **Kapsam disiplini:** Tüm özellikler bu dokümanda epik → görev → kabul kriteri seviyesine kırılmıştır; Claude Code hiçbir zaman belirsiz bir istekle çalıştırılmaz.
2. **Kalite kapıları:** Her görev, otomatik testler + tip güvenliği + lint + güvenlik taraması + inceleme subagent'ından geçmeden "bitti" sayılmaz (Bkz. Bölüm 5).
3. **Claude Code'un doğru kullanımı:** CLAUDE.md, kurallar, skill'ler, subagent'lar ve hook'lardan oluşan bir "yönlendirme yığını" ile modelin davranışı deterministik sınırlara alınır (Bkz. Bölüm 4).

---

## 1. Ürün Kapsamı — Fazlara Dağılım Haritası

| #   | Vizyon / Yetenek                                                                    | Faz                    |
| --- | ----------------------------------------------------------------------------------- | ---------------------- |
| A   | Lumina Object modeli (tek varlık sınıfı + Custom/AI Fields + ilişkiler)             | 1                      |
| B   | Görünüm motoru (List, Board, Table, Calendar, Timeline, Gantt+Baseline, Workload)   | 1–2                    |
| C   | Görev/Doküman/Takvim çekirdeği + arama                                              | 1                      |
| D   | Sistem-seviyesi AI servisi (soru-cevap, konuşma komutları, çoklu model yönlendirme) | 1                      |
| E   | **Lumina Context Fabric** (uygulama-bağımsız bağlam grafiği)                        | 2                      |
| F   | **Memory Passport** (taşınabilir, denetlenebilir, dışa aktarılabilir bellek)        | 2                      |
| G   | MCP-native Connected Search + dış kaynak bağlama                                    | 2                      |
| H   | Notetaker + toplantı zekâsı (kayıt/transkript/özet tercihleri, ad hoc destek)       | 2                      |
| I   | Otomasyon motoru (tetikleyici/koşul/aksiyon, zamanlama, webhooks, geçmiş)           | 2                      |
| J   | **Agent Runtime + Skill SDK** (OS-seviyesi ajan çalışma zamanı, izin manifestoları) | 3                      |
| K   | **Cam Kutu Ajanlar** (gerekçe + bağlam kaynağı + tek tık geri alma)                 | 3                      |
| L   | Artifact üretimi (sunum, dashboard, sayfa, rapor) + "Sorgu → canlı widget"          | 3                      |
| M   | Ambient Intelligence + Niyet tabanlı arayüz (Intent-first komut düzlemi)            | 3                      |
| N   | **Plan-Gerçek motoru** (evrensel baseline/sapma katmanı)                            | 3                      |
| O   | Yerel-öncelikli hibrit AI (cihaz üstü model + bulut yükseltme)                      | 3                      |
| P   | Sakin Yazılım / dijital refah katmanı (bildirim bütçeleri, odak rejimleri)          | 3                      |
| Q   | Federatif "şirket beyni" (kurumlar arası izinli köprü)                              | 3+                     |
| R   | Şeffaf sınır modeli + veri çıkışı garantisi (export her katmanda)                   | 1'den itibaren sürekli |

---

## 2. Teknik Mimari Kararları

> Not: "İşletim sistemi" hedefi, Faz 1–3'te **çekirdek (kernel) yazmak** anlamına gelmez; tüm platformlarda OS-benzeri yetkilerle çalışan (global arama, bildirim yönetimi, ekran/ses yakalama, dosya sistemi erişimi) bir **Work OS kabuğu** olarak gerçekleştirilir. Bu, riski düşürür ve pazara çıkışı hızlandırır.

### 2.1 Önerilen Yığın (Claude Code ile en verimli çalışan kombinasyon)

- **Dil:** Uçtan uca TypeScript (strict mode) + performans kritik modüllerde Rust.
- **Masaüstü kabuk:** Tauri (Rust) — düşük bellek, OS API erişimi, güvenli IPC. Mobil: React Native (veya Faz 3'te Tauri Mobile değerlendirmesi).
- **Frontend:** React + TanStack Query/Router, tasarım sistemi paketi (`packages/ui`).
- **Backend:** Node.js (NestJS) modüler monolit → Faz 3'te servis ayrıştırma. API: tRPC (iç) + REST/OpenAPI (dış, Skill SDK için).
- **Veri:** PostgreSQL + pgvector (bağlam gömlemeleri), Redis (kuyruk/cache), S3 uyumlu depo (dosyalar).
- **Yerel-öncelikli:** İstemcide SQLite + CRDT (Yjs) tabanlı senkron motoru; sunucu otoritatif event log.
- **Olay mimarisi:** Context Fabric ve Plan-Gerçek motoru **event sourcing** ile kurulur (her değişiklik olaydır → baseline/sapma bedavaya yakın gelir).
- **AI Gateway:** Model-agnostik yönlendirme katmanı (Claude API birincil; sağlayıcı arayüzü soyut). Cihaz üstü model: llama.cpp / Apple-Core ML köprüsü (Faz 3).
- **Entegrasyon:** MCP istemcisi (dış kaynaklar) **ve** MCP sunucusu (LuminaOS'in kendisi dışarıya bağlam sunar — federatif beyin için temel).

### 2.2 Monorepo Yapısı

```
luminaos/
├── CLAUDE.md                  # Claude Code proje anayasası (şablon ekte)
├── .claude/
│   ├── agents/                # Subagent tanımları (bkz. 4.3)
│   ├── skills/                # Proje skill'leri (bkz. 4.4)
│   └── settings.json          # Hook'lar ve izinler (bkz. 4.5)
├── docs/
│   ├── adr/                   # Mimari Karar Kayıtları (ADR-0001, ...)
│   ├── specs/                 # Epik başına spec dosyaları (Claude Code'un girdisi)
│   └── runbooks/
├── apps/
│   ├── desktop/               # Tauri kabuğu
│   ├── web/                   # Web istemcisi
│   ├── mobile/                # React Native
│   └── server/                # NestJS API + worker'lar
├── packages/
│   ├── core-objects/          # A: Lumina Object modeli (saf domain, framework'süz)
│   ├── view-engine/           # B: Görünüm motoru
│   ├── context-fabric/        # E: Bağlam grafiği + event store istemcisi
│   ├── memory/                # F: Memory Passport
│   ├── ai-gateway/            # D/O: Model yönlendirme + cihaz üstü köprü
│   ├── agent-runtime/         # J/K: Ajan çalışma zamanı + izin manifestoları
│   ├── automation/            # I: Otomasyon motoru
│   ├── integrations/          # G: MCP istemci/sunucu, bağlayıcılar
│   ├── artifacts/             # L: Artifact üretim boru hattı
│   ├── wellbeing/             # P: Refah katmanı
│   ├── ui/                    # Tasarım sistemi
│   └── shared/                # Tipler, yardımcılar, hata sınıfları
└── tooling/                   # ESLint/TS config, codegen, test yardımcıları
```

**Neden bu yapı Claude Code için ideal:** Her paket tek sorumluluk taşır → Claude Code'a "packages/automation içinde çalış, başka pakete dokunma" sınırı verilebilir; subagent'lar paketleri paralel keşfedebilir; testler paket bazında hızlı koşar.

---

## 3. Claude Code Kurulumu ve Çalışma Modları

- **Kurulum:** `npm install -g @anthropic-ai/claude-code` (güncel kurulum ve gereksinimler için resmî belge: https://docs.claude.com/en/docs/claude-code/overview).
- **Kullanım yüzeyleri:** Terminal (ana geliştirme), VS Code eklentisi (inceleme/diff), Desktop uygulaması Code sekmesi (paralel oturumlar).
- **Model/efor:** Mimari ve spec işlerinde en yüksek yetenekli model + yüksek efor; mekanik/tekrarlı işlerde (test yazımı, taşıma) daha hızlı model. Oturum başında `/model` ile seçilir.
- **Paralellik:** Faz 2'den itibaren bağımsız paketlerde eşzamanlı oturumlar (git worktree ile) — ör. bir oturum `context-fabric`, diğeri `ui` üzerinde.

---

## 4. Claude Code Yönlendirme Yığını (Steering Stack)

Bu bölüm "hatasız" hedefinin kalbidir: model davranışını dört katmanla sınırlar.

### 4.1 CLAUDE.md (her oturumda yüklü proje anayasası)

İçeriği ekteki şablonda hazırdır (`CLAUDE.md` dosyası). Kapsadıkları: komutlar (build/test/lint), monorepo haritası, kodlama sözleşmeleri, "asla yapma" listesi, tanım-of-done, spec-first çalışma kuralı.

### 4.2 Kurallar (hard constraints)

- Üretim koduna `any` yazılmaz; tüm public API'ler JSDoc + tip taşır.
- Migration'lar geri alınabilir olmadan birleştirilmez.
- Ajan/AI çağrıları yalnızca `ai-gateway` üzerinden yapılır (doğrudan sağlayıcı SDK'sı import etmek yasak).
- Kullanıcı verisi log'lara yazılmaz; PII maskeleme zorunlu.
- Her dış girdi (MCP, webhook, form) şema ile doğrulanır (zod).

### 4.3 Subagent Seti (`.claude/agents/*.md`)

| Subagent            | Görev                                                 | Araç kısıtı              |
| ------------------- | ----------------------------------------------------- | ------------------------ |
| `explorer`          | Repo/paket keşfi, ilgili dosya haritası çıkarma       | Salt-okunur              |
| `architect`         | Spec'ten teknik tasarım + ADR taslağı                 | Salt-okunur + docs yazma |
| `test-writer`       | Kabul kriterlerinden önce başarısız test üretme (TDD) | Test dizinleri           |
| `implementer`       | Testleri geçirecek asgari kodu yazma                  | İlgili paket             |
| `security-reviewer` | Diff üzerinde OWASP + izin sızıntısı denetimi         | Salt-okunur              |
| `docs-writer`       | API dokümanı, changelog, runbook güncelleme           | docs/                    |

Ana akış temiz kalır: keşif ve inceleme gürültüsü subagent bağlamlarında izole edilir; ana oturuma yalnız damıtılmış sonuç döner.

### 4.4 Skill'ler (`.claude/skills/*/SKILL.md`) — tekrarlanan prosedürler

- `yeni-ozellik/` — spec oku → plan → test → kod → inceleme → PR ritüelinin adımları.
- `yeni-lumina-object-tipi/` — yeni varlık tipi eklerken şema + migration + görünüm kaydı + test kontrol listesi.
- `mcp-baglayici/` — yeni MCP bağlayıcısı ekleme prosedürü (kimlik, oran sınırı, hata sözleşmesi).
- `agent-skill-sdk/` — Agent Runtime'a yeni beceri paketi ekleme standardı.
- `release/` — sürümleme, changelog, migration sırası, canary kontrol listesi.

### 4.5 Hook'lar (`.claude/settings.json`) — deterministik güvence

- **PostToolUse (Write|Edit):** `prettier` + `eslint --fix` + ilgili paketin `vitest related` koşumu; başarısızsa Claude'a hata geri beslenir.
- **PreToolUse (Bash):** `rm -rf`, `git push --force`, prod ortam değişkenlerine dokunan komutlar bloklanır.
- **Stop:** `pnpm typecheck && pnpm test --changed` — oturum, kırık durumda "bitti" diyemez.

### 4.6 Oturum Ritüeli (her görev için değişmez akış)

1. Görevin spec dosyasını aç (`docs/specs/EPIC-xx/TASK-yy.md`).
2. **Plan mode** ile başla: Claude Code keşfi `explorer` subagent'ına devreder, uygulama planı üretir.
3. Planı insan onaylar (mimari sapma varsa `architect` ile ADR yazılır).
4. `test-writer` başarısız testleri yazar → `implementer` geçirir.
5. `security-reviewer` diff'i denetler; bulgular kapatılır.
6. Küçük, tek amaçlı commit + PR; CI yeşilse birleştir.
7. Spec dosyasına "Done + kanıt linkleri" işlenir.

---

## 5. Kalite Kapıları ("Hatasız"ın Mühendisliği)

| Kapı               | Araç                                                   | Eşik                                                        |
| ------------------ | ------------------------------------------------------ | ----------------------------------------------------------- |
| Tip güvenliği      | tsc --strict                                           | 0 hata                                                      |
| Lint/format        | ESLint + Prettier                                      | 0 hata                                                      |
| Birim test         | Vitest                                                 | Paket başına ≥ %85 satır kapsamı; domain paketlerinde ≥ %95 |
| Entegrasyon        | Testcontainers (Postgres/Redis)                        | Kritik akışların tamamı                                     |
| E2E                | Playwright                                             | Faz kabul senaryolarının tamamı                             |
| Sözleşme           | OpenAPI + tRPC tip üretimi                             | API kırılımında CI kırmızı                                  |
| Güvenlik           | Semgrep + gizli anahtar taraması + bağımlılık denetimi | 0 kritik bulgu                                              |
| AI davranışı       | Prompt/ajan **eval seti** (golden dataset)             | Regresyonda birleştirme yok                                 |
| Performans         | k6 + Lighthouse bütçeleri                              | P95 API < 200ms; ilk boya < 1.5s                            |
| Geri alınabilirlik | Migration down-testi + feature flag                    | Her riskli özellik bayrak arkasında                         |

Ek uygulamalar: her epik için ADR; canary dağıtım; hata bütçesi; haftalık "flaky test sıfırlama" nöbeti.

---

## 6. Faz Bazlı Yol Haritası ve Görev Kırılımı

Süreler, 2–4 mühendis + Claude Code paralel oturumları varsayımıyla verilmiştir. Her görev `docs/specs/` altında kendi spec dosyasını alır; aşağıdaki kırılım o dosyaların dizinidir.

### FAZ 0 — Temel Altyapı (2 hafta)

**Epik F0-E1: Monorepo ve araç zinciri**

- F0-T1: pnpm workspace + Turborepo kurulumu, paket iskeletleri. _(Kabul: `pnpm build` tüm paketlerde yeşil)_
- F0-T2: tsconfig strict, ESLint/Prettier ortak konfig, commit hook'ları.
- F0-T3: CI boru hattı (lint → typecheck → test → build → güvenlik taraması).
- F0-T4: `.claude/` yönlendirme yığınının kurulması (CLAUDE.md, 6 subagent, 5 skill, hook'lar). _(Kabul: örnek görevde ritüel uçtan uca çalışır)_

**Epik F0-E2: Çekirdek servisler**

- F0-T5: Auth (OIDC + oturum), çok-kiracılı (multi-tenant) temel, RBAC iskeleti.
- F0-T6: Event store şeması + olay yayınlama altyapısı (Context Fabric'in temeli).
- F0-T7: Tasarım sistemi v0 (`packages/ui`): tema, tipografi, 12 temel bileşen.
- F0-T8: Observability: yapılandırılmış log, OpenTelemetry izleri, hata takibi.

### FAZ 1 — Çekirdek Ürün (8–10 hafta)

**Epik F1-E1: Lumina Object Modeli (Kapsam A)**

- F1-T1: Varlık çekirdeği: kimlik, tip, sahiplik, yaşam döngüsü, soft-delete.
- F1-T2: Custom Fields motoru (12 alan tipi, varsayılan değer, alan bazlı izin).
- F1-T3: İlişki sistemi (bağımlılık, referans, ebeveyn-çocuk; çift yönlü tutarlılık).
- F1-T4: Formül alanları (iç içe, hata yönetimli) + sütun hesaplamaları.
- F1-T5: AI Fields: `ai-gateway` üzerinden otomatik doldurma + "değişince yenile" tetikleyicisi.
- _(Kabul: property-based testlerle şema evrimi ve ilişki tutarlılığı kanıtlı; %95+ kapsam)_

**Epik F1-E2: Görünüm Motoru (Kapsam B, v1)**

- F1-T6: Sorgu katmanı (filtre/sıralama/gruplama DSL'i) — görünümler veriye değil sorguya bağlanır.
- F1-T7: List + Board + Table görünümleri (sanallaştırılmış, 10k satırda akıcı).
- F1-T8: Calendar + Timeline görünümleri; sürükle-bırak zamanlama.
- F1-T9: Görünüm kaydetme/paylaşma/ikonlama; kişisel vs. ortak görünümler.

**Epik F1-E3: Görev + Doküman + Takvim çekirdeği (Kapsam C)**

- F1-T10: Görev deneyimi (durumlar, öncelik, kontrol listeleri, yinelenenler, hatırlatıcı).
- F1-T11: Doküman editörü (blok tabanlı, katlanabilir başlıklar, gerçek zamanlı CRDT işbirliği).
- F1-T12: Takvim: Google/Outlook senkronu, zaman bloklama v1, Odak/OOO durumları.
- F1-T13: Global arama (tam metin + vektör; komut paleti içinde).

**Epik F1-E4: AI Servisi v1 (Kapsam D) + Veri Çıkışı (Kapsam R)**

- F1-T14: `ai-gateway`: sağlayıcı soyutlama, model yönlendirme kuralları, maliyet/kota ölçümü.
- F1-T15: Soru-cevap: workspace bağlamıyla RAG (pgvector) + kaynak gösterimi.
- F1-T16: Konuşma komutları v1: "görev aç, alt görev üret, atama yap" tarzı çok adımlı aksiyonlar — her aksiyon onay kartıyla.
- F1-T17: Eval altyapısı: 100+ senaryoluk golden set; CI'da AI regresyon kapısı.
- F1-T18: Tam veri dışa aktarma (JSON + Markdown + iCal) — ilk sürümden itibaren.

**Faz 1 Çıkış Kriteri:** 20 kişilik pilot ekip günlük işini yalnızca LuminaOS'te yürütebiliyor; P95 gecikme ve eval eşikleri yeşil.

### FAZ 2 — Bağlam Katmanı (10–12 hafta)

**Epik F2-E1: Lumina Context Fabric (Kapsam E)**

- F2-T1: Olaylardan bağlam grafiği türetme (varlık-kişi-zaman-konu düğümleri).
- F2-T2: Bağlam API'si: "bu nesneyle ilgili her şey" sorgusu (<100ms, izin süzgeçli).
- F2-T3: Masaüstü kabuktan sinyal toplayıcılar (takvim durumu, aktif pencere başlığı — **açık rıza + yerinde işleme**, bkz. F2-E2).
- F2-T4: İlgililik skorlama + zaman aşımıyla sönümleme.

**Epik F2-E2: Memory Passport (Kapsam F)**

- F2-T5: Bellek deposu: kullanıcı başına satır-düzeyi görünür/düzenlenebilir/silinebilir kayıtlar.
- F2-T6: "Hakkımda ne biliyorsun?" ekranı + kaynak izi (hangi olaydan öğrenildi).
- F2-T7: İçe/dışa aktarım: açık şema (JSON-LD) + ChatGPT/Claude bellek içe aktarma sihirbazı.
- F2-T8: Bellek kullanım politikası: hangi ajanın hangi bellek segmentine erişebildiği manifestolarla.

**Epik F2-E3: MCP-native Entegrasyon (Kapsam G)**

- F2-T9: MCP istemci çatısı + bağlayıcı yaşam döngüsü (kimlik, oran sınırı, sağlık).
- F2-T10: İlk 6 bağlayıcı: Google Drive, Gmail, Slack, GitHub, Notion, Takvimler.
- F2-T11: Connected Search: tek arama çubuğunda iç + dış kaynak birleşik sonuç.
- F2-T12: LuminaOS MCP **sunucusu** v0 (dışarıya güvenli bağlam sunumu — Q'nun temeli).

**Epik F2-E4: Toplantı Zekâsı (Kapsam H)**

- F2-T13: Notetaker botu (Meet/Zoom/Teams; ad hoc link yapıştırma dahil).
- F2-T14: Saklama tercihleri (kayıt/transkript/yalnız özet) + otomatik aksiyon çıkarımı → onaylı görev üretimi.

**Epik F2-E5: Otomasyon Motoru (Kapsam I)**

- F2-T15: Tetikleyici/koşul/aksiyon çekirdeği; zamanlanmış tetikleyiciler; regex koşullar.
- F2-T16: Yeniden kullanılabilir webhook'lar + otomasyon geçmişi/denetim ekranı.
- F2-T17: AI önerili otomasyon şablonları (kullanım desenlerinden).

### FAZ 3 — Otonomi ve Farklılaşma (12–16 hafta)

**Epik F3-E1: Agent Runtime + Skill SDK (Kapsam J)**

- F3-T1: Ajan çalışma zamanı: sandbox, kaynak sınırları, izin manifestosu (veri kapsamı × aksiyon × zaman penceresi).
- F3-T2: Skill SDK v1: imzalı beceri paketleri, sürümleme, yetenek bildirimi; 20 birinci parti beceri.
- F3-T3: Ajan-insan etkileşimi: @mention, görev atama, DM ile ajan yeniden yapılandırma.

**Epik F3-E2: Cam Kutu Otonomi (Kapsam K)**

- F3-T4: Her ajan aksiyonu için gerekçe kaydı + kullanılan bağlam kaynakları + geri alma planı ("uçuş kayıt cihazı").
- F3-T5: Otonomi kadranı: öner / onayla-yap / yap-bildir — görev tipi başına kullanıcı ayarı.
- F3-T6: Tek tık geri alma: ters olay üretimiyle (event sourcing sayesinde) atomik geri sarma.

**Epik F3-E3: Artifact + Canlı Widget (Kapsam L) ve Intent-first UI (Kapsam M)**

- F3-T7: Artifact boru hattı: sunum/dashboard/sayfa üretimi, marka temaları, tek prompt akışı.
- F3-T8: "Sorgu → canlı widget": doğal dil sorgusunu sabitlenebilir, kendini yenileyen panel bileşenine derleme.
- F3-T9: Komut düzlemi v2: niyet ayrıştırıcı → modül/aksiyon yönlendirme; ambient öneri yüzeyi.

**Epik F3-E4: Plan-Gerçek Motoru (Kapsam N)**

- F3-T10: Evrensel baseline: herhangi bir sorgu/metrik/plan anlık görüntüsü + sapma hesaplayıcı.
- F3-T11: Sapma anında ajan destekli kök neden analizi kartı.

**Epik F3-E5: Hibrit AI (Kapsam O) + Refah Katmanı (Kapsam P)**

- F3-T12: Cihaz üstü model köprüsü; hassas veri sınıflandırıcısı → yerel/bulut yönlendirme politikası.
- F3-T13: Bildirim bütçeleri, bağlam-değiştirme sayacı, ajan sessiz saatleri, aşırı yük sinyali → yeniden dengeleme önerisi.

**Epik F3-E6: Federatif Beyin v0 (Kapsam Q)**

- F3-T14: Kurumlar arası paylaşılan proje alanı: yalnız o kapsamda ortak bellek/bağlam; çift taraflı denetim günlüğü.

---

## 7. On İnovatif Vizyonun Teknik Gerçekleştirme Notları (özet spec)

1. **Context Fabric (E):** Event sourcing + grafik projeksiyonu. Anahtar karar: bağlam _türetilir_, ayrıca yazılmaz — tek doğruluk kaynağı olay günlüğüdür.
2. **Memory Passport (F):** Bellek = birinci sınıf, kullanıcı-sahipli tablo; her satırda `kaynak_olay_id`. Silme = olayla yayılan tombstone (ajan önbellekleri dahil temizlenir).
3. **Cam Kutu Ajanlar (K):** Ajan API sözleşmesi her aksiyonda `{niyet, gerekçe, kaynaklar[], geri_alma_planı}` döndürmek zorundadır; şema hook + CI eval ile zorlanır.
4. **Yerel-öncelikli hibrit AI (O):** Sınıflandırıcı önce çalışır; "hassas" etiketli içerik buluta ham gitmez, yerelde özetlenip anonim temsil gönderilir.
5. **Intent-first UI (M):** Komut düzlemi tüm modül aksiyonlarını tek kayıt defterinden (action registry) çağırır — UI menüleri de aynı kayıttan üretilir, ikilik oluşmaz.
6. **Sakin Yazılım (P):** Bildirim = bütçeli kaynak; her bildirim önem skoru taşır, bütçe aşımında toplulaştırılır. Ajanlar takvim durumuna aboneliklidir.
7. **Plan-Gerçek (N):** `baseline_snapshot(query_id, t)` + fark motoru; Gantt Baselines bunun tek bir görünümü olur.
8. **Federatif Beyin (Q):** LuminaOS'in kendi MCP sunucusu, kapsam-sınırlı belirteçlerle karşı kuruma bağlam servis eder; veri kopyalanmaz, yerinde sorgulanır.
9. **Şeffaf sınır modeli (R):** Kota sayaçları API'de birinci sınıf (`/limits`); UI her zaman "ne kadar kaldı"yı gösterir; export hiçbir planda kısıtlanamaz (mimari değişmez kuralı).
10. **Doğrulanabilir iddialar:** Telemetriden anonim ROI panosu; pazarlama sayfası metrikleri bu panodan beslenir, elle yazılmaz.

---

## 8. Risk Yönetimi

| Risk                               | Olasılık     | Azaltma                                                                           |
| ---------------------------------- | ------------ | --------------------------------------------------------------------------------- |
| Kapsam şişmesi (ClickUp sendromu)  | Yüksek       | Faz kapıları; her yeni istek "spec + kabul kriteri" olmadan backlog'a giremez     |
| AI davranış regresyonu             | Orta         | Golden eval seti CI kapısı; model sürümü sabitleme + kanarya                      |
| Bağlam toplama = gizlilik riski    | Orta         | Açık rıza, yerinde işleme, F2-T3'te veri sınıfı denetimi; DPIA dokümanı           |
| Event store performansı            | Orta         | Projeksiyon önbellekleri; k6 yük testleri Faz 2 kapısında                         |
| Claude Code'un büyük diff üretmesi | Orta         | Görev başına tek spec kuralı; PR boyut limiti hook'u (±400 satır)                 |
| Ajan yetki taşması                 | Düşük/kritik | İzin manifestosu + hook ile araç kısıtı + denetim günlüğü; kırmızı takım testleri |

---

## 9. Metrikler ve Başarı Kriterleri

- **Kalite:** Kaçan hata/sprint < 2; CI yeşil oranı > %95; flaky test < %1.
- **Hız:** Spec→üretim medyanı < 5 iş günü (Faz 1), < 3 gün (Faz 3).
- **Ürün:** Pilot ekipte haftalık aktiflik > %80; "bağlam arama süresi" ölçümünde ≥ %50 düşüş.
- **AI güveni:** Ajan aksiyonlarında geri alma oranı < %5; eval doğruluk ≥ %92.

---

## 10. İlk 10 İş Günü — Somut Başlangıç Takvimi

| Gün | İş                                                                                                             |
| --- | -------------------------------------------------------------------------------------------------------------- |
| 1   | Repo + pnpm workspace + CI iskeleti (F0-T1..T3). Claude Code ile: plan mode → onay → uygulama                  |
| 2   | `.claude/` yönlendirme yığını (F0-T4): CLAUDE.md yerleştir, 6 subagent, hook'lar; örnek görevle ritüel provası |
| 3–4 | Auth + multi-tenant temel (F0-T5); `security-reviewer` ilk gerçek denetimi                                     |
| 5   | Event store + tasarım sistemi v0 başlangıcı (F0-T6, T7 paralel oturumlar)                                      |
| 6–8 | F1-T1 Lumina Object çekirdeği — TDD ritüeliyle; ADR-0001 (varlık modeli) yazılır                               |
| 9   | F1-T2 Custom Fields motoru ilk dilim (3 alan tipi)                                                             |
| 10  | Retro: hook/eşik ayarları, eval setine ilk 20 senaryo, Faz 1 sprint planının kesinleşmesi                      |

---

## 11. Ekler

- **Ek A:** `CLAUDE.md` şablonu (ayrı dosya — repoya kök dizine kopyalanır).
- **Ek B:** Görev başına Claude Code prompt kalıbı:

```text
docs/specs/F1-E1/F1-T2.md dosyasını oku. Plan mode'da başla:
1) explorer subagent ile packages/core-objects'i haritala,
2) uygulama planını çıkar ve bana onaylat,
3) onaydan sonra test-writer ile kabul kriterlerinden başarısız testleri yaz,
4) testleri geçirecek asgari kodu yaz,
5) security-reviewer ile diff'i denetle,
6) tek amaçlı commit'lerle PR hazırla.
Kapsam dışına çıkma: yalnızca packages/core-objects ve testleri.
```
