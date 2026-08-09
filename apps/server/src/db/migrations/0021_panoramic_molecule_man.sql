CREATE TABLE "command_proposals" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"stream_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"command" text NOT NULL,
	"source_object_id" varchar(26),
	"actions" jsonb NOT NULL,
	"decisions" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	CONSTRAINT "command_proposals_stream_id_unique" UNIQUE("stream_id")
);
--> statement-breakpoint
ALTER TABLE "command_proposals" ADD CONSTRAINT "command_proposals_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;