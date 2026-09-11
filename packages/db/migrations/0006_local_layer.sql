-- The layer becomes local: one checkout, no worktrees, nothing written into the
-- projects it works on, and everything a project accumulates in the database.

-- ---------------------------------------------------------------------------
-- Artifacts stop being half a file and half a row.
--
-- A research finding, a transcript, a report or a diff is text measured in
-- kilobytes. Keeping the bytes on disk and the index in Postgres meant the two
-- halves could disagree: deleting a project took the rows and left the files, and
-- the only thing that put them back together was code that remembered to remove
-- both. Now the row is the artifact.
--
-- storage_path stays, nullable, for rows written before this. Nothing reads it
-- any more; it is kept so an installation that upgrades can still say where an
-- old artifact used to be rather than pretending it never existed.
-- ---------------------------------------------------------------------------
ALTER TABLE artifacts ADD COLUMN content BYTEA;
ALTER TABLE artifacts ALTER COLUMN storage_path DROP NOT NULL;
ALTER TABLE artifacts ALTER COLUMN checksum DROP NOT NULL;

-- ---------------------------------------------------------------------------
-- A project is a path and a branch, and nothing inside it is ours.
--
-- work_branch is the branch stories start from and merge back into. It defaults
-- to the branch the repository was on when it was added, and it is changeable:
-- the same project may be worked on against main today and a release branch
-- tomorrow.
-- ---------------------------------------------------------------------------
ALTER TABLE projects ADD COLUMN work_branch TEXT;
UPDATE projects SET work_branch = default_branch WHERE work_branch IS NULL;
ALTER TABLE projects ALTER COLUMN work_branch SET NOT NULL;

-- Whether a push and a pull request are actually possible, established when the
-- project is added rather than discovered by a push that fails at the very end.
ALTER TABLE projects ADD COLUMN remote_access TEXT NOT NULL DEFAULT 'UNKNOWN'
  CHECK (remote_access IN ('UNKNOWN', 'NONE', 'READ', 'WRITE'));
ALTER TABLE projects ADD COLUMN remote_checked_at TIMESTAMPTZ;

-- ---------------------------------------------------------------------------
-- A story owns the project directory while it runs.
--
-- There are no worktrees any more, so two stories in one project would be two
-- agents writing to one checkout. The branch and the base are already on the
-- task; what is added is the branch the person was on when it started, so the
-- directory can be put back exactly as it was found.
-- ---------------------------------------------------------------------------
ALTER TABLE tasks ADD COLUMN returned_to_branch TEXT;
-- The commit the work branch was on immediately before this task was merged into
-- it, which is what makes the merge undoable with one action.
ALTER TABLE tasks ADD COLUMN merge_undo_commit TEXT;
ALTER TABLE tasks ADD COLUMN merged_at TIMESTAMPTZ;

-- ---------------------------------------------------------------------------
-- Settings gain a second scope.
--
-- The global table already exists. This is the per-project override: the same
-- key, a value that wins for one project only. A repository under a different
-- account needs its own token; a project with a long test suite may want fewer
-- fix cycles.
-- ---------------------------------------------------------------------------
CREATE TABLE project_settings (
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  secret BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, key)
);

-- ---------------------------------------------------------------------------
-- Rebuilding the layer onto itself.
--
-- installation_applies described one thing: applying a candidate. There are now
-- two sources that are genuinely different — the commits already in this
-- checkout, and a release fetched from upstream — and the column that said which
-- only allowed the old pair.
-- ---------------------------------------------------------------------------
ALTER TABLE installation_applies DROP CONSTRAINT installation_applies_source_check;
ALTER TABLE installation_applies ADD CONSTRAINT installation_applies_source_check
  CHECK (source IN ('TASK', 'UPSTREAM', 'LOCAL'));

-- The commit the build was made from, so a rollback has one known-good target
-- rather than a search backwards through history.
ALTER TABLE installation_applies ADD COLUMN built_commit TEXT;
-- Where the database dump taken before migrating was written, so the rollback
-- can restore it. Null when no migration had run by the time it failed.
ALTER TABLE installation_applies ADD COLUMN snapshot_path TEXT;

-- ---------------------------------------------------------------------------
-- One story at a time per project.
--
-- Without worktrees a project has one working directory, so two jobs for the same
-- project would be two agents writing to one checkout. This is what the queue
-- reads to refuse the second one. It is separate from consumes_slot: that bounds
-- how much runs at once across everything, this bounds what may run in one
-- directory, and a chat turn holds neither.
-- ---------------------------------------------------------------------------
ALTER TABLE jobs ADD COLUMN holds_directory BOOLEAN NOT NULL DEFAULT false;
UPDATE jobs SET holds_directory = true WHERE task_id IS NOT NULL;
CREATE INDEX jobs_directory_idx ON jobs(project_id) WHERE status = 'RUNNING' AND holds_directory;

-- ---------------------------------------------------------------------------
-- A merge that stopped on conflicts holds the directory too.
--
-- The three routes out of a conflict are: let the engineer try, resolve it in
-- your own editor and say done, or abandon it. The middle one is the default,
-- and it is only possible if the conflict is left in the working tree for a
-- person to open. So while it is unresolved the project's directory is taken,
-- exactly as it is while a story runs, and the queue must refuse to start
-- anything else in it — otherwise the next story checks out over the conflict.
-- ---------------------------------------------------------------------------
ALTER TABLE projects ADD COLUMN merge_conflict_task_id UUID REFERENCES tasks(id) ON DELETE SET NULL;

-- The files git stopped on, so the cockpit can name them rather than saying
-- that "a conflict occurred" and leaving the person to go and look.
ALTER TABLE tasks ADD COLUMN merge_conflict_files TEXT[];
