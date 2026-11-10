CREATE TABLE "assistant_artifacts" (
	"cache_key" char(64) PRIMARY KEY NOT NULL,
	"markdown" text NOT NULL,
	"cache_epoch" varchar(64) NOT NULL,
	"output_contract_version" varchar(64) NOT NULL,
	"completed_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL
);
--> statement-breakpoint
DROP TABLE "assistant_briefing_artifacts" CASCADE;--> statement-breakpoint
DROP TABLE "assistant_turn_artifacts" CASCADE;--> statement-breakpoint
CREATE INDEX "idx_assistant_artifacts_expiry" ON "assistant_artifacts" USING btree ("expires_at");