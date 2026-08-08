ALTER TABLE "ai_usage_records" ADD COLUMN "model" varchar(64);--> statement-breakpoint
ALTER TABLE "ai_usage_records" ADD COLUMN "cost_usd" numeric(10, 6);