-- Tables and columns nothing reads any more.
--
-- Each was checked against every query in the code before it was dropped, not
-- just against its own repository: none is selected, inserted or joined on.

-- The Docker sandbox recorded one row per task here. The sandbox manager is gone:
-- a story works in the project directory on a branch of its own.
DROP TABLE IF EXISTS sandboxes;

-- The first idea of version tracking. What is running is recorded in build.json,
-- and every rebuild and update in installation_applies, with its snapshot path.
DROP TABLE IF EXISTS system_state_snapshots;
DROP TABLE IF EXISTS system_versions;

-- Where an artifact's bytes lived when artifacts were files. They are rows now,
-- and an installation from before that is installed fresh rather than upgraded.
ALTER TABLE artifacts DROP COLUMN IF EXISTS storage_path;
