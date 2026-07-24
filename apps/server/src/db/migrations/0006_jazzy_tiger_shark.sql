CREATE TABLE "relations_view" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"stream_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"from_id" varchar(26) NOT NULL,
	"to_id" varchar(26) NOT NULL,
	"kind" varchar(20) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "relations_view_stream_id_unique" UNIQUE("stream_id")
);
--> statement-breakpoint
ALTER TABLE "relations_view" ADD CONSTRAINT "relations_view_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relations_view" ADD CONSTRAINT "relations_view_from_id_objects_view_id_fk" FOREIGN KEY ("from_id") REFERENCES "public"."objects_view"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relations_view" ADD CONSTRAINT "relations_view_to_id_objects_view_id_fk" FOREIGN KEY ("to_id") REFERENCES "public"."objects_view"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "relations_view_workspace_id_kind_idx" ON "relations_view" USING btree ("workspace_id","kind");--> statement-breakpoint
CREATE INDEX "relations_view_workspace_id_from_id_idx" ON "relations_view" USING btree ("workspace_id","from_id");--> statement-breakpoint
CREATE INDEX "relations_view_workspace_id_to_id_idx" ON "relations_view" USING btree ("workspace_id","to_id");