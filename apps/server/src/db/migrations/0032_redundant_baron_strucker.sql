CREATE TYPE "public"."meeting_retention_mode" AS ENUM('recording-reference', 'transcript-only', 'summary-only');--> statement-breakpoint
CREATE TABLE "meeting_retention_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"mode" "meeting_retention_mode" NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- ADR-0031 §c: meeting_details.workspace_id is backfilled in three steps
-- rather than added directly as NOT NULL, since pre-existing rows have no
-- value to satisfy that constraint until backfilled from objects_view.
ALTER TABLE "meeting_details" ADD COLUMN "workspace_id" uuid;--> statement-breakpoint
UPDATE "meeting_details" SET "workspace_id" = (
	SELECT "workspace_id" FROM "objects_view" WHERE "objects_view"."id" = "meeting_details"."object_id"
) WHERE "workspace_id" IS NULL;--> statement-breakpoint
ALTER TABLE "meeting_details" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "meeting_retention_preferences" ADD CONSTRAINT "meeting_retention_preferences_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_retention_preferences_workspace_id_idx" ON "meeting_retention_preferences" USING btree ("workspace_id");--> statement-breakpoint
ALTER TABLE "meeting_details" ADD CONSTRAINT "meeting_details_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
