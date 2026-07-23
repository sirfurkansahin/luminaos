CREATE TABLE "objects_view" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"stream_id" uuid NOT NULL,
	"type" varchar(50) NOT NULL,
	"workspace_id" uuid NOT NULL,
	"title" text NOT NULL,
	"created_by" varchar(255) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"lifecycle" varchar(20) NOT NULL,
	CONSTRAINT "objects_view_stream_id_unique" UNIQUE("stream_id")
);
--> statement-breakpoint
ALTER TABLE "objects_view" ADD CONSTRAINT "objects_view_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "objects_view_workspace_id_lifecycle_idx" ON "objects_view" USING btree ("workspace_id","lifecycle");