CREATE TABLE "projection_checkpoints" (
	"projection_name" varchar(200) PRIMARY KEY NOT NULL,
	"last_position" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projection_workspace_event_counts" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"event_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "projection_workspace_event_counts" ADD CONSTRAINT "projection_workspace_event_counts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;