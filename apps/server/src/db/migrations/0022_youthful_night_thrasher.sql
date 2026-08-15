CREATE TABLE "context_graph_nodes" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"node_type" varchar(20) NOT NULL,
	"natural_key" text NOT NULL,
	"object_type" varchar(50),
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "context_graph_edges" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"edge_type" varchar(20) NOT NULL,
	"from_node_id" varchar(26) NOT NULL,
	"to_node_id" varchar(26) NOT NULL,
	"source_field_key" varchar(200),
	"source_relation_id" varchar(26),
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "context_graph_field_types" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"object_type" varchar(50) NOT NULL,
	"field_key" varchar(200) NOT NULL,
	"field_type" varchar(20) NOT NULL,
	"field_definition_id" varchar(26) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "context_graph_nodes" ADD CONSTRAINT "context_graph_nodes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_graph_edges" ADD CONSTRAINT "context_graph_edges_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_graph_edges" ADD CONSTRAINT "context_graph_edges_from_node_id_context_graph_nodes_id_fk" FOREIGN KEY ("from_node_id") REFERENCES "public"."context_graph_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_graph_edges" ADD CONSTRAINT "context_graph_edges_to_node_id_context_graph_nodes_id_fk" FOREIGN KEY ("to_node_id") REFERENCES "public"."context_graph_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_graph_field_types" ADD CONSTRAINT "context_graph_field_types_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "context_graph_nodes_workspace_type_natural_key_key" ON "context_graph_nodes" USING btree ("workspace_id","node_type","natural_key");--> statement-breakpoint
CREATE INDEX "context_graph_nodes_workspace_id_idx" ON "context_graph_nodes" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "context_graph_edges_null_field_key_key" ON "context_graph_edges" USING btree ("workspace_id","edge_type","from_node_id","to_node_id") WHERE source_field_key IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "context_graph_edges_field_key_key" ON "context_graph_edges" USING btree ("workspace_id","edge_type","from_node_id","to_node_id","source_field_key") WHERE source_field_key IS NOT NULL;--> statement-breakpoint
CREATE INDEX "context_graph_edges_workspace_id_idx" ON "context_graph_edges" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "context_graph_edges_from_node_id_idx" ON "context_graph_edges" USING btree ("from_node_id");--> statement-breakpoint
CREATE INDEX "context_graph_edges_to_node_id_idx" ON "context_graph_edges" USING btree ("to_node_id");--> statement-breakpoint
CREATE INDEX "context_graph_edges_source_relation_id_idx" ON "context_graph_edges" USING btree ("source_relation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "context_graph_field_types_workspace_object_type_field_key_key" ON "context_graph_field_types" USING btree ("workspace_id","object_type","field_key");