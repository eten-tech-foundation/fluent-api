CREATE TABLE "auth_account" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"account_id" varchar(255) NOT NULL,
	"provider_id" varchar(255) NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"access_token" varchar,
	"refresh_token" varchar,
	"id_token" varchar,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" varchar(255),
	"password" varchar(255),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_audit_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" varchar(36),
	"event" varchar(100) NOT NULL,
	"ip_address" varchar(255),
	"user_agent" varchar,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_session" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" varchar(255) NOT NULL,
	"ip_address" varchar(255),
	"user_agent" varchar,
	"user_id" varchar(36) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "auth_session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "auth_user" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"email" varchar(255) NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" varchar(255),
	"two_factor_enabled" boolean DEFAULT false,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "auth_user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "auth_verification" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"identifier" varchar(255) NOT NULL,
	"value" varchar(255) NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "auth_user_id" varchar(36);--> statement-breakpoint
ALTER TABLE "auth_account" ADD CONSTRAINT "auth_account_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_audit_log" ADD CONSTRAINT "auth_audit_log_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_session" ADD CONSTRAINT "auth_session_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_audit_log_user" ON "auth_audit_log" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_audit_log_event" ON "auth_audit_log" USING btree ("event");--> statement-breakpoint
CREATE INDEX "idx_audit_log_created" ON "auth_audit_log" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_auth_user_id_auth_user_id_fk" FOREIGN KEY ("auth_user_id") REFERENCES "public"."auth_user"("id") ON DELETE set null ON UPDATE no action;