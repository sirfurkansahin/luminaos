CREATE TABLE "federation_rate_limit_buckets" (
	"host_workspace_id" uuid NOT NULL,
	"federation_link_credential_id" uuid NOT NULL,
	"capacity" integer NOT NULL,
	"tokens_available" double precision NOT NULL,
	"refill_per_ms" double precision NOT NULL,
	"last_refill_at_ms" bigint NOT NULL,
	CONSTRAINT "federation_rate_limit_buckets_host_workspace_id_federation_link_credential_id_pk" PRIMARY KEY("host_workspace_id","federation_link_credential_id")
);
--> statement-breakpoint
ALTER TABLE "federation_rate_limit_buckets" ADD CONSTRAINT "federation_rate_limit_buckets_host_workspace_id_workspaces_id_fk" FOREIGN KEY ("host_workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_rate_limit_buckets" ADD CONSTRAINT "federation_rate_limit_buckets_federation_link_credential_id_federation_link_credentials_id_fk" FOREIGN KEY ("federation_link_credential_id") REFERENCES "public"."federation_link_credentials"("id") ON DELETE cascade ON UPDATE no action;
