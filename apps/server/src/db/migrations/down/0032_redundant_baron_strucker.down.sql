ALTER TABLE "meeting_details" DROP CONSTRAINT "meeting_details_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "meeting_details" DROP COLUMN "workspace_id";--> statement-breakpoint
DROP TABLE IF EXISTS "meeting_retention_preferences";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."meeting_retention_mode";
