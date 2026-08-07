CREATE TABLE "user_availability" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"status" varchar(20) NOT NULL,
	"until" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_availability" ADD CONSTRAINT "user_availability_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;