ALTER TABLE "issue_work_projection_versions" ADD COLUMN "delegation_authorizer_reference_valid" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "issue_work_projection_versions" ADD COLUMN "work_projection_context" jsonb;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "work_projection_context" jsonb;--> statement-breakpoint

ALTER TABLE public.company_work_projection_credentials
  DROP CONSTRAINT IF EXISTS company_work_projection_credentials_token_version_check;--> statement-breakpoint
ALTER TABLE public.company_work_projection_credentials
  ADD CONSTRAINT company_work_projection_credentials_token_version_check
  CHECK (token_version IN (1, 2));--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.company_work_projection_delegation_authorizer_is_valid(
  source_company_id uuid,
  source_context jsonb
) RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT source_context IS NULL
    OR source_context -> 'delegation' IS NULL
    OR jsonb_typeof(source_context -> 'delegation') = 'null'
    OR (
      source_context #>> '{delegation,onBehalfOf,type}' = 'human'
      AND EXISTS (
        SELECT 1 FROM public.company_memberships
        WHERE company_id = source_company_id
          AND principal_type = 'user'
          AND principal_id = source_context #>> '{delegation,onBehalfOf,id}'
          AND status = 'active'
      )
    )
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.append_issue_work_projection_version_v2(
  source_company_id uuid,
  source_issue_id uuid,
  source_deleted boolean,
  source_identifier text,
  source_project_id uuid,
  source_assignee_agent_id uuid,
  source_assignee_user_id text,
  source_work_projection_context jsonb,
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
  previous_revision bigint;
  previous_integrity_token uuid;
  source_database_epoch uuid;
  next_revision bigint;
  next_integrity_token uuid := gen_random_uuid();
  counter_revision bigint;
  head_was_inserted boolean;
BEGIN
  SELECT current_revision, current_integrity_token, database_epoch
  INTO previous_revision, previous_integrity_token, source_database_epoch
  FROM public.company_work_projection_source_witnesses
  WHERE company_id = source_company_id
  FOR UPDATE;

  IF previous_revision IS NULL THEN
    RAISE EXCEPTION 'company work projection source witness missing for company %', source_company_id
      USING ERRCODE = '23514';
  END IF;

  next_revision := previous_revision + 1;
  UPDATE public.company_work_projection_source_witnesses
  SET current_revision = next_revision,
      current_integrity_token = next_integrity_token,
      updated_at = now()
  WHERE company_id = source_company_id;

  UPDATE public.company_work_projection_revisions
  SET current_revision = next_revision,
      current_integrity_token = next_integrity_token,
      updated_at = now()
  WHERE company_id = source_company_id
    AND current_revision = previous_revision
    AND current_integrity_token = previous_integrity_token
  RETURNING current_revision INTO counter_revision;

  IF counter_revision IS NULL THEN
    RAISE EXCEPTION 'company work projection counter does not match source witness for company %', source_company_id
      USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.issue_work_projection_versions (
    company_id, issue_id, revision, deleted, identifier, project_id,
    assignee_agent_id, assignee_user_id, project_reference_valid,
    assignee_agent_reference_valid, assignee_user_reference_valid,
    delegation_authorizer_reference_valid, work_projection_context,
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
    CASE WHEN source_deleted THEN true ELSE public.company_work_projection_delegation_authorizer_is_valid(source_company_id, source_work_projection_context) END,
    CASE WHEN source_deleted THEN NULL ELSE source_work_projection_context END,
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

  SELECT NOT EXISTS (
    SELECT 1 FROM public.company_work_projection_issue_heads
    WHERE company_id = source_company_id AND issue_id = source_issue_id
  ) INTO head_was_inserted;

  INSERT INTO public.company_work_projection_issue_heads (
    company_id, issue_id, first_revision, current_revision, updated_at
  ) VALUES (
    source_company_id, source_issue_id, next_revision, next_revision, now()
  )
  ON CONFLICT (company_id, issue_id) DO UPDATE
  SET current_revision = EXCLUDED.current_revision,
      updated_at = now();

  UPDATE public.company_work_projection_verifications
  SET verified_revision = next_revision,
      verified_integrity_token = next_integrity_token,
      verified_history_count = verified_history_count + 1,
      verified_event_count = verified_event_count + 1,
      verified_head_count = verified_head_count + CASE WHEN head_was_inserted THEN 1 ELSE 0 END,
      verified_at = now()
  WHERE company_id = source_company_id
    AND database_epoch = source_database_epoch
    AND verified_revision = previous_revision
    AND verified_integrity_token = previous_integrity_token
    AND verified_history_count = previous_revision
    AND verified_event_count = previous_revision;
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
      PERFORM public.append_issue_work_projection_version_v2(
        OLD.company_id, OLD.id, true, NULL, NULL, NULL, NULL, NULL, NULL,
        NULL, NULL, NULL, NULL, NULL, NULL
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
      PERFORM public.append_issue_work_projection_version_v2(
        OLD.company_id, OLD.id, true, NULL, NULL, NULL, NULL, NULL, NULL,
        NULL, NULL, NULL, NULL, NULL, NULL
      );
    END IF;
  END IF;

  IF new_visible THEN
    PERFORM public.append_issue_work_projection_version_v2(
      NEW.company_id, NEW.id, false, NEW.identifier, NEW.project_id,
      NEW.assignee_agent_id, NEW.assignee_user_id, NEW.work_projection_context,
      NEW.status, NEW.priority, NEW.started_at, NEW.completed_at,
      NEW.cancelled_at, NEW.created_at, NEW.updated_at
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
    PERFORM public.append_issue_work_projection_version_v2(
      source_issue.company_id, source_issue.id, false, source_issue.identifier,
      source_issue.project_id, source_issue.assignee_agent_id,
      source_issue.assignee_user_id, source_issue.work_projection_context,
      source_issue.status, source_issue.priority, source_issue.started_at,
      source_issue.completed_at, source_issue.cancelled_at,
      source_issue.created_at, source_issue.updated_at
    );
  END IF;
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
      SELECT * FROM public.issues AS candidate
      WHERE candidate.company_id = NEW.company_id
        AND (
          candidate.assignee_user_id = NEW.principal_id
          OR candidate.work_projection_context #>> '{delegation,onBehalfOf,id}' = NEW.principal_id
        )
      ORDER BY candidate.id
    LOOP
      PERFORM public.append_current_issue_work_projection_version(source_issue);
    END LOOP;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.principal_type <> 'user' THEN RETURN OLD; END IF;
    FOR source_issue IN
      SELECT * FROM public.issues AS candidate
      WHERE candidate.company_id = OLD.company_id
        AND (
          candidate.assignee_user_id = OLD.principal_id
          OR candidate.work_projection_context #>> '{delegation,onBehalfOf,id}' = OLD.principal_id
        )
      ORDER BY candidate.id
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
    SELECT DISTINCT ON (candidate.id) candidate.*
    FROM public.issues AS candidate
    WHERE (
      OLD.principal_type = 'user'
      AND candidate.company_id = OLD.company_id
      AND (
        candidate.assignee_user_id = OLD.principal_id
        OR candidate.work_projection_context #>> '{delegation,onBehalfOf,id}' = OLD.principal_id
      )
    ) OR (
      NEW.principal_type = 'user'
      AND candidate.company_id = NEW.company_id
      AND (
        candidate.assignee_user_id = NEW.principal_id
        OR candidate.work_projection_context #>> '{delegation,onBehalfOf,id}' = NEW.principal_id
      )
    )
    ORDER BY candidate.id
  LOOP
    PERFORM public.append_current_issue_work_projection_version(source_issue);
  END LOOP;
  RETURN NEW;
END;
$$;
