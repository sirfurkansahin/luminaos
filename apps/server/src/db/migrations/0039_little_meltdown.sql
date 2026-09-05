CREATE TABLE "agents" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"stream_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" varchar(32) NOT NULL,
	"agent_identifier" varchar(100) NOT NULL,
	"lifecycle" varchar(20) DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "agents_stream_id_unique" UNIQUE("stream_id")
);
--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agents_workspace_id_lifecycle_idx" ON "agents" USING btree ("workspace_id","lifecycle");--> statement-breakpoint
CREATE INDEX "agents_workspace_id_name_idx" ON "agents" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE INDEX "agents_workspace_id_agent_identifier_idx" ON "agents" USING btree ("workspace_id","agent_identifier");