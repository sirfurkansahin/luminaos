CREATE TABLE "calendar_events_cache" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"calendar_account_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"title" text NOT NULL,
	"event_start" timestamp with time zone NOT NULL,
	"event_end" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "calendar_events_cache" ADD CONSTRAINT "calendar_events_cache_calendar_account_id_calendar_accounts_id_fk" FOREIGN KEY ("calendar_account_id") REFERENCES "public"."calendar_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_events_cache" ADD CONSTRAINT "calendar_events_cache_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_events_cache_account_external_id_idx" ON "calendar_events_cache" USING btree ("calendar_account_id","external_id");