CREATE TABLE "assistant_briefing_artifacts" (
	"cache_key" char(64) PRIMARY KEY NOT NULL,
	"markdown" text NOT NULL,
	"operation_version" varchar(64) NOT NULL,
	"profile_version" varchar(64) NOT NULL,
	"resource_policy_version" varchar(64) NOT NULL,
	"cache_epoch" varchar(64) NOT NULL,
	"output_contract_version" varchar(64) NOT NULL,
	"response_language_hint" varchar(20) NOT NULL,
	"resource_language" varchar(20) NOT NULL,
	"source_language_code" varchar(20) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_assistant_briefing_artifacts_expiry" ON "assistant_briefing_artifacts" USING btree ("expires_at");