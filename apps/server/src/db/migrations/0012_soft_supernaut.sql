CREATE TABLE "document_snapshots" (
	"object_id" varchar(26) NOT NULL,
	"version" integer NOT NULL,
	"snapshot" "bytea" NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "document_snapshots_object_id_version_pk" PRIMARY KEY("object_id","version")
);
--> statement-breakpoint
ALTER TABLE "document_snapshots" ADD CONSTRAINT "document_snapshots_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;