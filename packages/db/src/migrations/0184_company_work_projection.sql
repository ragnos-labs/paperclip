CREATE TABLE "company_work_projection_revisions" (
  "company_id" uuid PRIMARY KEY NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "current_revision" bigint DEFAULT 0 NOT NULL CHECK ("current_revision" >= 0),
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE TABLE "issue_work_projection_versions" (
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "issue_id" uuid NOT NULL,
  "revision" bigint NOT NULL CHECK ("revision" > 0),
  "deleted" boolean DEFAULT false NOT NULL,
  "identifier" text,
  "project_id" uuid,
  "assignee_agent_id" uuid,
  "assignee_user_id" text,
  "status" text,
  "priority" text,
  "started_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "cancelled_at" timestamp with time zone,
  "created_at" timestamp with time zone,
  "updated_at" timestamp with time zone,
  "recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "issue_work_projection_versions_company_revision_pk" PRIMARY KEY("company_id", "revision"),
  CONSTRAINT "issue_work_projection_versions_live_fields_ck" CHECK (
    "deleted" OR ("status" IS NOT NULL AND "priority" IS NOT NULL AND "created_at" IS NOT NULL AND "updated_at" IS NOT NULL)
  )
);--> statement-breakpoint

CREATE INDEX "issue_work_projection_versions_company_issue_revision_idx"
  ON "issue_work_projection_versions" ("company_id", "issue_id", "revision");--> statement-breakpoint

WITH visible_issues AS (
  SELECT
    i.*,
    row_number() OVER (PARTITION BY i.company_id ORDER BY i.updated_at, i.id)::bigint AS projection_revision
  FROM issues i
  WHERE i.hidden_at IS NULL AND i.harness_kind IS NULL
)
INSERT INTO issue_work_projection_versions (
  company_id, issue_id, revision, deleted, identifier, project_id,
  assignee_agent_id, assignee_user_id, status, priority, started_at,
  completed_at, cancelled_at, created_at, updated_at, recorded_at
)
SELECT
  company_id, id, projection_revision, false, identifier, project_id,
  assignee_agent_id, assignee_user_id, status, priority, started_at,
  completed_at, cancelled_at, created_at, updated_at, now()
FROM visible_issues;--> statement-breakpoint

INSERT INTO company_work_projection_revisions (company_id, current_revision, updated_at)
SELECT company_id, max(revision), now()
FROM issue_work_projection_versions
GROUP BY company_id;--> statement-breakpoint

CREATE OR REPLACE FUNCTION append_issue_work_projection_version(
  source_company_id uuid,
  source_issue_id uuid,
  source_deleted boolean,
  source_identifier text,
  source_project_id uuid,
  source_assignee_agent_id uuid,
  source_assignee_user_id text,
  source_status text,
  source_priority text,
  source_started_at timestamp with time zone,
  source_completed_at timestamp with time zone,
  source_cancelled_at timestamp with time zone,
  source_created_at timestamp with time zone,
  source_updated_at timestamp with time zone
) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  next_revision bigint;
BEGIN
  INSERT INTO company_work_projection_revisions (company_id, current_revision, updated_at)
  VALUES (source_company_id, 1, now())
  ON CONFLICT (company_id) DO UPDATE
    SET current_revision = company_work_projection_revisions.current_revision + 1,
        updated_at = now()
  RETURNING current_revision INTO next_revision;

  INSERT INTO issue_work_projection_versions (
    company_id, issue_id, revision, deleted, identifier, project_id,
    assignee_agent_id, assignee_user_id, status, priority, started_at,
    completed_at, cancelled_at, created_at, updated_at, recorded_at
  ) VALUES (
    source_company_id, source_issue_id, next_revision, source_deleted,
    CASE WHEN source_deleted THEN NULL ELSE source_identifier END,
    CASE WHEN source_deleted THEN NULL ELSE source_project_id END,
    CASE WHEN source_deleted THEN NULL ELSE source_assignee_agent_id END,
    CASE WHEN source_deleted THEN NULL ELSE source_assignee_user_id END,
    CASE WHEN source_deleted THEN NULL ELSE source_status END,
    CASE WHEN source_deleted THEN NULL ELSE source_priority END,
    CASE WHEN source_deleted THEN NULL ELSE source_started_at END,
    CASE WHEN source_deleted THEN NULL ELSE source_completed_at END,
    CASE WHEN source_deleted THEN NULL ELSE source_cancelled_at END,
    CASE WHEN source_deleted THEN NULL ELSE source_created_at END,
    CASE WHEN source_deleted THEN NULL ELSE source_updated_at END,
    now()
  );
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION capture_issue_work_projection_change() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  old_visible boolean := false;
  new_visible boolean := false;
BEGIN
  IF TG_OP = 'DELETE' THEN
    old_visible := OLD.hidden_at IS NULL AND OLD.harness_kind IS NULL;
    IF old_visible THEN
      PERFORM append_issue_work_projection_version(
        OLD.company_id, OLD.id, true, NULL, NULL, NULL, NULL, NULL, NULL,
        NULL, NULL, NULL, NULL, NULL
      );
    END IF;
    RETURN OLD;
  END IF;

  new_visible := NEW.hidden_at IS NULL AND NEW.harness_kind IS NULL;
  IF TG_OP = 'UPDATE' THEN
    old_visible := OLD.hidden_at IS NULL AND OLD.harness_kind IS NULL;
    IF old_visible AND (NOT new_visible OR OLD.company_id <> NEW.company_id) THEN
      PERFORM append_issue_work_projection_version(
        OLD.company_id, OLD.id, true, NULL, NULL, NULL, NULL, NULL, NULL,
        NULL, NULL, NULL, NULL, NULL
      );
    END IF;
  END IF;

  IF new_visible THEN
    PERFORM append_issue_work_projection_version(
      NEW.company_id, NEW.id, false, NEW.identifier, NEW.project_id,
      NEW.assignee_agent_id, NEW.assignee_user_id, NEW.status, NEW.priority,
      NEW.started_at, NEW.completed_at, NEW.cancelled_at, NEW.created_at, NEW.updated_at
    );
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "issues_work_projection_capture"
AFTER INSERT OR UPDATE OR DELETE ON "issues"
FOR EACH ROW EXECUTE FUNCTION capture_issue_work_projection_change();
