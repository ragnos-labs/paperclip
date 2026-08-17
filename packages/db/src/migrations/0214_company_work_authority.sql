ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "work_authority_context" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "issues_company_work_authority_stable_ref_uq"
  ON "issues" USING btree ("company_id", ("work_authority_context" ->> 'stableWorkRef'))
  WHERE "work_authority_context" is not null;--> statement-breakpoint

ALTER TABLE public.company_work_projection_credentials
  DROP CONSTRAINT IF EXISTS company_work_projection_credentials_token_version_check;--> statement-breakpoint
ALTER TABLE public.company_work_projection_credentials
  ADD CONSTRAINT company_work_projection_credentials_token_version_check
  CHECK (token_version IN (1, 2, 3));--> statement-breakpoint

CREATE TABLE "company_work_authority_actions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "idempotency_key" text NOT NULL,
  "request_digest" text NOT NULL,
  "preview_hash" text NOT NULL,
  "state" text NOT NULL,
  "reason_code" text NOT NULL,
  "issue_id" uuid,
  "comment_id" uuid,
  "expected_revision" text NOT NULL,
  "result_revision" text,
  "service_actor_ref" text NOT NULL,
  "accountable_human_ref" text NOT NULL,
  "approver_ref" text NOT NULL,
  "approval_ref" text NOT NULL,
  "action" jsonb NOT NULL,
  "receipt" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE TABLE "company_work_authority_aliases" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "alias_ref" text NOT NULL,
  "issue_id" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "company_work_authority_actions"
  ADD CONSTRAINT "company_work_authority_actions_company_id_companies_id_fk"
  FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "company_work_authority_actions"
  ADD CONSTRAINT "company_work_authority_actions_issue_id_issues_id_fk"
  FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null;--> statement-breakpoint
ALTER TABLE "company_work_authority_actions"
  ADD CONSTRAINT "company_work_authority_actions_comment_id_issue_comments_id_fk"
  FOREIGN KEY ("comment_id") REFERENCES "public"."issue_comments"("id") ON DELETE set null;--> statement-breakpoint
ALTER TABLE "company_work_authority_aliases"
  ADD CONSTRAINT "company_work_authority_aliases_company_id_companies_id_fk"
  FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "company_work_authority_aliases"
  ADD CONSTRAINT "company_work_authority_aliases_issue_id_issues_id_fk"
  FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade;--> statement-breakpoint

CREATE UNIQUE INDEX "company_work_authority_actions_company_key_uq"
  ON "company_work_authority_actions" USING btree ("company_id", "idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "company_work_authority_actions_company_digest_uq"
  ON "company_work_authority_actions" USING btree ("company_id", "request_digest");--> statement-breakpoint
CREATE INDEX "company_work_authority_actions_company_created_idx"
  ON "company_work_authority_actions" USING btree ("company_id", "created_at");--> statement-breakpoint
CREATE INDEX "company_work_authority_actions_issue_created_idx"
  ON "company_work_authority_actions" USING btree ("issue_id", "created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "company_work_authority_aliases_company_alias_uq"
  ON "company_work_authority_aliases" USING btree ("company_id", "alias_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "company_work_authority_aliases_issue_alias_uq"
  ON "company_work_authority_aliases" USING btree ("issue_id", "alias_ref");--> statement-breakpoint
CREATE INDEX "company_work_authority_aliases_company_issue_idx"
  ON "company_work_authority_aliases" USING btree ("company_id", "issue_id");
