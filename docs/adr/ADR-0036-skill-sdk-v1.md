# ADR-0036: Skill SDK v1 — İmzalı Beceri Paketleri, Sürümleme, Yetenek Bildirimi (20 Birinci Parti Beceri)

**Durum:** Kabul edildi (Plan Mode oturumunda insan onayı zaten alındı — bu ADR o kararları biçimlendirir, yeniden tartışmaz)
**Tarih:** 2026-09-04
**İlgili görev:** F3-T2 — Skill SDK v1: imzalı beceri paketleri, sürümleme, yetenek bildirimi; 20 birinci parti beceri. Spec dosyası: `docs/specs/F3-E1/F3-T2-skill-sdk-v1.md` (bu ADR ile paralel olarak `docs-writer` tarafından yazılır) — `docs/PLAN.md` §"Epik F3-E1: Agent Runtime + Skill SDK (Kapsam J)" satırı bu ADR'nin tek plan kaynağı.
**İlgili plan referansı:** `docs/PLAN.md`, FAZ 3, Epik F3-E1'in ikinci görevi (F3-T1/**F3-T2**/F3-T3'ten yalnızca F3-T2'yi kapsar). CLAUDE.md "ADR Ne Zaman Gerekir" maddesinin her iki fıkrasını da tetikliyor: (i) kod-imzalama, bu kod tabanında ilk asimetrik-imza ilkeli mekanizma, "Mimari Değişmezler"deki ajan-aksiyon sözleşmesiyle ve mevcut sandbox/izin altyapısıyla doğrudan etkileşiyor; (ii) `executeSkill`'in sabit çağrı sırası (izin kontrolü → kaynak-sınırlı çalıştırma) F3-T3'e (ajan-insan etkileşimi) dayatılan bir kontrat.

> Bu ADR, ADR-0035'in (F3-T1, Ajan Çalışma Zamanı) doğrudan mimari devamıdır — ADR-0035 §(e) kendi metninde şunu önceden not etmişti: "F3-T2'nin beceri-çalıştırma akışı, `checkPermission`/`executeAgentAction`'ın ilk gerçek çağıranı olacak." Bu ADR o vaadi kapatıyor: `SkillExecutionService` gerçekten kuruluyor, ve ADR-0035 §(a)'nın bilinçli ertelediği gerçek OS/VM izolasyonu sorusu burada AÇIKÇA yeniden ele alınıyor — ve AÇIKÇA yeniden ERTELENİYOR (Karar a), henüz kapatılmıyor.
>
> Aşağıdaki (a)-(g) maddelerinden (a)/(b)/(d)/(e) insan onaylı geldi — Plan Mode oturumunda doğrudan onaylandı, bu ADR onları icat etmiyor, aynen kayıt altına alıyor. (c)/(f)/(g) bu ADR'nin kendi sorumluluğu olan architect-seviyesi tasarım detaylarıdır — insana tekrar sorulmadan, onaylanan sınırlar içinde ADR adımında sonuçlandırılıyor (CLAUDE.md "Çalışma Ritüeli").

## Bağlam

Keşif iki doğrudan emsal ve bir açık soru ortaya koydu:

1. **ADR-0035 (F3-T1)** — `AgentPermissionManifestsService.checkPermission` (olay-kaynaklı grant/revoke, veri kapsamı × aksiyon tipi × zaman penceresi) ve `AgentResourceLimitsService.executeAgentAction` (hız sınırı + eşzamanlılık tavanı + `runInAgentSandbox` zaman-aşımı sarmalayıcısı) zaten birleşti — ama İKİSİNİN de bugüne kadar HİÇBİR gerçek tüketicisi yok. ADR-0035 §(e) bunu bilinçli bir v0 riski olarak kaydetmişti ve F3-T2'nin bu iki fonksiyonun ilk gerçek çağıranı olacağını önceden belirtmişti. ADR-0035 §(a) ayrıca gerçek OS/VM kod izolasyonunu (`worker_threads`/`vm2`/`isolated-vm`) ertelemişti — gerekçesi "bugün koşturulacak hiçbir üçüncü-taraf/imzasız kod yok"du — ve bu kararın "F3-T2 gerçek beceri-kodu çalıştırma ihtiyacı doğurduğunda yeniden gözden geçirileceğini" açıkça not etmişti.
2. **İmzalama emsali eksikliği** — kod tabanındaki mevcut tüm imzalama/doğrulama emsalleri (`packages/shared` sır şifreleme, notetaker webhook kimlik doğrulama, giden webhook teslimat imzalama — bkz. ADR-0033) SİMETRİKtir (AES-256-GCM / HMAC-SHA256). "Bir beceri paketini kim imzaladı" sorusuna simetrik bir ilke doğru cevap veremez — doğrulayan taraf imzalayanla AYNI sırrı paylaşırsa, bu yalnızca tutarlılığı kanıtlar, yazarlığı kanıtlamaz.

Çözülmesi gereken merkezi soru (insan onaylı (a)/(b)/(d)/(e) hariç, bu ADR'nin görevi): kanonikleştirme + doğrulama akışının somut şekli (c), sürümleme kapsamının v1'de ne kadar derin olacağı (d içinde detaylandırılan architect kararı), F3-T1'in `checkPermission`/`executeAgentAction` sözleşmesiyle entegrasyonun tam sırası (f), ve F3-T3'e bırakılan açık uçların ne olduğu (g).

## Karar

### (a) Çalışma zamanı modeli — in-process, birinci-parti bağlı fonksiyon (insan kararı, aynen kayıt)

Beceriler (`skills`), `apps/server/src/skills/definitions/` altında yaşayan, derleme-zamanında bağlanmış TypeScript fonksiyonlarıdır — diskten/ağdan dinamik olarak yüklenen üçüncü-taraf kod DEĞİL. v1'in 20 becerisinin TAMAMI birinci-parti: bu repoda yazılır, normal PR süreciyle gözden geçirilir, kod tabanındaki başka herhangi bir sunucu koduyla AYNI derecede güvenilir kabul edilir.

**Gerekçe:** Bugün hâlâ gerçekten güvenilmeyen/üçüncü-taraf bir kod YOK. Bu nedenle ADR-0035 §(a)'nın ertelediği gerçek OS/VM izolasyonu bu görevle AÇIKÇA yeniden AÇILMIYOR — `executeAgentAction`'ın zaten var olan hafif sandbox'ı (`runInAgentSandbox` üzerinden zaman-aşımı yarışı, `AgentConcurrencyGuard` üzerinden eşzamanlılık tavanı, yapılandırılmış hata izolasyonu) yeterli kalır. Gerçek üçüncü-taraf/dinamik-yüklenen beceri kodu getiren gelecekteki bir görev, ADR-0035 §(a)'yı O NOKTADA yeniden açmak ZORUNDADIR — bu, kapatılmış değil, açıkça ERTELENMİŞ bir karar olarak bayraklanır.

### (b) İmzalama şeması — Ed25519 asimetrik imza (insan kararı, aynen kayıt)

Kod tabanındaki İLK asimetrik-imza ilkesi. Node'un yerleşik `crypto.sign`/`crypto.verify`'ı Ed25519 anahtarlarıyla kullanılır — yeni bir bağımlılık YOK. Derleme/yayın-zamanı bir imzalayıcı script özel anahtarı tutar (repoya asla commit edilmez, versiyon kontrolü dışında yaşar — ör. bir CI sırrı veya yerel geliştirme anahtarlığı); çalışma zamanı sunucusu yalnızca PUBLIC anahtarı, checked-in bir kaynak sabiti olarak gömer (public anahtarlar sır DEĞİLDİR — kaynağa gömmek doğrudur, tersi doğrulamayı anlamsız kılardı).

**Gerekçe (asimetrik > simetrik):** İmzalı bir paketin temel güvenlik özelliği "yalnızca yetkili imzalayan geçerli bir imza üretebilir, VE herhangi bir doğrulayıcı paylaşılan bir sır tutmadan bunu kontrol edebilir"dir — simetrik HMAC, doğrulayan sunucunun imzalamada kullanılan AYNI sırrı tutmasını gerektirirdi, bu da gerçekte yazarlığı kanıtlamaz, yalnızca tutarlılığı kanıtlar.

### (c) Kanonikleştirme + doğrulama akışı (architect kararı, gerekçeli)

`canonicalizeManifestForSigning(manifest imza alanı hariç)` TEK bir paylaşılan fonksiyondur — hem imzalayıcı script hem de çalışma-zamanı doğrulayıcı tarafından çağrılır. Bu, imza-uyuşmazlığı kaymasının (iki bağımsız yazılmış serileştirmenin asla birbirinden sapmaması) önüne geçer — bu SINIF hata bu kod tabanında zaten bir kez bilinçli olarak önlenmişti: F2-T16'nın webhook teslimat imzalaması, imzalanan ve iletilen gövde için AYNI paylaşılan `JSON.stringify` çağrısını kullanır, TAM AYNI gerekçeyle.

`verifySkillManifestSignature` ASLA throw ETMEZ — bozuk girdi, yanlış anahtar, kurcalanmış alan hepsi `false`'a çözülür, fail-closed — ADR-0035'in `evaluateManifestGrant`'ının (saf, fail-closed değerlendirici) AYNI konvansiyonunu yansıtır.

### (d) Sürümleme kapsamı — v1'de tek güncel versiyon per beceri (insan kararı, aynen kayıt)

Her beceri manifestosu bir semver `version` string'i taşır — elle yazılmış bir regex doğrulayıcı (`assertValidSemver`) ile doğrulanır, yeni bir `semver` paket bağımlılığı YOK (bu kadar basit bir şey için kütüphane eklemek yerine küçük saf doğrulayıcıları tercih eden kod tabanı geleneğiyle uyumlu). Ancak `SkillRegistry` becerileri YALNIZCA `id` ile anahtarlar, `id+version` DEĞİL — v1'de eşzamanlı çoklu-versiyon sunumu YOK.

**Gerekçe:** Bu "sürümleme", bugün gerçek yan-yana versiyon çözümlemesi inşa etmek için değil, uyumluluk-izleme kimliğini ŞİMDİDEN kurmak için kapsamlandırılmıştır — bu ancak dinamik-yüklenen/harici beceri dağıtımı var olduğunda (Karar (a) gereği kapsam dışı) gerçekten önem kazanır.

### (e) 20 beceri kataloğu + güvenlik-sınırı gerekçesi (architect kararı, gerekçeli — kritik dışlama insan onaylı)

20 becerinin TAMAMI, MEVCUT, zaten test edilmiş servis metotlarının (`ObjectsService`, `TaskRecurrenceService`, `MeetingsService`, `ContextService`, `ConnectedSearchService`, `CalendarEventsService`, `ai/answerQuestion`, `CommandsService`, `TriggerSuggestionsService` gibi) ince sarmalayıcılarıdır. Tam 20 beceri ID listesi `docs/specs/F3-E1/F3-T2-skill-sdk-v1.md`'de tanımlanır — bu ADR onu yeniden türetmez, referans verir.

**Kritik dışlama (açık bir mimari sınır olarak durur):** `CommandsService.decide`, `TriggerSuggestionsService.decide` (ADR-0015/ADR-0031/ADR-0032/ADR-0033/ADR-0034 boyunca kurulmuş öner→onayla fail-closed disiplinindeki insan-onay kontrol noktaları) ve workspace-yönetişimi yazma uç noktaları (`AutomationTriggersService.create/update/delete`, `WebhookSubscriptionsService.create/update/remove`, `McpClientGrantsService.grant/revoke` — tek bir çağrının ötesinde kalıcı, sistemik makine yaratan aksiyonlar, kapsamlı bir veri yazmasının aksine) HİÇBİR ajan izin-manifestosu grant'ına bakılmaksızın ASLA beceri olarak sarmalanmaz.

**Gerekçe:** `commands.service.ts`'yi okumak, mevcut çalıştırma-yolunun (`executeCreateTask` vb.) her zaman GERÇEK onaylayan insanın `actor`/`callerRole`'unu `ObjectsService`'e taşıdığını doğruladı — AI/tetikleyiciler bugün asla doğrudan çalıştırmaz, yalnızca önerir. Beceri kataloğu bu sınırı KORUR (doğrudan-yazma becerileri yalnızca ajanın kendi granted `dataScope`'u içindeki veride çalışır — bir `member`-rol insanın kendi erişilebilir verisinde zaten yapabileceğiyle eşleşir) — bunu yönetişim/kimlik-bilgisi/onay aksiyonlarına genişletmez.

### (f) F3-T1 entegrasyon sözleşimi (architect kararı — güvenlik değişmezi olarak bayraklı)

`SkillExecutionService.executeSkill(workspaceId, agentIdentifier, skillId, input)` TEK entegrasyon noktasıdır, sabit, opsiyonel-olmayan bir sıra ile:

1. Kayıt-defteri (`SkillRegistry`) araması.
2. `AgentPermissionManifestsService.checkPermission` — herhangi bir beceri kodu çalışmadan ÖNCE geçmelidir; bir ret, `skill.execute`'ün asla çağrılmadığı anlamına gelir.
3. `AgentResourceLimitsService.executeAgentAction`, gerçek çalıştırmayı sarmalar (hız sınırı, eşzamanlılık tavanı, sandbox zaman-aşımı, en-iyi-çaba denetim kaydı — F3-T1'den DEĞİŞTİRİLMEDEN miras alınır).

Bu sıralama kendi başına bir güvenlik değişmezi olarak açıkça bayraklanır: izin kontrolü KESİNLİKLE kaynak-sınırlı çalıştırmadan önce, ASLA tersi, ASLA atlanabilir değil.

### (g) F3-T3'e ileriye dönük ilişki (architect kararı)

Bu görev `SkillExecutionService`'i HİÇBİR HTTP denetleyici/rota OLMADAN inşa eder (ADR-0035 §(h)'nin "v0'da UI yok" ilkesiyle tutarlı — bu iç bir kütüphane yüzeyidir). F3-T3 (ajan-insan etkileşimi: @mention, görev atama, DM tabanlı ajan yeniden yapılandırma), `SkillExecutionService`'in ilk gerçek çağıranı/tüketicisi olması beklenir — TAM OLARAK ADR-0035 §(e)'nin bu görevin `checkPermission`/`executeAgentAction`'ın ilk gerçek çağıranı olacağını önceden belirttiği gibi.

## Alternatifler ve Reddedilme Gerekçeleri

- **Dinamik/üçüncü-taraf kod yükleme.** Reddedildi (Karar a) — gerçek kod-imzalama DOĞRULAMASI (kim imzaladı, güvenilir mi) ve gerçek çalışma-zamanı izolasyonu (`worker_threads`/`vm2`/`isolated-vm`) gerektirirdi, çok daha büyük kapsam; bugün karşılanacak gerçek bir tehdit yok.
- **Simetrik HMAC imzalama.** Reddedildi (Karar b) — mevcut deseni (webhook/sır şifreleme) tekrarlardı ama doğrulayanın imzalayanla AYNI sırrı paylaşmasını gerektirirdi, "yalnızca yetkili imzalayan üretebilir" garantisini sağlamazdı.
- **`decide()`/yönetişim uç noktalarını da katalog için düşünmek.** Reddedildi (Karar e) — mevcut öner→onayla fail-closed disiplinini (ADR-0015 soyu) zayıflatırdı; bu ADR bunun yerine mevcut sınırı korumayı seçer.

## Mimari Değişmezlerle İlişki

- **"Tek doğruluk kaynağı olay günlüğüdür; bağlam grafiği ve tüm projeksiyonlar türetilir."** Bu ADR bu değişmezi değiştirmez — beceri manifestoları statik, imzalı yapılandırma verisidir (kod-yanı, event-sourced projeksiyon DEĞİL); becerilerin ÇALIŞTIRILMASI ise F3-T1'in zaten olay-kaynaklı denetim defterinden (`agent_action_executions`) geçer.
- **"Ajan aksiyonları `{niyet, gerekçe, kaynaklar[], geri_alma_planı}` sözleşmesine uyar."** Bu ADR bu sözleşmeyi DEĞİŞTİRMEZ — `executeSkill`'in izin-kontrolü → kaynak-sınırlı-çalıştırma sırası (Karar f) bu sözleşmenin YERİNE geçmez, yalnızca çalıştırma-zamanı yetkilendirme/izolasyon mekanizmasıdır.
- **"Veri dışa aktarma hiçbir planda/kodda kısıtlanamaz."** Bu ADR hiçbir export uç noktasına dokunmuyor.
- **Hassas veri sınıflarının buluta ham gönderilmemesi.** Bu ADR'nin beceri kataloğu (Karar e) yalnızca ajanın kendi granted `dataScope`'u içinde çalışır; hangi veri sınıfının hangi bulut sağlayıcısına gönderileceği sınıflandırma/yönlendirme mantığına dokunmaz — bu, F3-T12'nin (Hibrit AI) kapsamı.

## Sonuçlar / Ödünler

**Şimdi ne kazanıyoruz:**

- ADR-0035 §(e)'nin önceden işaret ettiği "F3-T2'nin ilk gerçek çağıran olacağı" vaadi kapandı — `checkPermission`/`executeAgentAction` artık gerçek, canlı bir tüketiciye sahip.
- Kod tabanının ilk asimetrik-imza ilkesi (Ed25519), tek-paylaşılan-kanonikleştirme deseniyle (Karar c), gelecekteki herhangi bir imzalama ihtiyacı için kanıtlanmış bir şablon bırakıyor.
- Öner→onayla fail-closed disiplini (ADR-0015 soyu) beceri kataloğuna GENİŞLETİLMEDİ, KORUNDU — 20 yeni ajan yeteneği eklenirken hiçbir mevcut insan-onay kontrol noktası zayıflatılmadı.

**Neyi erteliyoruz / kabul ediyoruz:**

- Gerçek üçüncü-taraf/dinamik-yüklenen beceri dağıtımı getiren gelecekteki bir görev, ADR-0035 §(a)'yı (gerçek OS/VM izolasyonu) YENİDEN AÇMAK zorundadır — bu görev onu kapatmadı, yalnızca bugün için gereksiz olduğunu yeniden doğruladı.
- F3-T3, hem F3-T1'in `AgentPermissionManifestsService`/`AgentResourceLimitsService`'inin (bu görev üzerinden) hem de bizzat `SkillExecutionService`'in ilk gerçek tüketicisi olacak — ADR-0035 §(e)'nin kabul ettiği AYNI YAGNI riskinin bir katmanı daha.
- Dışlanan-uç-nokta sınırı (Karar e) sessizce değil, AÇIKÇA yeniden gözden geçirilmelidir — gelecekteki herhangi bir görev `decide()`/yönetişim aksiyonlarını ajanlara açmayı düşünürse, dokunacağı değişmez göz önüne alındığında KENDİ ADR'sini gerektirir.
- Sürümleme (Karar d) v1'de yalnızca kimlik-izleme amaçlıdır; gerçek yan-yana versiyon çözümlemesi ayrı bir görev/karar gerektirecek.

---

**Sıradaki adım:** Spec dosyası (`docs/specs/F3-E1/F3-T2-skill-sdk-v1.md`) tamamlandı, ikisi de onaylı. Sıradaki adım PR1 için `test-writer`'ı çağırmak (`packages/skill-sdk` çekirdeği — saf domain, imza doğrulama):

```
docs/adr/ADR-0036-skill-sdk-v1.md'deki Karar (a)-(g)'yi ve docs/specs/F3-E1/F3-T2-skill-sdk-v1.md'nin
Kabul Kriterleri'ni temel alarak, F3-T2 PR1 (packages/skill-sdk çekirdeği: SkillManifest tipleri,
canonicalizeManifestForSigning, verifySkillManifestSignature, assertValidSemver, Skill<TInput,TOutput>,
SkillRegistry) için test-writer ile başarısız testleri yaz.
```
