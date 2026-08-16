CREATE TABLE "desktop_signal_consents" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"signal_type" varchar(30) NOT NULL,
	"granted_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "desktop_signal_consents" ADD CONSTRAINT "desktop_signal_consents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "desktop_signal_consents" ADD CONSTRAINT "desktop_signal_consents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "desktop_signal_consents_workspace_user_signal_type_key" ON "desktop_signal_consents" USING btree ("workspace_id","user_id","signal_type");