-- Many projects, one queue, stories that are built before they are run, and a
-- chat that shares the same usage ledger as the agents.
--
-- Additive, like every migration here: `migrate` verifies the checksum of
-- everything it has already applied and the apply flow runs it, so an earlier
-- migration can never be rewritten without breaking the system's ability to
-- update itself.

-- ---------------------------------------------------------------------------
-- Projects are added and removed from the cockpit now, so a project carries the
-- state of its own setup rather than being assumed ready the moment it exists.
-- ---------------------------------------------------------------------------
ALTER TABLE projects ADD COLUMN description TEXT;
ALTER TABLE projects ADD COLUMN setup_state TEXT NOT NULL DEFAULT 'READY'
  CHECK (setup_state IN ('PENDING', 'RUNNING', 'READY', 'FAILED'));
ALTER TABLE projects ADD COLUMN setup_error TEXT;
ALTER TABLE projects ADD COLUMN archived_at TIMESTAMPTZ;

-- A repository may only be registered once, which is what stopped two projects
-- pointing at the same worktree root and fighting over the same branches.
CREATE UNIQUE INDEX projects_repo_path_key ON projects(repo_path);

-- ---------------------------------------------------------------------------
-- Settings the cockpit may change while the system runs.
--
-- Everything else stays an environment variable read at startup. These are the
-- values a person needs to change without a restart: a token, how much work runs
-- at once, and the budget the usage is measured against.
-- ---------------------------------------------------------------------------
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  -- Secrets are never returned by the API, only whether one is set.
  secret BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- The queue is global and ordered by hand.
--
-- position comes from a sequence so insertion order is the natural order and a
-- drag in the cockpit only has to write new numbers. consumes_slot is stored
-- rather than derived in SQL, because the admission rule counts it in the same
-- statement that claims a job and cannot call into the domain to ask.
-- ---------------------------------------------------------------------------
CREATE SEQUENCE jobs_position_seq;
ALTER TABLE jobs ADD COLUMN position BIGINT NOT NULL DEFAULT nextval('jobs_position_seq');
ALTER TABLE jobs ADD COLUMN consumes_slot BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE jobs ADD COLUMN project_id UUID REFERENCES projects(id) ON DELETE CASCADE;
-- A single entry parked by hand, which is not the same as pausing the whole
-- queue and not the same as cancelling the work.
ALTER TABLE jobs ADD COLUMN held_at TIMESTAMPTZ;

UPDATE jobs j SET project_id = t.project_id FROM tasks t WHERE t.id = j.task_id AND j.project_id IS NULL;

DROP INDEX jobs_claim_idx;
CREATE INDEX jobs_claim_idx ON jobs(position, created_at) WHERE status = 'PENDING';
CREATE INDEX jobs_running_slot_idx ON jobs(status) WHERE status = 'RUNNING' AND consumes_slot;
CREATE INDEX jobs_project_idx ON jobs(project_id, created_at DESC);

-- Work that belongs to a project rather than to a task still must not queue
-- twice. The existing index only covers rows that have a task.
CREATE UNIQUE INDEX jobs_single_pending_per_project_type ON jobs(project_id, job_type)
  WHERE status = 'PENDING' AND task_id IS NULL AND project_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Runs stop being task-only.
--
-- Intake and chat are agent work that costs real tokens and belongs in the same
-- ledger, otherwise the weekly figure is missing whole categories of spend. The
-- table keeps its name; kind says what the run was for and subject_id points at
-- it when it is not a task.
-- ---------------------------------------------------------------------------
ALTER TABLE task_runs ADD COLUMN project_id UUID REFERENCES projects(id) ON DELETE CASCADE;
ALTER TABLE task_runs ADD COLUMN kind TEXT NOT NULL DEFAULT 'TASK'
  CHECK (kind IN ('TASK', 'IDEA', 'CHAT'));
ALTER TABLE task_runs ADD COLUMN subject_id UUID;

UPDATE task_runs r SET project_id = t.project_id FROM tasks t WHERE t.id = r.task_id AND r.project_id IS NULL;
-- Every existing run has a task and therefore a project, so this cannot fail
-- here; from now on the column is the scope every usage query reads.
ALTER TABLE task_runs ALTER COLUMN project_id SET NOT NULL;
ALTER TABLE task_runs ALTER COLUMN task_id DROP NOT NULL;

CREATE INDEX task_runs_project_window_idx ON task_runs(project_id, finished_at DESC);
CREATE INDEX task_runs_subject_idx ON task_runs(subject_id) WHERE subject_id IS NOT NULL;

-- Two more agents: the one that turns an idea into stories, and the one behind
-- the chat window.
ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_type_check;
ALTER TABLE agents ADD CONSTRAINT agents_type_check
  CHECK (type IN ('research', 'review', 'implementation', 'qa', 'learning', 'intake', 'chat'));

-- ---------------------------------------------------------------------------
-- Building a story before running it.
--
-- An idea is a conversation that ends in one or more story drafts. The drafts
-- are the thing a person keeps, edits and launches; the session is the record of
-- how they were arrived at.
-- ---------------------------------------------------------------------------
CREATE TABLE idea_sessions (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  idea TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'QUEUED'
    CHECK (status IN ('QUEUED', 'THINKING', 'ASKING', 'READY', 'FAILED', 'DISCARDED')),
  -- What the agent understood, shown above the questions so a person can tell
  -- early that it has taken the idea the wrong way.
  understanding TEXT,
  round INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idea_sessions_project_idx ON idea_sessions(project_id, created_at DESC);

CREATE TABLE idea_questions (
  id UUID PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES idea_sessions(id) ON DELETE CASCADE,
  round INTEGER NOT NULL,
  sequence INTEGER NOT NULL,
  question TEXT NOT NULL,
  -- Why this is being asked, so an answer is a decision rather than a guess.
  rationale TEXT NOT NULL DEFAULT '',
  -- [{ key, label, detail }]. Two or three, never more: a list of ten is a form.
  options JSONB NOT NULL DEFAULT '[]'::jsonb,
  chosen_key TEXT,
  custom_answer TEXT,
  answered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (session_id, round, sequence)
);
CREATE INDEX idea_questions_session_idx ON idea_questions(session_id, round, sequence);

CREATE TABLE story_drafts (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  session_id UUID REFERENCES idea_sessions(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  -- Why this is its own story rather than part of another one.
  rationale TEXT NOT NULL DEFAULT '',
  -- Drafts a split produced are ordered, because the order is often a dependency.
  sequence INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'LAUNCHED', 'DISCARDED')),
  -- Set when the draft was launched, so the cockpit can link the two.
  task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX story_drafts_project_idx ON story_drafts(project_id, status, sequence);

-- ---------------------------------------------------------------------------
-- Decisions the review leaves open.
--
-- A decision was a line of prose in the open questions section, which meant
-- nothing could gate on it. A blocking one now holds the approval.
-- ---------------------------------------------------------------------------
CREATE TABLE review_decisions (
  id UUID PRIMARY KEY,
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  review_version_id UUID NOT NULL REFERENCES review_versions(id) ON DELETE CASCADE,
  -- Stable across regenerations, so an answered decision stays answered when
  -- the review is rewritten around it.
  key TEXT NOT NULL,
  question TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  blocking BOOLEAN NOT NULL DEFAULT false,
  -- [{ key, label, detail, consequence, recommended }]
  options JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'ANSWERED')),
  -- One of the option keys, or the two standing choices: 'custom' and 'agent'.
  chosen_key TEXT,
  custom_answer TEXT,
  answered_by TEXT,
  answered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (review_version_id, key)
);
CREATE INDEX review_decisions_task_idx ON review_decisions(task_id, status);

-- The remarks a QA run made without blocking on them. They were described in the
-- summary prose and then never reached the agent that could have acted on them.
ALTER TABLE qa_runs ADD COLUMN notes JSONB NOT NULL DEFAULT '[]'::jsonb;

-- ---------------------------------------------------------------------------
-- Chat with the engine, in a project.
--
-- The transcript lives here rather than only in the CLI's own session store,
-- because the cockpit has to be able to show it after a restart and the session
-- store is not ours to read.
-- ---------------------------------------------------------------------------
CREATE TABLE chat_sessions (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT 'New chat',
  -- The CLI's own session id, so every turn continues the same conversation.
  engine_session_id UUID,
  -- What this chat is allowed to do in the project directory. `auto` is the
  -- default because the window exists to be the terminal a person would open
  -- there: under `acceptEdits` an ordinary `npm test` is refused, measured
  -- against CLI 2.1.268, which makes the window much less than it claims to be.
  permission_mode TEXT NOT NULL DEFAULT 'auto',
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX chat_sessions_project_idx ON chat_sessions(project_id, updated_at DESC);

CREATE TABLE chat_messages (
  id UUID PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  -- Written as the stream arrives, so a long answer is readable while it is
  -- still being produced.
  content TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'COMPLETE'
    CHECK (status IN ('PENDING', 'STREAMING', 'COMPLETE', 'FAILED')),
  -- [{ name, input }] in the order the engine called them.
  tool_calls JSONB NOT NULL DEFAULT '[]'::jsonb,
  run_id UUID REFERENCES task_runs(id) ON DELETE SET NULL,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (session_id, sequence)
);
CREATE INDEX chat_messages_session_idx ON chat_messages(session_id, sequence);

-- ---------------------------------------------------------------------------
-- Removing a project, against an append-only event log.
--
-- The log is append-only by design, and it was enforced with rules that turn an
-- UPDATE or a DELETE into nothing at all. That works until a project is removed:
-- the delete cascades into events, the rule silently cancels that half of it, and
-- the foreign key check then fails with "this is most likely due to a rule having
-- rewritten the query" — a message that says nothing about projects, events or
-- what the operator asked for. Deleting a project was impossible and the reason
-- was unreadable.
--
-- The guarantee worth keeping is that the system's own code can never rewrite
-- history. Removing a project is not that: it is a person deliberately deleting
-- everything about one repository, and the log of a project that no longer exists
-- is not an audit trail anyone can use.
--
-- So the rules become a trigger that refuses loudly, with one exception that has
-- to be asked for explicitly inside the transaction that does the removal. A
-- silent no-op is replaced by a refusal that names itself.
-- ---------------------------------------------------------------------------
DROP RULE events_no_update ON events;
DROP RULE events_no_delete ON events;

CREATE FUNCTION events_are_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND coalesce(current_setting('ai_engine.allow_event_deletion', true), '') = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION
    'The event log is append only. A row may only be deleted while removing a project, which sets ai_engine.allow_event_deletion.'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER events_append_only
  BEFORE UPDATE OR DELETE ON events
  FOR EACH ROW EXECUTE FUNCTION events_are_append_only();
