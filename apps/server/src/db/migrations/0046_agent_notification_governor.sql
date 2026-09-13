CREATE TABLE "agent_notification_preferences" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" varchar(100) NOT NULL,
	"notification_budget_per_window" integer NOT NULL,
	"quiet_hours_start_hour_utc" integer,
	"quiet_hours_end_hour_utc" integer,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_notification_deliveries" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"recipient_user_id" varchar(100) NOT NULL,
	"action_type" varchar(100) NOT NULL,
	"source_object_id" uuid NOT NULL,
	"outcome" varchar(30) NOT NULL,
	"comment_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_notification_preferences" ADD CONSTRAINT "agent_notification_preferences_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_notification_deliveries" ADD CONSTRAINT "agent_notification_deliveries_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_notification_preferences_workspace_user_idx" ON "agent_notification_preferences" USING btree ("workspace_id","user_id");--> statement-breakpoint
CREATE INDEX "agent_notification_deliveries_recipient_occurred_idx" ON "agent_notification_deliveries" USING btree ("recipient_user_id","occurred_at");
