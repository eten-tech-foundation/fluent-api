CREATE TABLE "assistant_turn_artifacts" (
	"cache_key" char(64) PRIMARY KEY NOT NULL,
	"markdown" text NOT NULL,
	"output_contract_version" varchar(64) NOT NULL,
	"completed_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_assistant_turn_artifacts_expiry" ON "assistant_turn_artifacts" USING btree ("expires_at");