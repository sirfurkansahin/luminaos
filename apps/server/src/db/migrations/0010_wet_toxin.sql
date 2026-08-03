CREATE TABLE "saved_views" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"stream_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"object_type" varchar(50) NOT NULL,
	"name" text NOT NULL,
	"icon" varchar(100) NOT NULL,
	"view_type" varchar(20) NOT NULL,
	"query_spec" jsonb NOT NULL,
	"date_field" varchar(200),
	"start_field" varchar(200),
	"end_field" varchar(200),
	"owner_id" uuid,
	"lifecycle" varchar(20) DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "saved_views_stream_id_unique" UNIQUE("stream_id")
);
--> statement-breakpoint
ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "saved_views_workspace_id_object_type_lifecycle_idx" ON "saved_views" USING btree ("workspace_id","object_type","lifecycle");--> statement-breakpoint
CREATE INDEX "saved_views_workspace_id_owner_id_lifecycle_idx" ON "saved_views" USING btree ("workspace_id","owner_id","lifecycle");