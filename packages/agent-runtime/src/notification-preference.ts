/**
 * F3-T13 PR1 (ADR-0047 Karar a/b): per-`(workspaceId, userId)` personal
 * notification preference. Pure types, no framework imports, mirrors
 * `autonomy-tier.ts`'s style.
 */

/**
 * UTC hour window, 0-23. `endHourUtc < startHourUtc` means the window wraps
 * past midnight (e.g. 22 -> 07). v0 is UTC-only -- no per-user timezone
 * (ADR-0047 Karar b, Bilinen Sınırlamalar).
 */
export interface QuietHoursWindow {
  startHourUtc: number;
  endHourUtc: number;
}

/**
 * Ayar HİÇ YOKSA (satır bulunamazsa) davranış bugünküyle AYNIDIR: bütçe
 * kısıtı YOK, sessiz saat YOK (ADR-0047 Karar b, fail-open — ADR-0039'un
 * fail-safe kutbunun kasıtlı tersi).
 */
export interface NotificationPreference {
  id: string;
  workspaceId: string;
  userId: string;
  /** Kayan pencere başına izin verilen TOPLAM (tüm actionType'lar arasında
   * agrege) bildirim sayısı. */
  notificationBudgetPerWindow: number;
  quietHours: QuietHoursWindow | null;
  updatedAt: Date;
}
