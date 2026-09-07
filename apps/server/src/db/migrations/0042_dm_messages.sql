CREATE TABLE "dm_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"agent_identifier" varchar(100) NOT NULL,
	"sender" varchar(10) NOT NULL,
	"body" text NOT NULL,
	"proposal_id" varchar(36),
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "dm_messages" ADD CONSTRAINT "dm_messages_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dm_messages" ADD CONSTRAINT "dm_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dm_messages_workspace_user_agent_created_at_idx" ON "dm_messages" USING btree ("workspace_id","user_id","agent_identifier","created_at");