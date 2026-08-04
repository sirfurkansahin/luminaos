ALTER TABLE "objects_view" ADD COLUMN "checklist" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "objects_view" ADD COLUMN "recurrence_rule" jsonb;