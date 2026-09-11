DROP INDEX IF EXISTS "agent_action_records_undoes_record_id_idx";
ALTER TABLE "agent_action_records" DROP COLUMN IF EXISTS "undoes_record_id";
