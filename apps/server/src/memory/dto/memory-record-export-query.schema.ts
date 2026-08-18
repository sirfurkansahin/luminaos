import { z } from 'zod';

/**
 * Validates `GET /workspaces/:workspaceId/memory/export` query params.
 * `format` bugün TEK bir literal (`'json-ld'`) — serbest bir `z.string()`
 * DEĞİL, ADR-0016 §(c)'nin `?format=` konvansiyonunu izleyerek gelecekte
 * ikinci bir format eklenirse (`z.enum(['json-ld', '...'])`) genişletilebilir
 * bırakılıyor, ama bugünden geçersiz bir format string'inin sessizce kabul
 * edilmesine izin vermiyor.
 */
export const memoryRecordExportQuerySchema = z.object({
  format: z.literal('json-ld'),
});

export type MemoryRecordExportQueryInput = z.infer<typeof memoryRecordExportQuerySchema>;
