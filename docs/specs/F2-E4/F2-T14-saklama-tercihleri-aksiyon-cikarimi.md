# F2-T14 — Saklama Tercihleri + Otomatik Aksiyon Çıkarımı → Onaylı Görev Üretimi

**Epik:** F2-E4 (Toplantı Zekâsı, Kapsam H) · **Durum:** Taslak — insan onayına sunuluyor.
**Bağımlılık:** F2-T13/ADR-0029/ADR-0030 (notetaker botu + hibrit-AI veri sınıflandırması, Tamamlandı — bu görev doğrudan üzerine inşa ediyor), F1-T16/ADR-0015 (konuşma-komutları öner→karar-ver akışı, emsal — BU görev aynı iki-fazlı öneri/onay desenini transkript-kaynaklı aksiyonlara genişletiyor).

> ⚠️ MİMARİ-KARAR GEREKTİREN GÖREV — CLAUDE.md'nin ADR kriterinin (b) fıkrasına giriyor: bu görevin "transkriptten çıkarılan aksiyon → onaylı görev" akışını NASIL modellediği (ADR-0015'in mevcut `command_proposals`/`ActionsProposed` şemasını genişletmek mi, yoksa yeni, ayrı bir öneri akışı açmak mı) F2-T15'in ("Tetikleyici/koşul/aksiyon çekirdeği") ve F2-T16'nın ("otomasyon geçmişi/denetim ekranı") üzerine inşa edeceği bir sözleşim. `architect`'in bu forku netleştiren bir taslak + insan onayı koddan önce gerekli — ancak ADR-0029/0030'un aksine, bu YENİ bir ADR dosyası GEREKTİRMEYEBİLİR (mevcut ADR-0015'in bir "genişletme eki" / "Sonuçlar" bölümü güncellemesi yeterli olabilir); kesin karar `architect`'e bırakılıyor.

## Amaç

F2-T13'ün ürettiği ham `meeting_details` verisini (transkript metni, kayıt referansı) kullanıcının tercihine göre İŞLEMEK: (1) bu verinin ne kadar süre/hangi biçimde saklanacağına dair kullanıcı/workspace tercihini tanımlamak ve uygulamak, (2) transkript metninden aksiyon maddelerini (action items) AI ile çıkarıp, ADR-0015'in öner→onayla desenine benzer şekilde, kullanıcı onayı olmadan hiçbir `task` nesnesi oluşturmadan önce bir öneri olarak sunmak.

## Mevcut Durum (bir `explorer` dispatch'i ile doğrulandı)

- **`packages/automation/` henüz YOK.** `docs/PLAN.md`'nin mimari haritasındaki (`docs/PLAN.md:84`) bir referans dışında gerçek bir paket olarak mevcut değil. F2-T15 ("Tetikleyici/koşul/aksiyon çekirdeği") AYRI ve SONRAKİ bir epik/görev — bu görev, henüz var olmayan bir tetikleyici/koşul motoruna BAĞIMLI OLAMAZ; yalnızca "transkript hazır olduğunda" tek, sabit bir tetikleyici noktasına (webhook sonrası) ihtiyaç duyar.
- **`{niyet, gerekçe, kaynaklar[], geri_alma_planı}` sözleşmesi zaten var, ama paylaşılan bir tip olarak DEĞİL.** `apps/server/src/ai/parse-command.ts:26-34`'teki `ProposedAction` arayüzü (`intent`, `rationale`, `resources`, `rollbackNote`) + zod karşılığı `proposedActionSchema` (aynı dosya, 53-62) bu sözleşimi F1-T16'nın KENDİ event payload'unda uyguluyor — `packages/shared/src/events/domain-event.ts`'nin paylaşılan `actorSchema`'sı kasıtlı olarak dokunulmadı (ADR-0015 §a, satır 16/28/55/108 — bu genelleştirme AÇIKÇA gelecekteki bir göreve/ADR'ye bırakıldı, satır 125). **Bu görev, sözleşmeyi paylaşılan bir tipe çıkarıp çıkarmayacağına karar vermeli** (Açık Soru 2).
- **AI-taslağı → insan-onaylı gerçek nesne akışı ZATEN VAR ve doğrudan yeniden kullanılabilir.** `apps/server/src/commands/commands.service.ts`'in `parse()` metodu (157-213) AI gateway'i çağırır, çıktıyı doğrular, SIFIR mutasyonla bir `ActionsProposed` olayını ayrı bir `action-proposal` akışına kaydeder (projeksiyonu: `apps/server/src/db/schema/command-proposals.ts`). `decide()` metodu (245-369) bugün AI-türetilmiş bir taslağın gerçek bir nesneye dönüştüğü TEK yer — her aksiyon tek tek, açık insan onayıyla (`decision: 'approved'|'rejected'`), onaylanmayan her şeyde fail-closed. Onaylanan `createTask`/`generateSubtasks` aksiyonları normal `ObjectsService.create()`'i çağırıyor (satır 423, 468). **Bu görev muhtemelen bu deseni GENİŞLETMELİ** (yeni bir aksiyon tipi, ör. `createTaskFromMeeting`, ekleyerek) — yeni bir öneri akışı icat etmek yerine (Açık Soru 2).
- **`packages/ai-gateway` genişletme GEREKTİRMİYOR.** `AIProvider.complete()` (`packages/ai-gateway/src/provider.ts:35-37`) hâlâ `{prompt, maxTokens?, model?} → {text, usage, model?}` — JSON/tool-use modu yok (ADR-0015 §e bunu AÇIKÇA reddetti). Yapılandırılmış çıkarım için mevcut desen: sıkı JSON isteyen bir prompt + `JSON.parse` + zod doğrulama + bir kez yeniden deneme + throw-etmeyen bir başarısızlık sentinel'i döndürme — `parse-command.ts:101-128`'in `{actions: [], parseError: true, message}` sentinel'i BİREBİR takip edilecek desen.
- **Saklama/tercih için mevcut bir şema deseni YOK.** `apps/server/src/db/schema/` genelinde `preference`/`settings` için sıfır eşleşme; `workspaces.ts` bir config/JSON kolonu taşımıyor. En yakın emsal `desktop_signal_consents.ts`/`memory_access_policies.ts`'in per-(workspace, user, category) onay-satırı deseni (grant/revoke boole) — ama "saklama tercihi" (kayıt/transkript/yalnız-özet arasında bir SEÇİM) bir grant/revoke boole'undan farklı, isimlendirilmiş seçenekler arası bir seçim. **Bu görev muhtemelen küçük, YENİ bir tercih tablosu açmalı** (workspace mi user mı kapsamlı olduğu Açık Soru 1'in konusu).
- **ADR-0029/ADR-0030 saklama/silmeyi AÇIKÇA bu göreve bırakıyor.** ADR-0030 satır 213: _"(b) `meeting_details` satırları için saklama/silme politikası YOK — bir transkriptin ne kadar süre tutulacağı, kullanıcının 'sil' diyebileceği bir mekanizma bu ADR'nin kapsamında değil; F2-T14'ün ('Saklama tercihleri + otomatik aksiyon çıkarımı') doğrudan işi."_ ADR-0029 yalnızca veri SINIFLANDIRMASINI ve dışa-giden ağ sınırını kapsıyor, saklama süresi hakkında hiçbir şey söylemiyor.
- **`ObjectType`/`task` üzerinde "AI-önerisi, onay bekliyor" bayrağı için mevcut bir alan YOK.** `LuminaObject` (`packages/core-objects/src/lumina-object.ts:45-57`) böyle bir `status`/`source` kolonu taşımıyor; `task` durumu tamamen dinamik custom-field sistemiyle yönetiliyor. `command_proposals` yan-tablo deseni (yukarıdaki madde) bu görevin "onay bekleyen aksiyon" ihtiyacı için `task` nesnesinin kendisinden çok daha güçlü, doğrudan uygulanabilir bir emsal.

## Kapsam

1. **Saklama tercihi tanımı ve uygulanması** — kullanıcının/workspace'in bir toplantı için (veya workspace-genelinde varsayılan olarak) `kayıt-referansı-tut` | `yalnız-transkript-tut` | `yalnız-özet-tut` arasında seçim yapabildiği yeni, küçük bir tercih şeması + bu tercihe göre `meeting_details` satırlarını (veya alanlarını) periyodik/olay-tetiklemeli temizleyen bir mekanizma.
2. **Transkriptten aksiyon maddesi çıkarımı** — `packages/ai-gateway` üzerinden (yeni bir yetenek eklemeden, mevcut `complete()` + JSON-prompt + zod-doğrulama deseniyle) transkript metninden yapılandırılmış aksiyon maddeleri (ör. `{title, assigneeHint?, dueDateHint?}` listesi) çıkarır.
3. **Onaylı görev üretimi** — çıkarılan her aksiyon maddesi, ADR-0015'in öner→onayla desenine (muhtemelen genişletilmiş hâliyle) uygun olarak kullanıcıya sunulur; yalnızca AÇIKÇA onaylanan maddeler gerçek bir `task` nesnesine dönüşür (mevcut `ObjectsService.create()` üzerinden, yeni bir CRUD icat edilmeden).
4. **Webhook sonrası tetikleme noktası** — F2-T13'ün `NotetakerWebhookController`'ının transkript alanını doldurduğu ANDA (sabit, tek bir tetikleyici — F2-T15'in genel tetikleyici motoruna bağımlı olmadan) aksiyon-çıkarımı akışını başlatan bağlantı noktası.

## Kapsam DIŞI

- **F2-T15'in genel tetikleyici/koşul/aksiyon çekirdeği** (zamanlanmış tetikleyiciler, regex koşullar) — bu görev yalnızca TEK, sabit bir tetikleyici noktasına (transkript-hazır webhook'u) ihtiyaç duyar, genel bir motor İNŞA ETMEZ.
- **F2-T16'nın otomasyon geçmişi/denetim ekranı** — bu görevin ürettiği öneri/onay olayları F2-T16'nın denetim ekranı için VERİ üretir, ama ekranın kendisi bu görevin kapsamında değil.
- **Diarization/katılımcı-bazlı aksiyon atama** (F2-T13'te de ertelendi) — aksiyon maddeleri konuşmacıya göre ayrıştırılmaz.
- **Kayıt dosyasının LuminaOS'in kendi deposuna indirilmesi** — ADR-0030'un kararı (yalnızca referans saklama) bu görevde DEĞİŞTİRİLMİYOR; "saklama tercihi" yalnızca REFERANSIN/transkript metninin ne kadar süre tutulacağını kapsıyor, ham medyayı LuminaOS'e taşımıyor.

## Açık Sorular

1. **[KRİTİK] Saklama tercihi hangi kapsamda tutulur — workspace mi, kullanıcı mı?**
   - **Bağlam:** Mevcut en yakın emsal (`desktop_signal_consents`/`memory_access_policies`) per-user, ama bir toplantının saklama politikası daha çok bir workspace-yönetişim kararına benziyor (ADR-0029'un kademe-1/2 için "workspace-seviyeli politika" ayrımıyla tutarlı). `architect`/insan kararı gerekli.
2. **[KRİTİK] Aksiyon-çıkarımı → onay akışı: ADR-0015'in `command_proposals`/`ActionsProposed` şemasını yeni bir aksiyon tipiyle (`createTaskFromMeeting`) mi genişletir, yoksa ayrı bir öneri akışı mı açar?**
   - **Öneri:** Mevcut şemayı genişletmek — aynı iki-fazlı öner/onayla API'sini, aynı aktör-atfı disiplinini yeniden kullanmak, F2-T15/F2-T16'nın da tek bir "öneri" kavramı üzerine inşa edebilmesini sağlar. Kesin şekli (yeni ADR mi, ADR-0015'e ek mi) `architect` belirler.
3. **Saklama tercihi varsayılanı ne olmalı?**
   - **Öneri:** En kısıtlayıcı varsayılan — ADR-0029'un "sıkı opt-in" ruhuyla tutarlı olarak, açıkça bir tercih seçilmediyse yalnızca özet (varsa) tutulur, ham transkript belirli bir süre sonra (ör. 30 gün) otomatik temizlenir.
4. **Aksiyon çıkarımı hangi biçimde önerilir — tek seferde toplu mu, madde madde mi onaylanır?**
   - **Öneri:** ADR-0015'in `decide()` deseniyle tutarlı olarak madde madde (her aksiyon kendi onay/red kararını taşır), toplu "tümünü onayla" bir UI kolaylığı olarak eklenebilir ama alttaki veri modeli madde-bazlı kalır.
5. **Saklama süresi geçmiş bir transkript silindiğinde, o transkriptten daha önce üretilmiş (onaylanmış) `task` nesnelerine ne olur?**
   - **Öneri:** Hiçbir şey — `task` nesnesi bağımsız bir LuminaObject'tir, kaynağı silinen transkriptin varlığına bağımlı değildir (olay-kaynaklı mimarinin "türetilmiş projeksiyonlar silinebilir, olay günlüğü kalıcıdır" ilkesiyle tutarlı, ama transkript BİR PROJEKSİYON DEĞİL, ham veri — bu nedenle bu, `architect`'in ADR-0029/0030'un olay-günlüğü/ham-veri ayrımıyla nasıl uyumlu olduğunu netleştirmesi gereken ince bir nokta).

## Kabul Kriterleri

- [ ] Açık Soru 1-5'in insan kararları netleşti (gerekirse `architect` taslağıyla) ve insan onayından önce sunuldu.
- [ ] Kullanıcı/workspace bir saklama tercihi (kayıt-referansı/transkript/yalnız-özet) seçebilir; tercih uygulanır (varsayılan en kısıtlayıcı).
- [ ] Transkript metninden aksiyon maddeleri AI ile çıkarılır (mevcut `ai-gateway` + JSON-prompt + zod deseniyle, yeni bir gateway yeteneği eklenmeden).
- [ ] Çıkarılan hiçbir aksiyon, AÇIKÇA onaylanmadan gerçek bir `task` nesnesine dönüşmez (ADR-0015'in öner→onayla desenine uygun, fail-closed).
- [ ] Cross-workspace izolasyon: bir workspace'in aksiyon önerisi/saklama tercihi başka bir workspace'i asla etkilemez.
- [ ] Testler: saklama tercihinin gerçekten uygulandığı (süre dolduğunda transkript temizlenir), aksiyon çıkarımının doğru JSON şeklini ürettiği, onaylanmayan aksiyonun asla `task` oluşturmadığı, cross-workspace izolasyonu.
- [ ] `security-reviewer` denetiminde bulgu yok (özellikle: onay akışının gerçekten bypass edilemediği, saklama-süresi-dolmuş verinin gerçekten silindiği).
- [ ] `pnpm typecheck && pnpm lint && pnpm test:changed` yeşil.

---

**Sıradaki adım:** Bu spec taslağı insan onayına sunulur. Onaylanırsa Plan Mode'a geçilip Açık Sorular 1-5'in insan kararları (özellikle Açık Soru 2'nin mimari forku) `architect` subagent'ı ile netleştirilir; ardından `test-writer` → `implementer` → `security-reviewer` ritüeline geçilir.
