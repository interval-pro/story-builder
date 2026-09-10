-- An installation of the system is itself a project, so a story can change the
-- engine that serves a repository without changing the repository. That makes
-- the distinction a property of the project rather than of the story, and the
-- kind carried by stories and tasks redundant.

ALTER TABLE projects
  ADD COLUMN kind TEXT NOT NULL DEFAULT 'PROJECT' CHECK (kind IN ('PROJECT', 'INSTALLATION'));

ALTER TABLE stories DROP COLUMN kind;
ALTER TABLE tasks DROP COLUMN kind;

-- Applying a candidate stops every service, so its progress cannot be kept in
-- the process doing the work. Postgres stays up throughout and is the only
-- place the cockpit can read the outcome from once it comes back.
CREATE TABLE installation_applies (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
  source TEXT NOT NULL CHECK (source IN ('TASK', 'UPSTREAM')),
  candidate_ref TEXT NOT NULL,
  previous_commit TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING', 'SUCCEEDED', 'FAILED', 'ROLLED_BACK')),
  step TEXT NOT NULL DEFAULT 'starting',
  log TEXT NOT NULL DEFAULT '',
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);
CREATE INDEX installation_applies_project_idx ON installation_applies(project_id, started_at DESC);
