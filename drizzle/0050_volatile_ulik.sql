CREATE TABLE "linear_agent_events" (
	"connection_id" uuid NOT NULL,
	"event_key" text NOT NULL,
	"issue_id" text NOT NULL,
	"data" jsonb NOT NULL,
	"completed" boolean DEFAULT false NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "linear_agent_sessions" (
	"connection_id" uuid NOT NULL,
	"id" text NOT NULL,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "linear_agent_events" ADD CONSTRAINT "linear_agent_events_connection_id_linear_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."linear_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "linear_agent_events_key" ON "linear_agent_events" USING btree ("connection_id","event_key");--> statement-breakpoint
CREATE INDEX "linear_agent_events_pending" ON "linear_agent_events" USING btree ("completed","received_at");--> statement-breakpoint
CREATE INDEX "linear_agent_events_issue" ON "linear_agent_events" USING btree ("connection_id","issue_id");--> statement-breakpoint
CREATE UNIQUE INDEX "linear_agent_sessions_key" ON "linear_agent_sessions" USING btree ("connection_id","id");