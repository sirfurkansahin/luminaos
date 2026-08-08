CREATE TABLE "search_index" (
	"object_id" varchar(26) PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"title" text NOT NULL,
	"doc_text" text,
	"tsv" "tsvector" NOT NULL,
	"embedding" real[],
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "search_index" ADD CONSTRAINT "search_index_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "search_index_tsv_gin_idx" ON "search_index" USING gin ("tsv");