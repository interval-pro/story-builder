-- Core schema for the AI Engineering System.
-- Postgres is the source of truth for everything except source code itself.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE projects (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  repo_path TEXT NOT NULL,
  default_branch TEXT NOT NULL DEFAULT 'main',
  remote_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE stories (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'PROJECT_TASK' CHECK (kind IN ('PROJECT_TASK', 'SYSTEM_TASK')),
  current_revision INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX stories_project_idx ON stories(project_id, created_at DESC);

-- Story revisions are immutable; changing a story creates revision N+1.
CREATE TABLE story_revisions (
  id UUID PRIMARY KEY,
  story_id UUID NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  body TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT 'human',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (story_id, revision)
);

CREATE TABLE knowledge_snapshots (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  git_commit TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'BUILDING' CHECK (status IN ('BUILDING', 'READY', 'STALE')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, sequence)
);

CREATE TABLE tasks (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  story_id UUID NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  story_revision_id UUID NOT NULL REFERENCES story_revisions(id),
  state TEXT NOT NULL DEFAULT 'DRAFT',
  previous_state TEXT,
  kind TEXT NOT NULL DEFAULT 'PROJECT_TASK' CHECK (kind IN ('PROJECT_TASK', 'SYSTEM_TASK')),
  branch_name TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  base_commit TEXT NOT NULL,
  knowledge_snapshot_id UUID REFERENCES knowledge_snapshots(id),
  risk_level TEXT CHECK (risk_level IN ('LOW', 'MEDIUM', 'HIGH')),
  qa_iteration INTEGER NOT NULL DEFAULT 0,
  base_moved BOOLEAN NOT NULL DEFAULT false,
  blocked_reason TEXT,
  failure_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX tasks_project_state_idx ON tasks(project_id, state);
CREATE INDEX tasks_story_idx ON tasks(story_id);

CREATE TABLE agents (
  id UUID PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('research', 'review', 'implementation', 'qa', 'learning')),
  name TEXT NOT NULL,
  current_version_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (type)
);

CREATE TABLE agent_versions (
  id UUID PRIMARY KEY,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  prompt TEXT NOT NULL,
  prompt_hash TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  model_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  tool_policy_version TEXT NOT NULL DEFAULT '1',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (agent_id, version)
);
ALTER TABLE agents ADD CONSTRAINT agents_current_version_fk
  FOREIGN KEY (current_version_id) REFERENCES agent_versions(id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE task_runs (
  id UUID PRIMARY KEY,
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  phase TEXT NOT NULL,
  agent_type TEXT NOT NULL,
  agent_version_id UUID REFERENCES agent_versions(id),
  status TEXT NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING', 'COMPLETED', 'FAILED')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  input_tokens INTEGER,
  output_tokens INTEGER,
  error_message TEXT
);
CREATE INDEX task_runs_task_idx ON task_runs(task_id, started_at DESC);

CREATE TABLE artifacts (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id UUID REFERENCES tasks(id) ON DELETE CASCADE,
  run_id UUID REFERENCES task_runs(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'text/plain',
  size_bytes BIGINT NOT NULL,
  storage_path TEXT NOT NULL,
  checksum TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX artifacts_task_idx ON artifacts(task_id, created_at DESC);

CREATE TABLE task_checkpoints (
  id UUID PRIMARY KEY,
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  run_id UUID REFERENCES task_runs(id) ON DELETE SET NULL,
  state TEXT NOT NULL,
  git_head TEXT,
  diff_artifact_id UUID REFERENCES artifacts(id) ON DELETE SET NULL,
  workspace_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  migration_state JSONB NOT NULL DEFAULT '{}'::jsonb,
  running_services JSONB NOT NULL DEFAULT '[]'::jsonb,
  agent_versions JSONB NOT NULL DEFAULT '{}'::jsonb,
  knowledge_snapshot_id UUID REFERENCES knowledge_snapshots(id),
  plan_position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX task_checkpoints_task_idx ON task_checkpoints(task_id, created_at DESC);

CREATE TABLE reviews (
  id UUID PRIMARY KEY,
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'ENGINEERING' CHECK (kind IN ('ENGINEERING', 'SUPPLEMENTAL', 'FINAL')),
  current_version INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'READY', 'APPROVED', 'SUPERSEDED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX reviews_task_idx ON reviews(task_id);

CREATE TABLE review_versions (
  id UUID PRIMARY KEY,
  review_id UUID NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  document JSONB NOT NULL,
  markdown TEXT NOT NULL,
  generated_by_run_id UUID REFERENCES task_runs(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (review_id, version)
);

CREATE TABLE review_notes (
  id UUID PRIMARY KEY,
  review_id UUID NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  review_version_id UUID NOT NULL REFERENCES review_versions(id) ON DELETE CASCADE,
  section_key TEXT,
  anchor_text TEXT NOT NULL,
  anchor_start INTEGER,
  anchor_end INTEGER,
  note TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'ADDRESSED', 'REJECTED')),
  created_by TEXT NOT NULL DEFAULT 'human',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX review_notes_review_idx ON review_notes(review_id, created_at);

CREATE TABLE approvals (
  id UUID PRIMARY KEY,
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('REVIEW', 'HIGH_RISK_EXECUTION', 'PR', 'SUPPLEMENTAL')),
  review_version_id UUID REFERENCES review_versions(id),
  decision TEXT NOT NULL CHECK (decision IN ('APPROVED', 'REJECTED')),
  comment TEXT,
  decided_by TEXT NOT NULL DEFAULT 'human',
  decided_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX approvals_task_idx ON approvals(task_id, decided_at DESC);

CREATE TABLE tool_calls (
  id UUID PRIMARY KEY,
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  run_id UUID NOT NULL REFERENCES task_runs(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  tool_name TEXT NOT NULL,
  input JSONB NOT NULL DEFAULT '{}'::jsonb,
  output_summary TEXT NOT NULL DEFAULT '',
  output_artifact_id UUID REFERENCES artifacts(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('OK', 'ERROR', 'DENIED')),
  duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX tool_calls_run_idx ON tool_calls(run_id, sequence);

-- Append only event log. Rows are never updated or deleted.
CREATE TABLE events (
  event_id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id UUID REFERENCES tasks(id) ON DELETE CASCADE,
  run_id UUID REFERENCES task_runs(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  sequence BIGSERIAL NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX events_task_idx ON events(task_id, sequence);
CREATE INDEX events_project_idx ON events(project_id, sequence DESC);
CREATE RULE events_no_update AS ON UPDATE TO events DO INSTEAD NOTHING;
CREATE RULE events_no_delete AS ON DELETE TO events DO INSTEAD NOTHING;

-- Durable job queue. Claimed with FOR UPDATE SKIP LOCKED.
CREATE TABLE jobs (
  id UUID PRIMARY KEY,
  task_id UUID REFERENCES tasks(id) ON DELETE CASCADE,
  job_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED')),
  attempt INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_by TEXT,
  locked_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX jobs_claim_idx ON jobs(status, available_at) WHERE status = 'PENDING';
CREATE INDEX jobs_task_idx ON jobs(task_id, created_at DESC);
-- A task may queue its next job while its current job is still RUNNING, so the
-- constraint only prevents duplicate PENDING work of the same type.
CREATE UNIQUE INDEX jobs_single_pending_per_task_type ON jobs(task_id, job_type)
  WHERE status = 'PENDING' AND task_id IS NOT NULL;

CREATE TABLE project_brain_principles (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  statement TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'global',
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUPERSEDED', 'REJECTED')),
  strength REAL NOT NULL DEFAULT 0.5,
  evidence_count INTEGER NOT NULL DEFAULT 1,
  supersedes_id UUID REFERENCES project_brain_principles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX principles_project_idx ON project_brain_principles(project_id, status, category);

CREATE TABLE principle_evidence (
  id UUID PRIMARY KEY,
  principle_id UUID NOT NULL REFERENCES project_brain_principles(id) ON DELETE CASCADE,
  task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
  review_note_id UUID REFERENCES review_notes(id) ON DELETE SET NULL,
  evidence TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE knowledge_entities (
  id UUID PRIMARY KEY,
  snapshot_id UUID NOT NULL REFERENCES knowledge_snapshots(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  path TEXT,
  signature TEXT,
  summary TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX knowledge_entities_snapshot_idx ON knowledge_entities(snapshot_id, kind);
CREATE INDEX knowledge_entities_name_idx ON knowledge_entities(snapshot_id, name);

CREATE TABLE knowledge_edges (
  id UUID PRIMARY KEY,
  snapshot_id UUID NOT NULL REFERENCES knowledge_snapshots(id) ON DELETE CASCADE,
  from_entity_id UUID NOT NULL REFERENCES knowledge_entities(id) ON DELETE CASCADE,
  to_entity_id UUID NOT NULL REFERENCES knowledge_entities(id) ON DELETE CASCADE,
  relation TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX knowledge_edges_snapshot_idx ON knowledge_edges(snapshot_id, relation);
CREATE INDEX knowledge_edges_from_idx ON knowledge_edges(from_entity_id);

CREATE TABLE invariants (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  statement TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'global',
  status TEXT NOT NULL DEFAULT 'PROPOSED' CHECK (status IN ('ACTIVE', 'PROPOSED', 'RETIRED')),
  confidence REAL NOT NULL DEFAULT 0.5,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE invariant_evidence (
  id UUID PRIMARY KEY,
  invariant_id UUID NOT NULL REFERENCES invariants(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  evidence TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE impact_manifests (
  id UUID PRIMARY KEY,
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (task_id, version)
);

CREATE TABLE impact_resources (
  id UUID PRIMARY KEY,
  manifest_id UUID NOT NULL REFERENCES impact_manifests(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  identifier TEXT NOT NULL,
  access TEXT NOT NULL CHECK (access IN ('read', 'write')),
  source TEXT NOT NULL DEFAULT 'review'
);
CREATE INDEX impact_resources_manifest_idx ON impact_resources(manifest_id);
CREATE INDEX impact_resources_identifier_idx ON impact_resources(kind, identifier);

CREATE TABLE task_dependencies (
  id UUID PRIMARY KEY,
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  relation TEXT NOT NULL CHECK (relation IN ('depends_on', 'blocks', 'conflicts_with', 'shares_resource')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (task_id, depends_on_task_id, relation)
);

CREATE TABLE task_conflicts (
  id UUID PRIMARY KEY,
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  other_task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'blocking')),
  resource TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'RESOLVED', 'IGNORED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX task_conflicts_task_idx ON task_conflicts(task_id, status);

CREATE TABLE resource_locks (
  id UUID PRIMARY KEY,
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  resource_kind TEXT NOT NULL,
  resource_key TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('HARD', 'SOFT')),
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX resource_locks_hard_unique ON resource_locks(resource_kind, resource_key)
  WHERE mode = 'HARD' AND released_at IS NULL;

CREATE TABLE sandboxes (
  id UUID PRIMARY KEY,
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  workspace_path TEXT NOT NULL,
  container_id TEXT,
  container_name TEXT,
  image TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'CREATING'
    CHECK (status IN ('CREATING', 'RUNNING', 'PAUSED', 'STOPPED', 'DESTROYED', 'ERROR')),
  mode TEXT NOT NULL DEFAULT 'READ_ONLY' CHECK (mode IN ('READ_ONLY', 'READ_WRITE')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX sandboxes_task_idx ON sandboxes(task_id);

CREATE TABLE test_runs (
  id UUID PRIMARY KEY,
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  run_id UUID REFERENCES task_runs(id) ON DELETE SET NULL,
  command TEXT NOT NULL,
  exit_code INTEGER NOT NULL,
  passed BOOLEAN NOT NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  log_artifact_id UUID REFERENCES artifacts(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX test_runs_task_idx ON test_runs(task_id, created_at DESC);

CREATE TABLE qa_runs (
  id UUID PRIMARY KEY,
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  run_id UUID NOT NULL REFERENCES task_runs(id) ON DELETE CASCADE,
  iteration INTEGER NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('APPROVED', 'REJECTED', 'BLOCKED')),
  findings JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX qa_runs_task_idx ON qa_runs(task_id, iteration);

CREATE TABLE git_refs (
  id UUID PRIMARY KEY,
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  ref_name TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE git_changes (
  id UUID PRIMARY KEY,
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  change_type TEXT NOT NULL,
  insertions INTEGER NOT NULL DEFAULT 0,
  deletions INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX git_changes_task_idx ON git_changes(task_id);

CREATE TABLE runtime_manifests (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  manifest JSONB NOT NULL,
  validated BOOLEAN NOT NULL DEFAULT false,
  validation_log TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, version)
);

CREATE TABLE system_versions (
  id UUID PRIMARY KEY,
  version TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'CANDIDATE'
    CHECK (status IN ('CANDIDATE', 'ACTIVE', 'KNOWN_GOOD', 'FAILED', 'RETIRED')),
  schema_version TEXT NOT NULL DEFAULT '0001',
  installed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  activated_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE system_state_snapshots (
  id UUID PRIMARY KEY,
  system_version_id UUID REFERENCES system_versions(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The system_migrations ledger is owned by the migration runner itself, which
-- creates it before any migration runs.

CREATE TABLE metrics (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id UUID REFERENCES tasks(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  value DOUBLE PRECISION NOT NULL,
  labels JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX metrics_name_idx ON metrics(project_id, name, created_at DESC);
