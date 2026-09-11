-- What a run cost, on the run itself rather than only as a loose metric.
--
-- Every column is nullable with no default, deliberately: NULL means never
-- recorded and zero means genuinely free. A run that failStaleRuns marks FAILED
-- records nothing, and the built-in engine reports no cost, so collapsing NULL
-- to zero would under-report real spend and the cockpit would quietly lie.
ALTER TABLE task_runs ADD COLUMN cache_read_tokens INTEGER;
ALTER TABLE task_runs ADD COLUMN cache_creation_tokens INTEGER;
ALTER TABLE task_runs ADD COLUMN cost_usd DOUBLE PRECISION;
ALTER TABLE task_runs ADD COLUMN model_usage JSONB;
ALTER TABLE task_runs ADD COLUMN subagent_stats JSONB;

-- The rolling window filters finished_at across all tasks, which the existing
-- (task_id, started_at DESC) index cannot serve.
CREATE INDEX task_runs_finished_idx ON task_runs (finished_at DESC) WHERE finished_at IS NOT NULL;
