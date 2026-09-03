CREATE TABLE "agent_permission_manifests" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"agent_identifier" varchar(100) NOT NULL,
	"data_scope" jsonb NOT NULL,
	"action_types" jsonb NOT NULL,
	"starts_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"granted_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "agent_permission_manifests" ADD CONSTRAINT "agent_permission_manifests_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_permission_manifests_workspace_agent_key" ON "agent_permission_manifests" USING btree ("workspace_id","agent_identifier");