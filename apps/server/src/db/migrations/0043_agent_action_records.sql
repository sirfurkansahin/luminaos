CREATE TABLE "agent_action_records" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"provenance" varchar(20) NOT NULL,
	"actor_type" varchar(20) NOT NULL,
	"actor_id" varchar(100) NOT NULL,
	"action_type" varchar(100) NOT NULL,
	"intent" text NOT NULL,
	"rationale" text NOT NULL,
	"resources" jsonb NOT NULL,
	"rollback_plan" jsonb NOT NULL,
	"outcome" varchar(20) NOT NULL,
	"result_ref" jsonb,
	"causation_event_id" uuid,
	"occurred_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_action_records" ADD CONSTRAINT "agent_action_records_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_action_records_workspace_occurred_at_idx" ON "agent_action_records" USING btree ("workspace_id","occurred_at");
