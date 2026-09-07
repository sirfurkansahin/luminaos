CREATE TABLE "mention_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"comment_id" varchar(26) NOT NULL,
	"object_id" varchar(26) NOT NULL,
	"object_type" varchar(50) NOT NULL,
	"agent_identifier" varchar(100) NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"last_error" text,
	"reply_comment_id" varchar(26),
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mention_actions" ADD CONSTRAINT "mention_actions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mention_actions_status_next_attempt_at_idx" ON "mention_actions" USING btree ("status","next_attempt_at");