CREATE TABLE "automation_triggers" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"stream_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" varchar(20) NOT NULL,
	"spec" jsonb NOT NULL,
	"last_fired_at" timestamp with time zone,
	"lifecycle" varchar(20) DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "automation_triggers_stream_id_unique" UNIQUE("stream_id")
);
--> statement-breakpoint
CREATE TABLE "automation_trigger_matches" (
	"trigger_id" varchar(26) NOT NULL,
	"object_id" varchar(26) NOT NULL,
	"matched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_trigger_matches_trigger_id_object_id_pk" PRIMARY KEY("trigger_id","object_id")
);
--> statement-breakpoint
ALTER TABLE "automation_triggers" ADD CONSTRAINT "automation_triggers_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_trigger_matches" ADD CONSTRAINT "automation_trigger_matches_trigger_id_automation_triggers_id_fk" FOREIGN KEY ("trigger_id") REFERENCES "public"."automation_triggers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "automation_triggers_workspace_id_lifecycle_idx" ON "automation_triggers" USING btree ("workspace_id","lifecycle");--> statement-breakpoint
CREATE INDEX "automation_triggers_workspace_id_kind_lifecycle_idx" ON "automation_triggers" USING btree ("workspace_id","kind","lifecycle");