# Cockpit v2: multi-project, one queue, idea intake, new UI

The change is large enough that the order matters. Each phase leaves the tree
building and the tests passing, so a failure is localised to the phase that
caused it.

The database is being reset as part of this change, which the owner asked for.
Migrations are still append-only: `migrate` verifies the checksum of every
migration it has already applied, and the apply flow runs it, so rewriting
`0001` would break the system's own ability to update itself. New work goes into
`0005` and later.

## Decisions taken before writing code

**The queue holds steps, not stories.** A story is a sequence of jobs with human
gates between them. If the story held the slot, one review waiting for a human
would block every other project. So: a job occupies a slot only while an agent
is actually running, a task waiting at a human gate occupies nothing, and when a
review finishes the freed slot goes to whatever is next in line, review or not.
The cockpit therefore shows two lists, because there are two different things:
**In the queue** (work the machine will do) and **Waiting for you** (work that
cannot move until a human answers).

**Concurrency is a number, default 1.** Several Claude Code processes can run at
once, each in its own worktree, and nothing in the design forbids it. They share
one weekly account limit and one machine, so the default is one and the setting
is global, not per project.

**Chat does not take an agent slot.** A chat turn is a person waiting at a
keyboard. It runs on its own allowance, one turn per session at a time.

**Tokens, never money.** Cost in dollars stays in the database, because it is
measured data the engine reported, and leaves every API response and every
screen.

**The weekly limit cannot be read from the CLI.** The result payload carries no
limit field. Two honest things are possible and both are done: any
rate-limit-shaped key the payload does turn out to carry is stored and shown, and
a weekly token budget the owner sets is tracked against a rolling seven-day sum
of real usage. The screen says which of the two it is showing.

## Phase 1 — Schema and domain

Migration `0005_cockpit_v2.sql`:

- `projects`: `status`, `archived_at`, `description`, `setup_state`,
  `setup_error`. Deleting a project already cascades.
- `settings`: key, value, secret flag, updated_at. Holds what the UI may change
  at runtime: the GitHub token, queue concurrency, the weekly token budget, the
  chat permission mode.
- `jobs`: `position BIGINT` from a sequence so insertion order is the natural
  order and a drag writes new values; `consumes_slot BOOLEAN`; `project_id` so
  the queue view can name the project without a join through tasks; `held_at`
  for a single entry parked by hand.
- `task_runs`: `project_id` (backfilled, then NOT NULL), `task_id` nullable,
  `kind` (`TASK`, `IDEA`, `CHAT`), `subject_id`. Usage then has one home for
  every kind of agent work, which is what the weekly tracker needs.
- `agents.type` check extended with `intake` and `chat`.
- `idea_sessions`, `idea_questions`, `story_drafts`.
- `chat_sessions`, `chat_messages`.
- `review_decisions`.
- `qa_runs.notes JSONB` for the non-blocking remarks that were being written in
  prose and then dropped.

Domain:

- `TaskState` graph: `BLOCKED → PUSHING` and `BLOCKED → INTEGRATION_VALIDATION`,
  `FAILED → PUSHING`. A failed push stops being a dead end.
- `ExecutionPhase` gains `INTAKE` and `CHAT`, with read-only capabilities for
  intake and a separate, explicit set for chat.
- `ReviewDocument` gains `brief` (the short version) and `decisions`.
- New `QueueEntry`, `IdeaSession`, `StoryDraft`, `ChatSession`, `ChatMessage`,
  `ReviewDecision`, `Settings` entities.

## Phase 2 — The queue

- `JobQueue.claim` runs inside a transaction that first takes a fixed advisory
  lock, then counts running slot-consuming jobs, then claims. Serialising claims
  is correct and cheap: a claim happens about once a second.
- Pause is a setting read inside `claim`.
- Ordering becomes `position ASC, created_at ASC`.
- `reorder(ids)` rewrites positions in one statement.
- `hold(id)` / `release(id)`.
- `overview()` returns pending and running entries with project, task, story
  title, state and age.

## Phase 3 — Projects, settings, installation

- `POST /api/projects` validates the path is a git repository with commits and
  is not the installation, inserts the row with `setup_state = PENDING`, and
  enqueues `PROJECT_SETUP`. The worker's dispatch learns to run a job that has
  no task.
- `PROJECT_SETUP` detects the runtime manifest, writes the marker and the rules
  directory into the project, and builds the first knowledge snapshot.
- `DELETE /api/projects/:id` refuses while the project has an active job,
  otherwise deletes the row and removes its worktrees and artifacts from disk.
- `SettingsService` resolves a key as database, then environment, then default,
  with a short cache. The GitHub token is read through it at the push site.
- `primaryProjectId` stops being the silent fallback. Endpoints that are
  project-scoped require `projectId`; the CLI passes it.
- `install.sh` no longer requires `--repo`: an installation is installed on its
  own and projects are added from the UI. `init` registers only the
  installation when no repository is given.
- `dev-up.sh` appends the keys a stale `.env.local` is missing instead of
  assuming a fresh one. `dev-down.sh` stops relying on `pkill`, which is inert
  on this machine, and sweeps by parsing `ps` output and the listening ports.

## Phase 4 — Agents

- **Review**: the result schema gains `brief` and `decisions`. A decision has a
  question, a blocking flag, two or three options with their consequences, and a
  recommendation. `approveReview` refuses while a blocking decision is
  unanswered. Answers are merged into the approved document so implementation
  and QA see them.
- **Intake**: a sixth agent. Reads the repository read-only, asks at most a
  handful of questions with two or three concrete options each, then emits one
  or more story drafts with a title and a body.
- **QA**: findings accumulate. `openQaFindings` unions the open findings of
  every iteration, de-duplicated on file and summary, and the agent's
  non-blocking notes are stored and passed to the fix agent.
- **Implementation context cap**: a fix resumes the previous session only while
  that session is still small. Past a configurable ceiling it starts cold with
  the approved plan and the open findings, which is the whole point: the bill is
  turns multiplied by context size, and an 800k-token session re-read on every
  turn is where the money went.
- **Usage on the failure path**: the CLI accumulates usage from the stream as it
  arrives, so a run killed by a timeout still reports what it spent. The answer
  pass failing no longer discards the work pass's usage.
- **Learning**: records its session at start, like every other phase.
- **Chat**: a runner that speaks to the CLI in the project directory, resumes
  the session on every turn, and writes assistant text into the message row as
  it streams.

## Phase 5 — API

New and changed endpoints, all returning tokens and never money:

    GET/POST/DELETE /api/projects, /api/projects/:id
    GET/PUT         /api/settings
    GET             /api/queue            POST /api/queue/{pause,resume,reorder}
    POST            /api/queue/:id/{hold,release,cancel}
    POST            /api/ideas            POST /api/ideas/:id/answers
    GET             /api/ideas/:id
    GET/PUT/DELETE  /api/drafts, /api/drafts/:id
    POST            /api/drafts/:id/launch
    GET             /api/tasks/:id/progress
    POST            /api/tasks/:id/decisions/:key
    POST            /api/tasks/:id/push-retry
    GET/POST        /api/chat/sessions, /api/chat/sessions/:id/messages
    GET             /api/usage

`assertCanApply` gates on active jobs and names the tasks that are in the way.
`retry` sends a task with open review notes back to a regeneration instead of
throwing the notes away.

## Phase 6 — The cockpit

The Interval Pro design system, rebuilt as CSS custom properties and a small set
of React components: deep navy fields, ivory type, one orange for action,
Literata for display and Manrope for everything functional, 8px surfaces and 6px
controls, no shadows anywhere.

Screens:

- **Overview**: what is running, what is waiting for you, the queue depth, the
  week's token usage, recent finished work. Per project and across all of them.
- **Queue**: one list for every project, drag to reorder, pause and resume,
  hold one entry, and a separate panel for the tasks waiting on a human.
- **Stories**: drafts the intake produced and tasks already launched.
- **Describe idea**: a text box, then questions one at a time with clickable
  options and an "Other" box, then the drafts it produced.
- **Story**: an overview tab with a stepper — every step with its status, start,
  end, duration and result — then Plan (short and full), Work, Checks, Report,
  Timeline and Usage.
- **Chat**: session list beside a transcript, per project.
- **Brain**, **Knowledge**, **System**, **Settings**.

Every state badge and QA verdict carries a plain-language explanation of what it
means and what happens next.

## Phase 7 — Verification

- `npm run build` and `npm test` green, with new unit tests for the queue
  admission rule, the reorder, the decision gate, cumulative QA findings, the
  usage-on-failure path, the progress derivation and the settings resolution.
- A scratch database: migrate from empty, confirm every new table and column.
- Start the services, add a project through the API, walk a story from idea to
  review, confirm the screens render.
- Run the `--add-dir` with `--resume` experiment against the real CLI and record
  the answer, since nobody has confirmed it.
