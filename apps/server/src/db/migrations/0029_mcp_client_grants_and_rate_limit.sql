CREATE TABLE "mcp_client_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"name" varchar(200) NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"token_prefix" varchar(12) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "mcp_rate_limit_buckets" (
	"workspace_id" uuid NOT NULL,
	"mcp_client_grant_id" uuid NOT NULL,
	"capacity" integer NOT NULL,
	"tokens_available" double precision NOT NULL,
	"refill_per_ms" double precision NOT NULL,
	"last_refill_at_ms" bigint NOT NULL,
	CONSTRAINT "mcp_rate_limit_buckets_workspace_id_mcp_client_grant_id_pk" PRIMARY KEY("workspace_id","mcp_client_grant_id")
);
--> statement-breakpoint
ALTER TABLE "mcp_client_grants" ADD CONSTRAINT "mcp_client_grants_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_client_grants" ADD CONSTRAINT "mcp_client_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_rate_limit_buckets" ADD CONSTRAINT "mcp_rate_limit_buckets_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_rate_limit_buckets" ADD CONSTRAINT "mcp_rate_limit_buckets_mcp_client_grant_id_mcp_client_grants_id_fk" FOREIGN KEY ("mcp_client_grant_id") REFERENCES "public"."mcp_client_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_client_grants_token_hash_key" ON "mcp_client_grants" USING btree ("token_hash");