CREATE TABLE "trigger_template_suggestions" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"stream_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" varchar(20) NOT NULL,
	"spec" jsonb NOT NULL,
	"rationale" text NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"created_trigger_id" varchar(26),
	"created_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	CONSTRAINT "trigger_template_suggestions_stream_id_unique" UNIQUE("stream_id")
);
--> statement-breakpoint
CREATE TABLE "trigger_suggestion_analysis_state" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"last_run_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "trigger_template_suggestions" ADD CONSTRAINT "trigger_template_suggestions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trigger_template_suggestions" ADD CONSTRAINT "trigger_template_suggestions_created_trigger_id_automation_triggers_id_fk" FOREIGN KEY ("created_trigger_id") REFERENCES "public"."automation_triggers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trigger_suggestion_analysis_state" ADD CONSTRAINT "trigger_suggestion_analysis_state_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "trigger_template_suggestions_workspace_id_status_idx" ON "trigger_template_suggestions" USING btree ("workspace_id","status");