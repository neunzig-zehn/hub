CREATE TABLE "provider_plugin_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"verifier" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "provider_plugin_tokens_verifier_unique" UNIQUE("verifier")
);
--> statement-breakpoint
CREATE TABLE "provider_subscriptions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"family" text NOT NULL,
	"label" text NOT NULL,
	"encrypted_credential" text NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_subscriptions_family_check" CHECK ("provider_subscriptions"."family" in ('codex', 'claude'))
);
--> statement-breakpoint
ALTER TABLE "provider_plugin_tokens" ADD CONSTRAINT "provider_plugin_tokens_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_plugin_tokens" ADD CONSTRAINT "provider_plugin_tokens_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_subscriptions" ADD CONSTRAINT "provider_subscriptions_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_subscriptions" ADD CONSTRAINT "provider_subscriptions_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "provider_plugin_tokens_user_idx" ON "provider_plugin_tokens" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "provider_subscriptions_organization_idx" ON "provider_subscriptions" USING btree ("organization_id");