-- The migration runner wraps this file in one transaction. These locks block
-- every source write that can affect projection membership or bounded
-- reference validity until capture triggers and the backfill are complete.
LOCK TABLE public.companies, public.issues, public.projects, public.agents,
  public.company_memberships IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint

-- The unreleased first candidate stored this capability as an agent scope.
-- Revoke any such local residue before current code can normalize it as a
-- standard key, and before an older binary can be used against this database.
UPDATE public.agent_api_keys
SET revoked_at = COALESCE(revoked_at, now())
WHERE scope_config ->> 'kind' = 'company_work_projection_read';--> statement-breakpoint

-- Dedicated management permission. Existing active owner/admin memberships
-- receive it; operators/viewers do not. Route authorization also checks the
-- current membership role, so a stray grant cannot elevate an operator.
INSERT INTO public.principal_permission_grants (
  company_id, principal_type, principal_id, permission_key, scope,
  granted_by_user_id, created_at, updated_at
)
SELECT
  membership.company_id,
  'user',
  membership.principal_id,
  'work_projection_credentials:manage',
  NULL,
  NULL,
  now(),
  now()
FROM public.company_memberships AS membership
WHERE membership.principal_type = 'user'
  AND membership.status = 'active'
  AND membership.membership_role IN ('owner', 'admin')
ON CONFLICT (company_id, principal_type, principal_id, permission_key) DO NOTHING;--> statement-breakpoint

CREATE TABLE public.company_work_projection_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (name = btrim(name) AND length(name) BETWEEN 1 AND 120),
  key_hash text NOT NULL,
  token_version integer DEFAULT 1 NOT NULL CHECK (token_version = 1),
  creation_activity_id uuid NOT NULL REFERENCES public.activity_log(id),
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  revoked_at timestamp with time zone,
  revocation_activity_id uuid REFERENCES public.activity_log(id),
  CONSTRAINT company_work_projection_credentials_revocation_audit_ck CHECK (
    (revoked_at IS NULL AND revocation_activity_id IS NULL)
    OR (revoked_at IS NOT NULL AND revocation_activity_id IS NOT NULL)
  )
);--> statement-breakpoint

CREATE UNIQUE INDEX company_work_projection_credentials_key_hash_idx
  ON public.company_work_projection_credentials (key_hash);--> statement-breakpoint

CREATE INDEX company_work_projection_credentials_company_created_idx
  ON public.company_work_projection_credentials (company_id, created_at);--> statement-breakpoint

CREATE TABLE public.company_work_projection_revisions (
  company_id uuid PRIMARY KEY NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  current_revision bigint DEFAULT 0 NOT NULL CHECK (current_revision >= 0),
  current_integrity_token uuid NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

-- This witness is deliberately outside the counter/history restore unit. It
-- advances in the same source transaction but must not be restored when only
-- projection materializations are rebuilt or rolled back.
CREATE TABLE public.company_work_projection_source_witnesses (
  company_id uuid PRIMARY KEY NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  current_revision bigint DEFAULT 0 NOT NULL CHECK (current_revision >= 0),
  current_integrity_token uuid NOT NULL,
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
  project_reference_valid boolean DEFAULT true NOT NULL,
  assignee_agent_reference_valid boolean DEFAULT true NOT NULL,
  assignee_user_reference_valid boolean DEFAULT true NOT NULL,
  status text,
  priority text,
  started_at timestamp with time zone,
  completed_at timestamp with time zone,
  cancelled_at timestamp with time zone,
  created_at timestamp with time zone,
  updated_at timestamp with time zone,
  integrity_token uuid NOT NULL,
  recorded_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT issue_work_projection_versions_company_revision_pk PRIMARY KEY(company_id, revision),
  CONSTRAINT issue_work_projection_versions_company_revision_token_uk
    UNIQUE(company_id, revision, integrity_token),
  CONSTRAINT issue_work_projection_versions_live_fields_ck CHECK (
    deleted OR (status IS NOT NULL AND priority IS NOT NULL AND created_at IS NOT NULL AND updated_at IS NOT NULL)
  )
);--> statement-breakpoint

CREATE INDEX issue_work_projection_versions_company_issue_revision_idx
  ON public.issue_work_projection_versions (company_id, issue_id, revision);--> statement-breakpoint

-- One immutable witness event exists for every positive source revision. The
-- deferred reverse FK prevents a runtime history gap while allowing the two
-- rows to be appended in one transaction.
CREATE TABLE public.company_work_projection_source_events (
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  revision bigint NOT NULL CHECK (revision > 0),
  integrity_token uuid NOT NULL,
  recorded_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT company_work_projection_source_events_pk PRIMARY KEY(company_id, revision),
  CONSTRAINT company_work_projection_source_events_history_fk
    FOREIGN KEY (company_id, revision, integrity_token)
    REFERENCES public.issue_work_projection_versions(company_id, revision, integrity_token)
    DEFERRABLE INITIALLY DEFERRED
);--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.reject_company_work_projection_append_only_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;--> statement-breakpoint

CREATE TRIGGER issue_work_projection_versions_append_only
BEFORE UPDATE OR DELETE ON public.issue_work_projection_versions
FOR EACH ROW EXECUTE FUNCTION public.reject_company_work_projection_append_only_mutation();--> statement-breakpoint

CREATE TRIGGER company_work_projection_source_events_append_only
BEFORE UPDATE OR DELETE ON public.company_work_projection_source_events
FOR EACH ROW EXECUTE FUNCTION public.reject_company_work_projection_append_only_mutation();--> statement-breakpoint

-- Seed every company with the same random revision-zero token in the materialized
-- counter and independent source witness. Reads never synthesize this state.
WITH seeds AS (
  SELECT id AS company_id, gen_random_uuid() AS integrity_token
  FROM public.companies
)
INSERT INTO public.company_work_projection_revisions (
  company_id, current_revision, current_integrity_token, updated_at
)
SELECT company_id, 0, integrity_token, now() FROM seeds;--> statement-breakpoint

INSERT INTO public.company_work_projection_source_witnesses (
  company_id, current_revision, current_integrity_token, updated_at
)
SELECT company_id, current_revision, current_integrity_token, now()
FROM public.company_work_projection_revisions;--> statement-breakpoint

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

CREATE OR REPLACE FUNCTION public.company_work_projection_project_reference_is_valid(
  source_company_id uuid,
  source_project_id uuid
) RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT source_project_id IS NULL OR EXISTS (
    SELECT 1 FROM public.projects
    WHERE id = source_project_id
      AND company_id = source_company_id
      AND archived_at IS NULL
  )
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.company_work_projection_agent_reference_is_valid(
  source_company_id uuid,
  source_agent_id uuid
) RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT source_agent_id IS NULL OR EXISTS (
    SELECT 1 FROM public.agents
    WHERE id = source_agent_id
      AND company_id = source_company_id
      AND status NOT IN ('pending_approval', 'terminated')
  )
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.company_work_projection_user_reference_is_valid(
  source_company_id uuid,
  source_user_id text
) RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT source_user_id IS NULL OR EXISTS (
    SELECT 1 FROM public.company_memberships
    WHERE company_id = source_company_id
      AND principal_type = 'user'
      AND principal_id = source_user_id
      AND status = 'active'
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
  next_integrity_token uuid := gen_random_uuid();
  counter_revision bigint;
BEGIN
  UPDATE public.company_work_projection_source_witnesses
  SET current_revision = current_revision + 1,
      current_integrity_token = next_integrity_token,
      updated_at = now()
  WHERE company_id = source_company_id
  RETURNING current_revision INTO next_revision;

  IF next_revision IS NULL THEN
    RAISE EXCEPTION 'company work projection source witness missing for company %', source_company_id
      USING ERRCODE = '23514';
  END IF;

  UPDATE public.company_work_projection_revisions
  SET current_revision = next_revision,
      current_integrity_token = next_integrity_token,
      updated_at = now()
  WHERE company_id = source_company_id
    AND current_revision = next_revision - 1
  RETURNING current_revision INTO counter_revision;

  IF counter_revision IS NULL THEN
    RAISE EXCEPTION 'company work projection counter does not match source witness for company %', source_company_id
      USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.issue_work_projection_versions (
    company_id, issue_id, revision, deleted, identifier, project_id,
    assignee_agent_id, assignee_user_id, project_reference_valid,
    assignee_agent_reference_valid, assignee_user_reference_valid,
    status, priority, started_at, completed_at, cancelled_at, created_at,
    updated_at, integrity_token, recorded_at
  ) VALUES (
    source_company_id, source_issue_id, next_revision, source_deleted,
    CASE WHEN source_deleted THEN NULL ELSE source_identifier END,
    CASE WHEN source_deleted THEN NULL ELSE source_project_id END,
    CASE WHEN source_deleted THEN NULL ELSE source_assignee_agent_id END,
    CASE WHEN source_deleted THEN NULL ELSE source_assignee_user_id END,
    CASE WHEN source_deleted THEN true ELSE public.company_work_projection_project_reference_is_valid(source_company_id, source_project_id) END,
    CASE WHEN source_deleted THEN true ELSE public.company_work_projection_agent_reference_is_valid(source_company_id, source_assignee_agent_id) END,
    CASE WHEN source_deleted THEN true ELSE public.company_work_projection_user_reference_is_valid(source_company_id, source_assignee_user_id) END,
    CASE WHEN source_deleted THEN NULL ELSE source_status END,
    CASE WHEN source_deleted THEN NULL ELSE source_priority END,
    CASE WHEN source_deleted THEN NULL ELSE source_started_at END,
    CASE WHEN source_deleted THEN NULL ELSE source_completed_at END,
    CASE WHEN source_deleted THEN NULL ELSE source_cancelled_at END,
    CASE WHEN source_deleted THEN NULL ELSE source_created_at END,
    CASE WHEN source_deleted THEN NULL ELSE source_updated_at END,
    next_integrity_token,
    now()
  );

  INSERT INTO public.company_work_projection_source_events (
    company_id, revision, integrity_token, recorded_at
  ) VALUES (source_company_id, next_revision, next_integrity_token, now());
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

CREATE OR REPLACE FUNCTION public.append_current_issue_work_projection_version(source_issue public.issues)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF public.company_work_projection_issue_is_visible(
    source_issue.hidden_at, source_issue.harness_kind, source_issue.origin_kind
  ) THEN
    PERFORM public.append_issue_work_projection_version(
      source_issue.company_id, source_issue.id, false, source_issue.identifier,
      source_issue.project_id, source_issue.assignee_agent_id,
      source_issue.assignee_user_id, source_issue.status, source_issue.priority,
      source_issue.started_at, source_issue.completed_at,
      source_issue.cancelled_at, source_issue.created_at, source_issue.updated_at
    );
  END IF;
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.capture_project_work_projection_reference_change() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE source_issue public.issues%ROWTYPE;
BEGIN
  IF OLD.company_id IS NOT DISTINCT FROM NEW.company_id
    AND OLD.archived_at IS NOT DISTINCT FROM NEW.archived_at THEN
    RETURN NEW;
  END IF;
  FOR source_issue IN
    SELECT * FROM public.issues WHERE project_id = NEW.id ORDER BY company_id, id
  LOOP
    PERFORM public.append_current_issue_work_projection_version(source_issue);
  END LOOP;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.capture_agent_work_projection_reference_change() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  source_issue public.issues%ROWTYPE;
  old_valid_class boolean := OLD.status NOT IN ('pending_approval', 'terminated');
  new_valid_class boolean := NEW.status NOT IN ('pending_approval', 'terminated');
BEGIN
  IF OLD.company_id IS NOT DISTINCT FROM NEW.company_id
    AND old_valid_class = new_valid_class THEN
    RETURN NEW;
  END IF;
  FOR source_issue IN
    SELECT * FROM public.issues WHERE assignee_agent_id = NEW.id ORDER BY company_id, id
  LOOP
    PERFORM public.append_current_issue_work_projection_version(source_issue);
  END LOOP;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.capture_membership_work_projection_reference_change() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE source_issue public.issues%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.principal_type <> 'user' THEN RETURN NEW; END IF;
    FOR source_issue IN
      SELECT * FROM public.issues
      WHERE company_id = NEW.company_id AND assignee_user_id = NEW.principal_id
      ORDER BY id
    LOOP
      PERFORM public.append_current_issue_work_projection_version(source_issue);
    END LOOP;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.principal_type <> 'user' THEN RETURN OLD; END IF;
    FOR source_issue IN
      SELECT * FROM public.issues
      WHERE company_id = OLD.company_id AND assignee_user_id = OLD.principal_id
      ORDER BY id
    LOOP
      PERFORM public.append_current_issue_work_projection_version(source_issue);
    END LOOP;
    RETURN OLD;
  END IF;

  IF OLD.company_id IS NOT DISTINCT FROM NEW.company_id
    AND OLD.principal_type IS NOT DISTINCT FROM NEW.principal_type
    AND OLD.principal_id IS NOT DISTINCT FROM NEW.principal_id
    AND OLD.status IS NOT DISTINCT FROM NEW.status THEN
    RETURN NEW;
  END IF;

  FOR source_issue IN
    SELECT DISTINCT ON (id) candidate.*
    FROM public.issues AS candidate
    WHERE (OLD.principal_type = 'user'
      AND candidate.company_id = OLD.company_id
      AND candidate.assignee_user_id = OLD.principal_id)
      OR (NEW.principal_type = 'user'
        AND candidate.company_id = NEW.company_id
        AND candidate.assignee_user_id = NEW.principal_id)
    ORDER BY id
  LOOP
    PERFORM public.append_current_issue_work_projection_version(source_issue);
  END LOOP;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.initialize_company_work_projection_revision() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE initial_integrity_token uuid := gen_random_uuid();
BEGIN
  INSERT INTO public.company_work_projection_revisions (
    company_id, current_revision, current_integrity_token, updated_at
  ) VALUES (NEW.id, 0, initial_integrity_token, now());
  INSERT INTO public.company_work_projection_source_witnesses (
    company_id, current_revision, current_integrity_token, updated_at
  ) VALUES (NEW.id, 0, initial_integrity_token, now());
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER companies_work_projection_initialize
AFTER INSERT ON public.companies
FOR EACH ROW EXECUTE FUNCTION public.initialize_company_work_projection_revision();--> statement-breakpoint

CREATE TRIGGER issues_work_projection_capture
AFTER INSERT OR UPDATE OR DELETE ON public.issues
FOR EACH ROW EXECUTE FUNCTION public.capture_issue_work_projection_change();--> statement-breakpoint

CREATE TRIGGER projects_work_projection_reference_capture
AFTER UPDATE OF company_id, archived_at ON public.projects
FOR EACH ROW EXECUTE FUNCTION public.capture_project_work_projection_reference_change();--> statement-breakpoint

CREATE TRIGGER agents_work_projection_reference_capture
AFTER UPDATE OF company_id, status ON public.agents
FOR EACH ROW EXECUTE FUNCTION public.capture_agent_work_projection_reference_change();--> statement-breakpoint

CREATE TRIGGER company_memberships_work_projection_reference_capture
AFTER INSERT OR UPDATE OR DELETE ON public.company_memberships
FOR EACH ROW EXECUTE FUNCTION public.capture_membership_work_projection_reference_change();--> statement-breakpoint

WITH visible_issues AS (
  SELECT
    i.*,
    row_number() OVER (PARTITION BY i.company_id ORDER BY i.updated_at, i.id)::bigint AS projection_revision,
    gen_random_uuid() AS integrity_token
  FROM public.issues i
  WHERE public.company_work_projection_issue_is_visible(i.hidden_at, i.harness_kind, i.origin_kind)
)
INSERT INTO public.issue_work_projection_versions (
  company_id, issue_id, revision, deleted, identifier, project_id,
  assignee_agent_id, assignee_user_id, project_reference_valid,
  assignee_agent_reference_valid, assignee_user_reference_valid,
  status, priority, started_at, completed_at, cancelled_at, created_at,
  updated_at, integrity_token, recorded_at
)
SELECT
  company_id, id, projection_revision, false, identifier, project_id,
  assignee_agent_id, assignee_user_id,
  public.company_work_projection_project_reference_is_valid(company_id, project_id),
  public.company_work_projection_agent_reference_is_valid(company_id, assignee_agent_id),
  public.company_work_projection_user_reference_is_valid(company_id, assignee_user_id),
  status, priority, started_at, completed_at, cancelled_at, created_at,
  updated_at, integrity_token, now()
FROM visible_issues;--> statement-breakpoint

INSERT INTO public.company_work_projection_source_events (
  company_id, revision, integrity_token, recorded_at
)
SELECT company_id, revision, integrity_token, recorded_at
FROM public.issue_work_projection_versions;--> statement-breakpoint

WITH latest AS (
  SELECT DISTINCT ON (company_id)
    company_id, revision, integrity_token
  FROM public.issue_work_projection_versions
  ORDER BY company_id, revision DESC
)
UPDATE public.company_work_projection_revisions AS revisions
SET current_revision = latest.revision,
    current_integrity_token = latest.integrity_token,
    updated_at = now()
FROM latest
WHERE revisions.company_id = latest.company_id;--> statement-breakpoint

WITH latest AS (
  SELECT DISTINCT ON (company_id)
    company_id, revision, integrity_token
  FROM public.issue_work_projection_versions
  ORDER BY company_id, revision DESC
)
UPDATE public.company_work_projection_source_witnesses AS witnesses
SET current_revision = latest.revision,
    current_integrity_token = latest.integrity_token,
    updated_at = now()
FROM latest
WHERE witnesses.company_id = latest.company_id;
