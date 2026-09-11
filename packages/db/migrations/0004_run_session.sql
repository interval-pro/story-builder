-- What a run was, not only what it spent: which session it used, whether it
-- resumed one, and the effort and model it actually ran at.
--
-- Every column is nullable with no default, following the convention 0003 set:
-- NULL means never recorded. That distinction carries real weight on `resumed`.
-- A NOT NULL DEFAULT false would make "never recorded" indistinguishable from
-- "started cold", and the built-in engine, which has no sessions at all, would
-- then report every run as a cold start it deliberately chose.
ALTER TABLE task_runs ADD COLUMN session_id UUID;
ALTER TABLE task_runs ADD COLUMN resumed BOOLEAN;
ALTER TABLE task_runs ADD COLUMN effort TEXT;
ALTER TABLE task_runs ADD COLUMN model TEXT;

-- How big the change is, classified once when the review runs and then held for
-- the rest of the task. Implementation and QA read it instead of each deriving
-- the same answer again, because changing the effort inside a session is what
-- rebuilds the prompt cache from scratch.
ALTER TABLE tasks ADD COLUMN size TEXT;
