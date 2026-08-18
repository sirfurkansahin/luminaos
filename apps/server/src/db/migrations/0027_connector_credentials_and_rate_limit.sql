CREATE TABLE "connector_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"connector_type" varchar(50) NOT NULL,
	"encrypted_credentials" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connector_rate_limit_buckets" (
	"workspace_id" uuid NOT NULL,
	"connector_type" varchar(50) NOT NULL,
	"capacity" integer NOT NULL,
	"tokens_available" double precision NOT NULL,
	"refill_per_ms" double precision NOT NULL,
	"last_refill_at_ms" bigint NOT NULL,
	CONSTRAINT "connector_rate_limit_buckets_workspace_id_connector_type_pk" PRIMARY KEY("workspace_id","connector_type")
);
--> statement-breakpoint
ALTER TABLE "connector_credentials" ADD CONSTRAINT "connector_credentials_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_credentials" ADD CONSTRAINT "connector_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "connector_credentials_workspace_user_type_key" ON "connector_credentials" USING btree ("workspace_id","user_id","connector_type");