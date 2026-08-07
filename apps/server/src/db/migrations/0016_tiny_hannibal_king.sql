CREATE TABLE "timeblock_external_pushes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"object_id" varchar(26) NOT NULL,
	"calendar_account_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "timeblock_external_pushes" ADD CONSTRAINT "timeblock_external_pushes_calendar_account_id_calendar_accounts_id_fk" FOREIGN KEY ("calendar_account_id") REFERENCES "public"."calendar_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "timeblock_external_pushes_object_account_idx" ON "timeblock_external_pushes" USING btree ("object_id","calendar_account_id");