CREATE TABLE "provider_device_authorizations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"device_verifier" text NOT NULL,
	"user_code_verifier" text NOT NULL,
	"fingerprint_verifier" text NOT NULL,
	"status" text NOT NULL,
	"poll_interval_seconds" integer DEFAULT 5 NOT NULL,
	"next_poll_at" timestamp with time zone DEFAULT now() NOT NULL,
	"organization_id" text,
	"user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "provider_device_authorizations_device_verifier_unique" UNIQUE("device_verifier"),
	CONSTRAINT "provider_device_authorizations_user_code_verifier_unique" UNIQUE("user_code_verifier")
);
--> statement-breakpoint
ALTER TABLE "provider_device_authorizations" ADD CONSTRAINT "provider_device_authorizations_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_device_authorizations" ADD CONSTRAINT "provider_device_authorizations_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "provider_device_authorizations_active_idx" ON "provider_device_authorizations" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "provider_device_authorizations_fingerprint_idx" ON "provider_device_authorizations" USING btree ("fingerprint_verifier","expires_at");