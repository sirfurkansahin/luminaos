# F3-T6 — Tek Tık Geri Alma: Ters Olay Üretimiyle Atomik Geri Sarma

**Epik:** F3-E2 (Cam Kutu Otonomi, Kapsam K) · **Durum:** PLANLANDI — Epik F3-E2'nin SON görevi, F3-T5'ten (Otonomi Kadranı) sonra gelir. Mimari karar `docs/adr/ADR-0040-tek-tik-geri-alma.md`'de tam resmileşti — bu spec o ADR'yi görev kapsamına (amaç/kapsam/PR bölünmesi/kabul kriterleri) çevirir, yeniden türetmez.
**Bağımlılık:** F3-T4/ADR-0038 (Ajan Aksiyon Kayıt Defteri) TAMAMEN kapandı — bu görev, o ADR'nin `AgentActionRecord.rollbackPlan` şeklini (bugüne kadar salt açıklayıcı, hiçbir yerde YÜRÜTÜLMEYEN) ilk kez gerçekten yürütülebilir hale getirir. F3-T5/ADR-0039 (Otonomi Kadranı) TAMAMEN kapandı, PR #225-#228 `main`'e merge edildi — bu görev onun `AgentActionRecordsService`/ledger disiplinini DEĞİŞTİRMEDEN üçüncü bir çağıran ekler.

## Amaç

Bugün `RollbackPlan` (ADR-0038, F3-T4) salt açıklayıcıdır — kod tabanında hiçbir yer `.rollbackPlan`'ı OKUYUP gerçek bir tersine çevirme YÜRÜTMÜYOR. Bu görev, `kind:'delete'` yazan geri alma planlarını GERÇEKTEN yürütülebilir hale getiren yeni bir `CommandsService.undoAction()` metodu ekler — `FlightRecorderPanel`'in kendi uzun süredir açık kalan doc-yorumunu ("henüz geri al butonu yok, bu F3-T6'nın kapsamı") kapatır. Tasarımın tamamı `docs/adr/ADR-0040-tek-tik-geri-alma.md` Karar (a)-(g)'de sabitlendi; bu spec onu görev/PR/kabul-kriteri şekline çevirir.

## Kapsam

1. **`undoesRecordId` alanı** — `AgentActionRecord`/`agentActionRecordedPayloadSchema`/DB şeması yeni, nullable bir `undoesRecordId: string | null` alanı kazanır (+ migration + down script + salt sorgu-performansı için unique OLMAYAN bir index) — `packages/agent-runtime/src/agent-action-record.ts` + `agent-action-record-events.ts`, `apps/server/src/db/schema/agent-action-records.ts` (ADR-0040 Karar c).
2. **`AgentActionRecordsService.findUndoRecord`** — `findUndoRecord(workspaceId, originalRecordId)` (internal-only, RBAC yok, "zaten geri alınmış" `ConflictError` UX yolu için ön-kontrol — GERÇEK eşzamanlılık garantisi DEĞİL) (ADR-0040 Karar f).
3. **`CommandsService.undoAction`** — `undoAction(workspaceId, recordId, actor, callerRole)`: orijinal kaydı VAR OLAN `AgentActionRecordsService.get()` ile alır, `rollbackPlan.kind !== 'delete'` ise `ValidationError` fırlatır, zaten geri alınmışsa `ConflictError` fırlatır, orijinal kaydın KENDİ `resources[]`'ini (`rollbackPlan.targetResource` DEĞİL — `generateSubtasks`'ta bu alan YOK) dolaşıp her `kind:'object'` kaynak için `ObjectsService.softDelete` çağırır, sonra yeni bir `recordUndoLedgerEntry` yardımcısıyla BAĞIMSIZ, İKİNCİ bir ledger satırı yazar (orijinal satır ASLA güncellenmez) — sabit `actionType:'undoAction'`, sabit intent/rationale şablonları, `provenance:'decided'` (yeniden kullanılır, yeni bir enum değeri DEĞİL), `causationEventId:null`, `rollbackPlan:{kind:'none', ...}` (bir geri alma kendisi geri alınamaz), `undoesRecordId: original.id` (ADR-0040 Karar c/d).
4. **Yeni HTTP rotası** — `POST /workspaces/:workspaceId/agent-action-records/:id/undo`, `AgentActionRecordsController`'ın ilk-defa yazma rotası (bilinçli, kapsamlı bir "salt-okunur" istisnası) — `member`+ RBAC (controller'ın mevcut `get`/`list` kapısını yansıtır, daha katı bir taban EKLENMEZ) (ADR-0040 Karar e/g).
5. **Modül kablolaması** — `AgentRuntimeModule`, controller'ın `undoAction`'a delege edebilmesi için `CommandsModule` üzerinden `CommandsService`'e ihtiyaç duyar — `CommandsModule` ZATEN `AgentRuntimeModule`'ü import ettiğinden bir `AgentRuntimeModule ↔ CommandsModule` döngüsü açılır, her iki kenarda da `forwardRef()` ile çözülür — F3-T5'in ZATEN belgelediği `CommandsModule ↔ CommentsModule` döngü-düzeltmesiyle AYNI desen (ADR-0040 Karar g).
6. **Frontend** — `FlightRecorderPanel.tsx` her kayıt için gerçek bir "Geri al" butonu kazanır, YALNIZCA `record.rollbackPlan.kind === 'delete'` VE kayıt henüz geri alınmamışsa (yani `undoesRecordId`'si bu kayda işaret eden başka bir ledger satırı yoksa) etkin/görünür olur — diğer her `rollbackPlan.kind` için ya buton YOK ya da "bu aksiyon otomatik geri alınamaz" mesajıyla açıkça devre dışı. Yeni `useUndoActionMutation` hook'u + `apiClient.ts` eklentisi, F3-T5 PR3'ün kurduğu konvansiyonları izler (sunucunun ZATEN uyguladığının ötesinde client-side RBAC kapısı YOK, mutasyon-hatası yüzeye çıkarma) (ADR-0040 Karar a/g).

## 2 Bağlayıcı İnsan Kararı

- **Kapsam DAR: yalnızca `kind:'delete'` yazan 4 aksiyon türü.** `createTask`/`createTaskFromTrigger`/`createTaskFromMeeting`/`generateSubtasks` bu görevde GERÇEK, yürütülebilir geri alma kazanır; `assignPeople` (`revertFieldValue`) ve `reconfigureAgentPermissions` (`revokePermission`/`manual`) HİÇBİR yeni tersine-çevirme mekanizması KAZANMAZ — bilinçli erteleme, unutma DEĞİL (ADR-0040 Karar a).
- **v0'da hiçbir eskime/bağımlılık emniyet kontrolü veya zaman-penceresi kısıtlaması YOK.** Geri alma KOŞULSUZ yürütülür (hedef nesne orijinal aksiyondan sonra yorum/alt-öğe/düzenleme kazanmış olsa bile) — kod tabanındaki HER MEVCUT yaşam-döngüsü geçişiyle TUTARLI (ADR-0040 Karar b).

## Mimari Özet

(Tam gerekçe/kod için `docs/adr/ADR-0040-tek-tik-geri-alma.md` Karar (a)-(g) referans alınmalı — burada yalnızca özetlenir.)

- **(a) Kapsam:** Yalnızca `kind:'delete'` — insan kararı; `assignPeople`/`reconfigureAgentPermissions` bu görevin kapsamı DIŞINDA bırakılır.
- **(b) Emniyet kontrolü yok:** İnsan kararı; `undoAction` hedef nesnenin geri alma anındaki durumunu HİÇ sorgulamaz, zaman-penceresi kısıtlaması yok.
- **(c) Geri-alınmış temsili:** YENİ, İKİNCİ bir `AgentActionRecord` satırı + geriye-işaret-eden `undoesRecordId`; orijinal satır ASLA update edilmez — `ActionsDecided`'ın `ActionsProposed`'u asla yeniden yazmaması İLE AYNI desen.
- **(d) Yürütme yeri:** `CommandsService.undoAction`, YENİ servis/paket AÇILMAZ; orijinal kaydın KENDİ `resources[]`'inden okur (`rollbackPlan.targetResource` DEĞİL); yön `softDelete` (`archive` DEĞİL) — orijinal `rollbackPlan.description`'ın kendi metni zaten "sil" diyor.
- **(e) RBAC:** `member`+ — ledger okumasıyla (`AgentActionRecordsService.get()`) AYNI kapı; yeni bir actor-kimlik kısıtlaması İCAT EDİLMEZ.
- **(f) Çifte-geri-alma önleme:** `findUndoRecord` ön-kontrolü UX için (temiz `ConflictError` mesajı); GERÇEK yarış-güvenliği `ObjectsService.softDelete`'in KENDİ optimistic-concurrency + durum-makinesi korumasından MİRAS alınır, ledger tarafında yeni bir eşzamanlılık ilkeli İCAT EDİLMEZ.
- **(g) HTTP yüzeyi:** Yeni `POST .../:id/undo` rotası `AgentActionRecordsController`'a eklenir (bilinçli, kapsamlı bir "salt-okunur" istisnası, `CommandsController`'a DEĞİL); doğan `AgentRuntimeModule ↔ CommandsModule` döngüsü `forwardRef()` ile çözülür.

**RBAC özeti:** Geri alma tetikleme (`POST .../:id/undo` → `undoAction`) = `member`+ (ledger okumasıyla aynı kapı, daha katı bir taban EKLENMEZ); `findUndoRecord` internal-only, kapısız (yalnızca `undoAction`'ın kendi `member`+ kontrolünün ARKASINDA çağrılır).

## PR Bölünmesi (3 PR, tek plan onayı hepsini kapsar)

1. **PR1 — Domain + ledger altyapısı (backend).** `undoesRecordId` alanı/şeması/migration/projeksiyon (`packages/agent-runtime/src/agent-action-record.ts` + `agent-action-record-events.ts`, `apps/server/src/db/schema/agent-action-records.ts`, projeksiyon) + `AgentActionRecordsService.findUndoRecord`. Integration testler: alan doğru yazılıyor/okunuyor, `findUndoRecord` doğru satırı buluyor/bulamıyor, migration+down script çalışıyor.
2. **PR2 — `CommandsService.undoAction` + HTTP yüzeyi.** `undoAction`/`recordUndoLedgerEntry`, `AgentActionRecordsController`'ın yeni `POST :id/undo` rotası, `forwardRef()` modül-döngü çözümü (`AgentRuntimeModule` + `CommandsModule`). Integration testler: `kind:'delete'` başarıyla geri alınır (tek-nesne VE `generateSubtasks`'ın çoklu-nesne durumu), `kind !== 'delete'` için `ValidationError`, zaten-geri-alınmış için `ConflictError`, ikinci ledger satırının doğru `undoesRecordId`/`provenance`/`rollbackPlan:{kind:'none'}` ile yazıldığı, orijinal satırın HİÇ değişmediği, RBAC (`member`+ yeterli, `guest` reddedilir).
3. **PR3 — Frontend.** `FlightRecorderPanel.tsx`'e "Geri al" butonu + `useUndoActionMutation` hook'u + `apiClient.ts` eklentisi. Testler: buton yalnızca `kind:'delete'` VE henüz geri alınmamış kayıtlarda görünür/etkin, tıklama mutasyonu doğru `recordId` ile çağırır, mutasyon hatası (ör. zaten geri alınmış → 409) görünür bir hata olarak yüzeye çıkar.

## Kapsam Dışı

- **`assignPeople`/`reconfigureAgentPermissions` için gerçek geri-alma mekanizması** — ayrı, gelecekteki bir görev/ADR gerektirir (ADR-0040 Karar a, insan kararı).
- **Eskime/bağımlılık emniyet kontrolü** — hedef nesnenin geri alma anındaki durumu HİÇ sorgulanmaz (ADR-0040 Karar b, insan kararı).
- **Zaman-penceresi kısıtlaması** — "yalnızca N dakika içinde geri alınabilir" gibi bir kontrol İCAT EDİLMEZ (ADR-0040 Karar b).
- **`undoesRecordId` için DB-seviyesi unique-constraint/kilit** — index salt sorgu-performansı içindir, eşzamanlılık garantisi `ObjectsService.softDelete`'ten miras alınır (ADR-0040 Karar f).
- **Geri-almanın-geri-alınması** — kasıtlı olarak `rollbackPlan:{kind:'none'}` ile engellenir, sonsuz zincir açılmaz (ADR-0040 Karar c).

## Kabul Kriterleri

- [ ] **PR1:** `AgentActionRecord`/`agentActionRecordedPayloadSchema`'ya eklenen `undoesRecordId: string | null` alanı normal kayıtlarda `null`, geri-alma kaydında orijinalin `id`'sine doğru yazılıyor/okunuyor.
- [ ] **PR1:** `agent_action_records` tablosuna `undoes_record_id` kolonu + salt sorgu-performansı için (UNIQUE OLMAYAN) index eklendi; migration'ın down script'i mevcut ve geri-alma test edilmiş.
- [ ] **PR1:** `AgentActionRecordsService.findUndoRecord(workspaceId, originalRecordId)` var olan bir geri-alma kaydını doğru buluyor, yokken `null` dönüyor; internal-only (RBAC/`callerRole` parametresi YOK).
- [ ] **PR1:** `pnpm --filter @luminaos/agent-runtime typecheck && lint && test:changed` VE `pnpm --filter @luminaos/server typecheck && lint && test:changed` yeşil; `security-reviewer` bulgusuz.
- [ ] **PR2:** `undoAction`, `rollbackPlan.kind === 'delete'` olan bir kaydı başarıyla geri alır — tek-nesne (`createTask`/`createTaskFromTrigger`/`createTaskFromMeeting`) VE çoklu-nesne (`generateSubtasks`, `resources[]` üzerinden) durumları AYRI AYRI kanıtlanır.
- [ ] **PR2:** `undoAction`, `resources[]`'İ okur — `rollbackPlan.targetResource`'İ DEĞİL (bu alan `generateSubtasks` kayıtlarında YOK); her `kind:'object'` kaynak için `ObjectsService.softDelete` çağrıldığı doğrulanır.
- [ ] **PR2:** `rollbackPlan.kind !== 'delete'` olan bir kayıt üzerinde `undoAction` çağrısı `ValidationError` fırlatır (yeni tersine-çevirme kodu YAZILMAZ).
- [ ] **PR2:** Zaten geri alınmış bir kayıt üzerinde ikinci `undoAction` çağrısı `ConflictError` fırlatır (`findUndoRecord` ön-kontrolü üzerinden).
- [ ] **PR2:** Geri alma başarılı olduğunda YENİ, BAĞIMSIZ bir ikinci ledger satırı yazılır — `actionType:'undoAction'`, `provenance:'decided'`, `causationEventId:null`, `rollbackPlan:{kind:'none', ...}`, `undoesRecordId: original.id` — ve **orijinal satır HİÇ değişmeden kalır** (satırın tüm alanları geri alma öncesi/sonrası birebir aynı).
- [ ] **PR2:** Yeni `POST /workspaces/:workspaceId/agent-action-records/:id/undo` rotası RBAC doğrulanır — `member`+ yeterli, `guest` reddedilir (ledger okumasıyla AYNI taban, daha katı bir kapı EKLENMEZ).
- [ ] **PR2:** `AgentRuntimeModule ↔ CommandsModule` döngüsü `forwardRef()` ile her iki kenarda da çözülür; uygulama gerçekten boot olur (regresyon: mevcut hiçbir modül-kablolaması bozulmaz).
- [ ] **PR2:** `pnpm --filter @luminaos/server typecheck && lint && test:changed` yeşil; `security-reviewer` bulgusuz (özellikle: RBAC'ın gerçekten `member`+ ile sınırlı olduğu, çifte-geri-almanın ledger'da iki satır üretmediği).
- [ ] **PR3:** "Geri al" butonu YALNIZCA `record.rollbackPlan.kind === 'delete'` VE kayıt henüz geri alınmamışken görünür/etkin; diğer her `kind` için buton yok ya da "bu aksiyon otomatik geri alınamaz" mesajıyla devre dışı.
- [ ] **PR3:** Butona tıklama, `useUndoActionMutation` üzerinden doğru `recordId` ile mutasyonu tetikler.
- [ ] **PR3:** Mutasyon hatası (ör. sunucudan 409 `ConflictError` — zaten geri alınmış) kullanıcıya görünür bir hata olarak yüzeye çıkar.
- [ ] **PR3:** `pnpm --filter @luminaos/web typecheck && lint && test:changed` yeşil; `security-reviewer` bulgusuz.

## Açık Sorular

Bu görev için mimari olarak açık bir soru yok — ADR-0040 Bağlam/Karar/Alternatifler bölümleri tüm tasarım kararlarını (kapsam, emniyet kontrolü yokluğu, geri-alınmış temsili, yürütme yeri, RBAC, çifte-geri-alma önleme, HTTP yüzeyi) çözdü. ADR'nin kendi "Sonuçlar/Ödünler" bölümünün açıkça gelecekteki genişletme noktası olarak işaretlediği, bu görevi BLOKE ETMEYEN kalemler ayrı bir gelecekteki karara ERTELENMİŞTİR:

- `assignPeople`/`reconfigureAgentPermissions` için gerçek geri-alma mekanizması (ayrı, gelecekteki bir görev/ADR gerektirir).
- Eskime/bağımlılık emniyet kontrolü ve zaman-penceresi kısıtlaması (gerçek bir ihtiyaç doğarsa ayrı bir karar/ADR gerektirir).
- `undoesRecordId` index'inin unique-constraint'e/DB-seviyesi bir eşzamanlılık ilkeline genişlemesi — bugünkü kapsamda (`kind:'delete'` → tek nesne akışı) gereksiz; kapsam gelecekte bu özelliği kaybeden bir tersine-çevirme türüne genişlerse ayrıca gözden geçirilmeli.

## Sıradaki adım

```
docs/adr/ADR-0040-tek-tik-geri-alma.md'deki Karar (a)-(g)'yi ve
docs/specs/F3-E2/F3-T6-tek-tik-geri-alma.md'nin Kabul Kriterleri'ni temel alarak, F3-T6
PR1 (packages/agent-runtime: AgentActionRecord.undoesRecordId alanı,
agentActionRecordedPayloadSchema güncellemesi, agent_action_records tablosuna
undoes_record_id kolonu + migration, AgentActionRecordProjection güncellemesi,
AgentActionRecordsService.findUndoRecord) için test-writer ile başarısız testleri yaz.
```
