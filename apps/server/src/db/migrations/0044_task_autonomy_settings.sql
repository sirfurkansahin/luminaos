CREATE TABLE "task_autonomy_settings" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"action_type" varchar(100) NOT NULL,
	"tier" varchar(20) NOT NULL,
	"updated_by_type" varchar(20) NOT NULL,
	"updated_by_id" varchar(100) NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "task_autonomy_settings" ADD CONSTRAINT "task_autonomy_settings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "task_autonomy_settings_workspace_action_type_key" ON "task_autonomy_settings" USING btree ("workspace_id","action_type");
