CREATE TYPE "public"."meeting_provider" AS ENUM('google-meet', 'zoom', 'microsoft-teams');--> statement-breakpoint
CREATE TYPE "public"."meeting_status" AS ENUM('sunuldu', 'beklemede', 'kaydedildi', 'basarisiz');--> statement-breakpoint
CREATE TABLE "meeting_details" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"object_id" varchar(26) NOT NULL,
	"meeting_url" text NOT NULL,
	"provider" "meeting_provider" NOT NULL,
	"status" "meeting_status" DEFAULT 'sunuldu' NOT NULL,
	"provider_meeting_ref" text NOT NULL,
	"provider_recording_url" text,
	"transcript_text" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_details_provider_meeting_ref_idx" ON "meeting_details" USING btree ("provider_meeting_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_details_object_id_idx" ON "meeting_details" USING btree ("object_id");