CREATE TABLE "agent_action_executions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"agent_identifier" varchar(100) NOT NULL,
	"action_type" varchar(100) NOT NULL,
	"outcome" varchar(20) NOT NULL,
	"duration_ms" integer NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_action_executions" ADD CONSTRAINT "agent_action_executions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "agent_action_executions_workspace_agent_occurred_idx" ON "agent_action_executions" USING btree ("workspace_id","agent_identifier","occurred_at");