CREATE TABLE "object_comments" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"stream_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"object_id" varchar(26) NOT NULL,
	"author_actor" jsonb NOT NULL,
	"body" text NOT NULL,
	"mentioned_agent_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "object_comments_stream_id_unique" UNIQUE("stream_id")
);
--> statement-breakpoint
ALTER TABLE "object_comments" ADD CONSTRAINT "object_comments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "object_comments_workspace_id_object_id_created_at_idx" ON "object_comments" USING btree ("workspace_id","object_id","created_at");