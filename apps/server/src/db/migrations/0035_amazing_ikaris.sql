CREATE TABLE "webhook_subscriptions" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"target_url" text NOT NULL,
	"event_types" jsonb NOT NULL,
	"encrypted_signing_secret" text NOT NULL,
	"lifecycle" varchar(20) DEFAULT 'active' NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subscription_id" varchar(26) NOT NULL,
	"event_type" varchar(40) NOT NULL,
	"payload" jsonb NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone NOT NULL,
	"delivered_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "webhook_subscriptions" ADD CONSTRAINT "webhook_subscriptions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_subscription_id_webhook_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."webhook_subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "webhook_subscriptions_workspace_id_lifecycle_idx" ON "webhook_subscriptions" USING btree ("workspace_id","lifecycle");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_status_next_attempt_at_idx" ON "webhook_deliveries" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_subscription_id_idx" ON "webhook_deliveries" USING btree ("subscription_id");