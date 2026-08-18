CREATE TABLE "memory_access_policies" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"agent_identifier" varchar(100) NOT NULL,
	"granted_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "memory_access_policies" ADD CONSTRAINT "memory_access_policies_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_access_policies" ADD CONSTRAINT "memory_access_policies_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "memory_access_policies_workspace_user_agent_key" ON "memory_access_policies" USING btree ("workspace_id","user_id","agent_identifier");