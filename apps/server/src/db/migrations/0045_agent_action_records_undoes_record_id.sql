ALTER TABLE "agent_action_records" ADD COLUMN "undoes_record_id" varchar(26);
--> statement-breakpoint
CREATE INDEX "agent_action_records_undoes_record_id_idx" ON "agent_action_records" USING btree ("undoes_record_id");
