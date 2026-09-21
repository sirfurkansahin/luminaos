CREATE TYPE "public"."data_rights_request_status" AS ENUM('pending', 'completed', 'rejected');--> statement-breakpoint
CREATE TABLE "data_rights_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" varchar(32) DEFAULT 'deletion' NOT NULL,
	"status" "data_rights_request_status" DEFAULT 'pending' NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);--> statement-breakpoint
ALTER TABLE "data_rights_requests" ADD CONSTRAINT "data_rights_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "data_rights_requests_one_pending_per_user_idx" ON "data_rights_requests" USING btree ("user_id") WHERE "data_rights_requests"."status" = 'pending';
