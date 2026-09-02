DROP TABLE IF EXISTS "automation_trigger_matches";--> statement-breakpoint
ALTER TABLE "automation_triggers" DROP CONSTRAINT IF EXISTS "automation_triggers_workspace_id_workspaces_id_fk";--> statement-breakpoint
DROP TABLE IF EXISTS "automation_triggers";
