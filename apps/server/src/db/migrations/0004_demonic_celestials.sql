CREATE TABLE "field_definitions" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"stream_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"object_type" varchar(50) NOT NULL,
	"key" varchar(100) NOT NULL,
	"label" text NOT NULL,
	"field_type" varchar(20) NOT NULL,
	"config" jsonb NOT NULL,
	"default_value" jsonb,
	"permissions" jsonb NOT NULL,
	"lifecycle" varchar(20) DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "field_definitions_stream_id_unique" UNIQUE("stream_id")
);
--> statement-breakpoint
ALTER TABLE "field_definitions" ADD CONSTRAINT "field_definitions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "field_definitions_workspace_object_type_key_key" ON "field_definitions" USING btree ("workspace_id","object_type","key");--> statement-breakpoint
CREATE INDEX "field_definitions_workspace_object_type_lifecycle_idx" ON "field_definitions" USING btree ("workspace_id","object_type","lifecycle");