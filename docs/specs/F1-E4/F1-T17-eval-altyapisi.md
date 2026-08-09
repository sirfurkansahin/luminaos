# F1-T17 — Eval Altyapısı: 100+ Senaryoluk Golden Set + CI'da AI Regresyon Kapısı

**Epik:** F1-E4 (AI Servisi v1 + Veri Çıkışı) · **Durum:** Yapılacak
**Bağımlılık:** F1-T5 (AI Fields eval tohumu — `docs/evals/ai-fields.md`, `ai-fields.eval.test.ts`, ADR-0008 §f), F1-T15 (`QAService`/`answerQuestion`, ADR-0014), F1-T16 (`parseCommand`/`CommandsService`, ADR-0015), F0-T3 (CI boru hattı — `.github/workflows/ci.yml`'in `quality` job'ı)

## Amaç

PLAN.md (satır 230) bu görevi "eval altyapısı: 100+ senaryoluk golden set; CI'da AI regresyon kapısı" olarak tanımlıyor. Bugün yalnızca F1-T5'in (AI Fields) 10 senaryoluk tohumu var (ADR-0008 §f'nin bıraktığı); F1-T15 (RAG/QA) ve F1-T16 (komut ayrıştırma) için hiçbir golden-set kapsamı yok, ve mevcut eval testi CI'da AÇIK bir "regresyon kapısı" değil — genel `pnpm test` adımının içinde, diğer binlerce birim testinin arasında görünmez şekilde eriyor. Bu görev golden-set'i LuminaOS'in üç AI-çağıran özelliğinin (AI Fields, QA/RAG, Komut Ayrıştırma) tamamını kapsayacak şekilde 100+ senaryoya genişletir ve CI'da bunu görünür, açıkça raporlanan bir kapıya dönüştürür.

## Mevcut Durum (keşif — koddan doğrulandı)

- `docs/evals/ai-fields.md` + `apps/server/src/ai/ai-fields.eval.test.ts`: 10 senaryo, `resolveAIFieldValue`'ya karşı, `MockProvider` ile deterministik, Testcontainers'sız — ADR-0008 §f'nin bıraktığı tohum. Zaten `pnpm test` (`turbo run test`) altında koşuyor, ama CI'nın `quality` job'ının genel `Test (with coverage)` adımının bir PARÇASI — ayrı bir job/adım/raporu yok.
- F1-T15'in `answerQuestion`/`QAService`'i: kendi entegrasyon testleri var (gerçek Postgres) ama DB-free, saf bir "golden senaryo" seti YOK — "yalnızca retrieved pasajlara dayan, halüsinasyon yapma" ve "sıfır pasaj → kısa devre, model'e hiç gidilmez" davranışları golden-set formatında sabitlenmemiş.
- F1-T16'nın `parseCommand`/`CommandsService`'i: aynı şekilde entegrasyon testleri var ama golden-set YOK — JSON+zod+retry-once+hata-sentinel davranışı, üç aksiyon tipinin (`createTask`/`generateSubtasks`/`assignPeople`) doğru ayrıştırılması, golden-set'e dahil değil.
- `.github/workflows/ci.yml`: `quality` job'ı sırasıyla lint → typecheck → test → build çalıştırıyor; `security` job'ı ayrı (gitleaks + `pnpm audit`); `pr-size-guard` job'ı ayrı, PR boyutunu uyarıyor (merge'ü engellemiyor). AI-özel bir "regresyon kapısı" job'ı/adımı YOK.
- CLAUDE.md "Özetleme Disiplini": başarılı adımların ayrıntılı çıktısı ana oturuma/log'a basılmaz, yalnızca başarısızlıkta tam çıktı gösterilir — 100+ senaryoluk eval raporlaması bu disiplinle uyumlu olmalı (özet + yalnızca başarısız senaryoların detayı, 100+ satırlık ham çıktı CI logunu boğmamalı).
- ADR-0008 §f kendi notunda F1-T17'yi işaret ediyor: "skorlama, insan değerlendirmesi, model karşılaştırması" — bunların hangisinin v1 kapsamına gireceği henüz karar verilmedi (bkz. Açık Sorular).

## Kapsam

1. **Golden-set genişletmesi:** Mevcut 10 AI Fields senaryosuna ek olarak F1-T15 (QA/RAG) ve F1-T16 (komut ayrıştırma) için yeterli sayıda senaryo eklenir, toplam 100+ hedeflenir. QA senaryoları: kaynak gösterimi doğruluğu, pasajlara-dayalı cevap (halüsinasyon yok), sıfır-pasaj kısa devresi, çok-pasajlı sentez. Komut ayrıştırma senaryoları: üç aksiyon tipinin (`createTask`/`generateSubtasks`/`assignPeople`) doğru ayrıştırılması, bozuk/geçersiz JSON → retry-once → hata-sentinel, belirsiz/aksiyon-dışı komutlar.
2. **Golden-set organizasyonu:** `docs/evals/ai-fields.md` deseninin (insan-okunur senaryo tablosu + saf/DB-free test dosyası) F1-T15/F1-T16 için tekrarlanması — tasarım kararı (plan aşamasında netleşir): özellik-başına ayrı dosyalar mı, tek merkezi bir golden-set dosyası mı.
3. **CI regresyon kapısı:** `.github/workflows/ci.yml`'e golden-set'in geçip geçmediğini AÇIKÇA raporlayan bir adım/job eklenir (mevcut `quality` job'ı içine bir adım mı, yoksa `pr-size-guard` deseniyle ayrı bir job mı — plan aşamasında netleşir); başarısızlıkta PR kırmızı olur, CLAUDE.md'nin "CI kırmızıyken merge etme" disiplinine bağlanır.
4. **Mock-öncelikli disiplin korunur:** Tüm senaryolar `MockProvider`/`MockEmbeddingProvider` ile deterministik, gerçek ağ çağrısı YOK, Testcontainers'sız (F0-T3'ün hızlı-CI ilkesi bozulmaz).
5. **Genişletilebilir desen:** Golden-set'e yeni senaryo eklemenin tek, dokümante edilmiş bir yolu olur — gelecekteki AI özellikleri (F1-T18 sonrası, Faz 2+) kendi golden-set'lerini aynı desenle ekleyebilir.

## Kapsam DIŞI

- Gerçek Anthropic/embedding sağlayıcısına karşı canlı (network) eval — yalnızca Mock'a karşı; gerçek-sağlayıcı entegrasyonu F1-T13/F1-T14'ün kendi kapsam-dışı maddeleri, bu görev de aynı ertelemeyi miras alır.
- İnsan-değerlendirmeli (human-eval) skorlama, model karşılaştırma/A-B test altyapısı — ADR-0008 §f'nin bıraktığı not, kapsamı plan aşamasında netleşecek (bkz. Açık Sorular); tam biçimiyle muhtemelen ayrı bir gelecek görev.
- Faz 2+ AI özelliklerinin (Context Fabric, Memory Passport vb.) golden-set'i — bu görev yalnızca F1-T5/T15/T16'yı kapsar.

## Açık Sorular (Plan Aşamasında Netleşecek)

- Golden-set dosya organizasyonu: özellik-başına ayrı dosyalar (`docs/evals/qa.md`, `docs/evals/komut-ayristirma.md`) mı, yoksa tek merkezi bir dosya mı?
- Skorlama modeli: v1 için basit pass/fail (mevcut AI Fields desenindeki gibi exact/deterministik assertion) yeterli mi, yoksa kısmi-doğruluk skoru (ör. QA cevaplarının ne kadar "pasajlara sadık" olduğu için bir metrik) mu gerekiyor? ADR-0008 §f'nin "skorlama" notu bunu işaret ediyor ama v1 kapsamı belirsiz.
- CI kapısı mimarisi: mevcut `quality` job'ı içine bir adım mı (daha basit, ama başarısızlık genel test hatasıyla karışabilir), yoksa `pr-size-guard` deseniyle ayrı, adı geçen bir `ai-eval` job'ı mı (daha görünür, paralel çalışabilir)?
- 100+ senaryo üç özellik arasında nasıl dağılacak — eşit mi (örn. ~35/35/35), yoksa her özelliğin karmaşıklığına/risk profiline göre orantılı mı (QA ve komut ayrıştırma daha yeni ve state-mutasyonlu olduğundan daha fazla senaryo mu almalı)?

## Kabul Kriterleri

- [ ] Golden-set toplamda 100+ senaryo içerir, üç AI-çağıran özelliği (AI Fields, QA/RAG, Komut Ayrıştırma) kapsar; hepsi `MockProvider`/`MockEmbeddingProvider` ile deterministik, Testcontainers'sız `pnpm test` altında koşar.
- [ ] CI'da (`ci.yml`) golden-set'in geçip geçmediğini açıkça raporlayan, başarısızlıkta PR'ı kırmızı yapan bir adım/job vardır (regresyon kapısı).
- [ ] Mevcut 10 AI Fields senaryosu (`docs/evals/ai-fields.md`) değişmeden, regresyonsuz genişletilmiş sete dahildir.
- [ ] Golden-set'e yeni bir senaryo eklemenin dokümante edilmiş, tek bir deseni vardır (gelecekteki AI özellikleri için tekrarlanabilir).
- [ ] security-reviewer: golden-set senaryolarının hiçbirinde gerçek/hassas veri kullanılmadığı (yalnızca sentetik test verisi) doğrulanır.
