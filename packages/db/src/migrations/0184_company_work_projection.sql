-- The migration runner wraps this entire file in one transaction. Holding
-- SHARE ROW EXCLUSIVE prevents concurrent company/issue writes from crossing
-- the counter seed, backfill, and trigger-install boundary.
LOCK TABLE public.companies, public.issues IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint

-- The unreleased first candidate stored this capability as an agent scope.
-- Revoke any such local residue before current code can normalize it as a
-- standard key, and before an older binary can be used against this database.
UPDATE public.agent_api_keys
SET revoked_at = COALESCE(revoked_at, now())
WHERE scope_config ->> 'kind' = 'company_work_projection_read';--> statement-breakpoint

CREATE TABLE public.company_work_projection_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  name text NOT NULL,
  key_hash text NOT NULL,
  token_version integer DEFAULT 1 NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  revoked_at timestamp with time zone
);--> statement-breakpoint

CREATE UNIQUE INDEX company_work_projection_credentials_key_hash_idx
  ON public.company_work_projection_credentials (key_hash);--> statement-breakpoint

CREATE INDEX company_work_projection_credentials_company_created_idx
  ON public.company_work_projection_credentials (company_id, created_at);--> statement-breakpoint

CREATE TABLE public.company_work_projection_revisions (
  company_id uuid PRIMARY KEY NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  current_revision bigint DEFAULT 0 NOT NULL CHECK (current_revision >= 0),
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE TABLE public.issue_work_projection_versions (
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  issue_id uuid NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  deleted boolean DEFAULT false NOT NULL,
  identifier text,
  project_id uuid,
  assignee_agent_id uuid,
  assignee_user_id text,
  status text,
  priority text,
  started_at timestamp with time zone,
  completed_at timestamp with time zone,
  cancelled_at timestamp with time zone,
  created_at timestamp with time zone,
  updated_at timestamp with time zone,
  recorded_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT issue_work_projection_versions_company_revision_pk PRIMARY KEY(company_id, revision),
  CONSTRAINT issue_work_projection_versions_live_fields_ck CHECK (
    deleted OR (status IS NOT NULL AND priority IS NOT NULL AND created_at IS NOT NULL AND updated_at IS NOT NULL)
  )
);--> statement-breakpoint

CREATE INDEX issue_work_projection_versions_company_issue_revision_idx
  ON public.issue_work_projection_versions (company_id, issue_id, revision);--> statement-breakpoint

-- Seed every company, including companies with no visible work, before the
-- issue backfill. Reads require this row and never synthesize revision zero.
INSERT INTO public.company_work_projection_revisions (company_id, current_revision, updated_at)
SELECT id, 0, now()
FROM public.companies;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.company_work_projection_issue_is_visible(
  source_hidden_at timestamp with time zone,
  source_harness_kind text,
  source_origin_kind text
) RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT source_hidden_at IS NULL
    AND source_harness_kind IS NULL
    AND NOT (
      COALESCE(source_origin_kind, '') LIKE 'plugin:%:operation'
      OR COALESCE(source_origin_kind, '') LIKE 'plugin:%:operation:%'
      OR COALESCE(source_origin_kind, '') IN (
        'plugin:paperclipai.content-machine:case',
        'plugin:paperclipai.content-machine:evaluation',
        'plugin:paperclipai.content-machine:source-sync'
      )
    )
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.append_issue_work_projection_version(
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
SET search_path = pg_catalog, public
AS $$
DECLARE
  next_revision bigint;
BEGIN
  UPDATE public.company_work_projection_revisions
  SET current_revision = current_revision + 1,
      updated_at = now()
  WHERE company_id = source_company_id
  RETURNING current_revision INTO next_revision;

  IF next_revision IS NULL THEN
    RAISE EXCEPTION 'company work projection counter missing for company %', source_company_id
      USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.issue_work_projection_versions (
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

CREATE OR REPLACE FUNCTION public.capture_issue_work_projection_change() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  old_visible boolean := false;
  new_visible boolean := false;
BEGIN
  IF TG_OP = 'DELETE' THEN
    old_visible := public.company_work_projection_issue_is_visible(
      OLD.hidden_at, OLD.harness_kind, OLD.origin_kind
    );
    IF old_visible THEN
      PERFORM public.append_issue_work_projection_version(
        OLD.company_id, OLD.id, true, NULL, NULL, NULL, NULL, NULL, NULL,
        NULL, NULL, NULL, NULL, NULL
      );
    END IF;
    RETURN OLD;
  END IF;

  new_visible := public.company_work_projection_issue_is_visible(
    NEW.hidden_at, NEW.harness_kind, NEW.origin_kind
  );
  IF TG_OP = 'UPDATE' THEN
    old_visible := public.company_work_projection_issue_is_visible(
      OLD.hidden_at, OLD.harness_kind, OLD.origin_kind
    );
    IF old_visible AND (NOT new_visible OR OLD.company_id <> NEW.company_id) THEN
      PERFORM public.append_issue_work_projection_version(
        OLD.company_id, OLD.id, true, NULL, NULL, NULL, NULL, NULL, NULL,
        NULL, NULL, NULL, NULL, NULL
      );
    END IF;
  END IF;

  IF new_visible THEN
    PERFORM public.append_issue_work_projection_version(
      NEW.company_id, NEW.id, false, NEW.identifier, NEW.project_id,
      NEW.assignee_agent_id, NEW.assignee_user_id, NEW.status, NEW.priority,
      NEW.started_at, NEW.completed_at, NEW.cancelled_at, NEW.created_at, NEW.updated_at
    );
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.initialize_company_work_projection_revision() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  INSERT INTO public.company_work_projection_revisions (company_id, current_revision, updated_at)
  VALUES (NEW.id, 0, now());
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER companies_work_projection_initialize
AFTER INSERT ON public.companies
FOR EACH ROW EXECUTE FUNCTION public.initialize_company_work_projection_revision();--> statement-breakpoint

CREATE TRIGGER issues_work_projection_capture
AFTER INSERT OR UPDATE OR DELETE ON public.issues
FOR EACH ROW EXECUTE FUNCTION public.capture_issue_work_projection_change();--> statement-breakpoint

WITH visible_issues AS (
  SELECT
    i.*,
    row_number() OVER (PARTITION BY i.company_id ORDER BY i.updated_at, i.id)::bigint AS projection_revision
  FROM public.issues i
  WHERE public.company_work_projection_issue_is_visible(i.hidden_at, i.harness_kind, i.origin_kind)
)
INSERT INTO public.issue_work_projection_versions (
  company_id, issue_id, revision, deleted, identifier, project_id,
  assignee_agent_id, assignee_user_id, status, priority, started_at,
  completed_at, cancelled_at, created_at, updated_at, recorded_at
)
SELECT
  company_id, id, projection_revision, false, identifier, project_id,
  assignee_agent_id, assignee_user_id, status, priority, started_at,
  completed_at, cancelled_at, created_at, updated_at, now()
FROM visible_issues;--> statement-breakpoint

UPDATE public.company_work_projection_revisions AS revisions
SET current_revision = history.current_revision,
    updated_at = now()
FROM (
  SELECT company_id, max(revision) AS current_revision
  FROM public.issue_work_projection_versions
  GROUP BY company_id
) AS history
WHERE revisions.company_id = history.company_id;
