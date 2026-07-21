CREATE TABLE "events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"global_position" bigint GENERATED ALWAYS AS IDENTITY (sequence name "events_global_position_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"stream_id" uuid NOT NULL,
	"stream_type" varchar(100) NOT NULL,
	"workspace_id" uuid NOT NULL,
	"type" varchar(200) NOT NULL,
	"version" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"actor" jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "events_stream_id_version_key" ON "events" USING btree ("stream_id","version");--> statement-breakpoint
CREATE INDEX "events_workspace_id_global_position_idx" ON "events" USING btree ("workspace_id","global_position");--> statement-breakpoint
CREATE INDEX "events_global_position_idx" ON "events" USING btree ("global_position");