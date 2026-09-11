# AI Engineering System

An engineering process in which AI participates as several engineers. It is a
layer installed beside your repositories, serving as many of them as you add to
it.

The layer and the projects are separate things. The layer is a clone of a
released version living outside any repository, by default under
`~/.story-builder/story-builder`. A project you add only gains a marker naming
the installation that serves it, a runtime manifest and a place for its own
rules.

The system is not an agent you ask for a feature. It is a lifecycle with human
gates:

```
idea -> questions you answer -> one or more stories -> you launch one
     -> research -> plan -> decisions you make -> your approval
     -> implementation -> tests -> independent checks -> fix loop -> report
     -> your approval -> rebase and validation -> push -> pull request -> learning
```

Every project shares one queue and one account limit. Everything else — stories,
knowledge, principles, chats, statistics — belongs to the project it came from.

## Principles

- The LLM reasons. The orchestrator decides. Postgres is the source of truth.
- An idea is shaped into stories before anything runs, because an idea that is
  really four stories becomes a review nobody can approve as a whole.
- A question the plan cannot answer is a decision you make by clicking, and a
  blocking one holds the approval rather than being guessed.
- Agents are stateless. Everything that matters is written down, so a crashed
  worker is replaceable mid-task.
- Before your approval the system is read-only. After it, writes are confined to
  the task sandbox.
- No task ever touches your working copy. Each one gets its own Git worktree.
- Nothing is pushed until you approve the final report.

## Requirements

Docker, Docker Compose and Git. Node.js 20 or newer if you want to run the
services outside Docker.

## Getting started

```bash
curl -fsSL https://raw.githubusercontent.com/interval-pro/story-builder/main/install.sh -o install.sh
chmod +x install.sh
./install.sh
```

That clones the latest release into `~/.story-builder/story-builder`, builds it
and starts Postgres. No repository is needed yet. Then start it:

```bash
cd ~/.story-builder/story-builder
./scripts/dev-up.sh
```

Open http://localhost:3000, add a project by giving the path of a Git repository
with at least one commit, and describe an idea. Adding a project reads it once to
work out how it builds; a story cannot start until that has finished.

Pass `--repo /path/to/a/repository` to the installer if you want the first
project registered straight away.

Ask what you are running and whether it has drifted from upstream:

```bash
node apps/cli/dist/main.js version
```

By default the agents run as headless Claude Code sessions inside the task
worktree, using the login your `claude` CLI already has. No API key is involved.
Set `AGENT_ENGINE=builtin` to use the in-process tool loop instead, which needs
`AI_PROVIDER` and `AI_API_KEY`; with `AI_PROVIDER=mock` the whole lifecycle runs
offline with placeholder documents.

Because the CLI reads its credentials from your home directory, run the worker
as your own user on the host. Running it inside a container also requires the
CLI in the image and the credentials mounted in.

## One queue

Every project shares one queue, and what is in it are steps rather than whole
stories. A slot is taken only while an agent session or a test run is actually
happening, so a story waiting for your answer holds nothing up, and when a review
finishes the freed slot goes to whatever is next in line — another review or
anything else.

How many slots there are is a setting, and the default is one. Raising it does
not make one story finish sooner; it lets several stories progress at once,
against one account limit and one machine. The chat window never waits for a
slot.

Reorder the queue by dragging, hold one entry without pausing the rest, or pause
everything. Work already running finishes rather than being killed.

## Usage

Usage is counted in tokens, never in money. The engine reports a cost per run and
the database keeps it, because discarding a measurement cannot be undone, but
nothing downstream carries it: this runs on a subscription with a weekly token
limit, so a dollar figure answers a question nobody is asking.

The engine reports no account limit of any kind, so the cockpit cannot show one.
What it shows instead is a rolling seven days of real usage, and a weekly budget
you set yourself, clearly labelled as yours. Any limit field a future CLI does
report is stored and surfaced unchanged rather than summarised.

Per story you get tokens per run, which run was the largest, how long each step
took, and how many runs recorded nothing at all — because a run killed before the
engine printed its result is spend that is real and missing.

## Chat

A chat window per project, with sessions that persist. It runs the engine in the
project directory, the way your own terminal does, and the cockpit says what it
is allowed to do there. It is the right tool for looking at something; a story is
the right tool when you want a plan, a review and a record.

## Layout

```
apps/
  api/              HTTP API, the only way the UI reaches the system
  orchestrator/     the sole authority over task state
  worker/           claims jobs from the durable queue and runs the agents
  sandbox-manager/  the only service with Docker privileges
  cli/              ai-engine init / start / stop / status / export / import
  web/              the cockpit

packages/
  domain/           the state machine, capabilities, risk and review model
  db/               schema, migrations and repositories
  events/           the append-only event log
  queue/            the Postgres job queue
  artifacts/        artifact storage, out of Postgres
  ai-provider/      Anthropic, OpenAI and mock adapters
  claude-code/      runs each agent as a headless Claude Code session
  tools/            the tool layer that every agent action goes through
  agents/           intake, research, review, implementation, QA and learning
  project-brain/    principles and invariants learned from your corrections
  project-knowledge/ what the project is actually made of
  conflict-engine/  impact manifests, locks and base drift
  runtime-manifest/ how this project builds, tests and migrates
  security/         command policy, path policy, secrets and redaction
  git/ github/      worktrees, diffs and pull requests
```

## The lifecycle in practice

**Idea.** You describe what should change in plain language. A read-only agent
reads the project, asks at most three questions with two or three concrete
options each, and then writes one or more stories you can edit, keep or discard.
Nothing runs until you launch one.

**Story.** Free text. It gets an immutable revision; changing it creates the
next revision and re-runs the analysis.

**Research.** A read-only agent works through the repository until it can explain
the current behaviour end to end. It cannot write anything.

**The plan.** A short version you can read in a minute — what changes, what to
watch out for, how big it is — and a full document behind it with one recommended
approach, its downsides, the risks, the testing strategy and a step by step plan.
No confidence percentages.

**Decisions.** Questions the plan cannot answer itself, each with two or three
options and what each one costs. You answer by clicking, or in your own words, or
you hand the choice back. A blocking decision holds the approval: the alternative
is the agent guessing.

**Your notes.** You do not edit the review. You select a fragment and write what
is wrong with it. The review is regenerated from your notes and shows what
changed.

**Approval.** This is the gate that turns read-only analysis into write access.
High risk work, such as a database migration, needs a second explicit approval
before any code is written.

**Implementation.** Runs in an isolated sandbox on a Git worktree. The approved
review is a contract: work the review did not cover becomes a supplemental
review for you to decide on, never a silent expansion.

**Checks.** A separate agent with a fresh context reviews the diff and the test
results. Findings go back to implementation, at most five times, and then the
story waits for a human. Findings accumulate across iterations rather than being
replaced, and remarks the checks did not block on are carried to the fix.

**Final report.** Planned versus actual, computed rather than narrated: which
files were planned, which were changed, what deviated and why, what the tests
did, what QA found and what risk is left.

**Pull request.** Only after you approve. The branch is rebased onto the current
base, the checks run again on the rebased result, and only then is anything
pushed.

**Learning.** Your corrections are turned into the reasoning behind them and
stored in the Project Brain. Not "always use NotificationService", but "prefer
extending an existing domain responsibility instead of introducing another
component when the behaviour belongs to the same boundary".

## Pushing from a headless worker

The push is the one step that leaves the machine, and it is the step most likely
to fail in an automated setup. A desktop Git install authenticates through the
operating system keychain and falls back to prompting on a terminal. A worker
has neither: no keychain session and no terminal.

So the worker never relies on ambient credentials. It injects `GITHUB_TOKEN` for
that single `git push` through a helper that lives only for the duration of the
command. The ambient helper is cleared first, so a broken or locked keychain
cannot be consulted, and the token never reaches `.git/config`, the remote URL
or the reflog. Prompting is disabled everywhere, so a missing credential fails
with a readable error instead of hanging.

If the push fails the story is blocked with the Git error attached, and the
message says explicitly when no token was configured. From there you can retry
the push itself: it is a step the cockpit offers directly, because every other
route out of a block re-runs an agent over work that was already finished.

## Working on the system itself

The system is installed into the repository as `.ai-engineering/`, and it is a
project like any other. A story marked as a system story may change the agents,
the prompts, the policies, the orchestrator and the database. The active version
is never overwritten in place: a candidate is installed side by side, migrated
and tested, and only then does `current` move.

## Development

```bash
npm install
npm run build
npm test
npm run migrate
```

Each service can be run on its own with `npm run dev:api`, `dev:orchestrator`,
`dev:worker`, `dev:sandbox-manager` and `dev:web`.

`npm test` runs against the TypeScript sources through a resolver in `scripts/`,
so the unit suite works without a build. `npm run build` compiles every package
with project references and is what the Docker images use.

## Configuration

Some of it lives in the cockpit, under Settings: how many jobs run at once,
whether the queue is paused, the weekly token budget, the GitHub token, how many
fix cycles are allowed, the model override, how large an implementation session
may grow before a fix starts cold, and what the chat window may do. Those take
effect on the next thing that reads them, with no restart.

The rest is environment variables a restart would have to follow anyway; see
`.env.example`. A value set in the cockpit wins over the environment variable of
the same meaning, and the Settings screen says which one it is using.

The ones that change behaviour most:

| Variable | Meaning |
| --- | --- |
| `PROJECT_ROOT` | Optional. A first repository to register at install time; projects are added from the cockpit |
| `AGENT_ENGINE` | `claude-code` (default) or `builtin` |
| `AGENT_ALLOW_SUBAGENTS` | `false` (default). Lets an agent delegate. If you turn it on, one subagent at a time is the limit; the CLI cannot enforce that |
| `AI_PROVIDER` | Only for the builtin engine: `anthropic`, `openai` or `mock` |
| `SANDBOX_DOCKER_ENABLED` | `false` runs tasks in host worktrees instead of containers |
| `MAX_QA_ITERATIONS` | How many fix cycles before a story waits for you. Overridden by Settings |
| `GITHUB_TOKEN` | Needed to push. Without it the system stops at a local branch. Overridden by Settings |
| `WORKSPACES_ROOT` | Where task worktrees go. It must not be inside `~/.claude`, `~/.config` or `~/.ssh`: the CLI refuses to write there, and an agent whose worktree sits in one reads everything, writes nothing, and reports honestly that it implemented nothing. The system refuses such a path rather than letting you find out that way |
| `JOB_LEASE_SECONDS` | How long a claimed job is held before it is treated as abandoned. Clamped to at least 120, because the worker renews every `max(30s, lease/3)` and a shorter lease lets a second worker start the same agent in the same worktree |
