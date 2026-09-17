CREATE TYPE "public"."federation_link_status" AS ENUM('pending', 'active', 'revoked');--> statement-breakpoint
CREATE TABLE "federation_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"initiator_workspace_id" uuid NOT NULL,
	"counterpart_workspace_id" uuid NOT NULL,
	"pair_key" varchar(73) NOT NULL,
	"status" "federation_link_status" DEFAULT 'pending' NOT NULL,
	"initiated_by_user_id" uuid NOT NULL,
	"accepted_by_user_id" uuid,
	"revoked_by_user_id" uuid,
	"initiator_audit_stream_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"counterpart_audit_stream_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "federation_link_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"federation_link_id" uuid NOT NULL,
	"grantee_workspace_id" uuid NOT NULL,
	"name" varchar(200) NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"token_prefix" varchar(12) NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "federation_scope_objects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"federation_link_id" uuid NOT NULL,
	"object_id" varchar(26) NOT NULL,
	"owner_workspace_id" uuid NOT NULL,
	"added_by_user_id" uuid NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "federation_links" ADD CONSTRAINT "federation_links_initiator_workspace_id_workspaces_id_fk" FOREIGN KEY ("initiator_workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_links" ADD CONSTRAINT "federation_links_counterpart_workspace_id_workspaces_id_fk" FOREIGN KEY ("counterpart_workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_links" ADD CONSTRAINT "federation_links_initiated_by_user_id_users_id_fk" FOREIGN KEY ("initiated_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_links" ADD CONSTRAINT "federation_links_accepted_by_user_id_users_id_fk" FOREIGN KEY ("accepted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_links" ADD CONSTRAINT "federation_links_revoked_by_user_id_users_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_link_credentials" ADD CONSTRAINT "federation_link_credentials_federation_link_id_federation_links_id_fk" FOREIGN KEY ("federation_link_id") REFERENCES "public"."federation_links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_link_credentials" ADD CONSTRAINT "federation_link_credentials_grantee_workspace_id_workspaces_id_fk" FOREIGN KEY ("grantee_workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_link_credentials" ADD CONSTRAINT "federation_link_credentials_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_scope_objects" ADD CONSTRAINT "federation_scope_objects_federation_link_id_federation_links_id_fk" FOREIGN KEY ("federation_link_id") REFERENCES "public"."federation_links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_scope_objects" ADD CONSTRAINT "federation_scope_objects_owner_workspace_id_workspaces_id_fk" FOREIGN KEY ("owner_workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_scope_objects" ADD CONSTRAINT "federation_scope_objects_added_by_user_id_users_id_fk" FOREIGN KEY ("added_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "federation_links_pair_key_active_key" ON "federation_links" USING btree ("pair_key") WHERE "federation_links"."status" <> 'revoked';--> statement-breakpoint
CREATE UNIQUE INDEX "federation_link_credentials_token_hash_key" ON "federation_link_credentials" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "federation_scope_objects_active_key" ON "federation_scope_objects" USING btree ("federation_link_id","object_id") WHERE "federation_scope_objects"."removed_at" IS NULL;
