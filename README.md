# AI Engineering System

An engineering process in which AI participates as several engineers, installed
into one Git repository and working only on that project.

The system is not an agent you ask for a feature. It is a lifecycle with human
gates:

```
story -> research -> engineering review -> your notes -> review v2 -> approval
      -> implementation -> tests -> independent QA -> fix loop -> final report
      -> your approval -> rebase and validation -> push -> pull request -> learning
```

## Principles

- The LLM reasons. The orchestrator decides. Postgres is the source of truth.
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
cp .env.example .env          # set PROJECT_ROOT, AI_PROVIDER and AI_API_KEY
docker compose build
docker compose up -d
npm run ai-engine -- init --repo /absolute/path/to/your/repository
```

Then open http://localhost:3000 and write a story.

Without an API key the system runs with the mock provider: the whole lifecycle
works end to end, but the agents produce placeholder documents.

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
  tools/            the tool layer that every agent action goes through
  agents/           research, review, implementation, QA and learning
  project-brain/    principles and invariants learned from your corrections
  project-knowledge/ what the project is actually made of
  conflict-engine/  impact manifests, locks and base drift
  runtime-manifest/ how this project builds, tests and migrates
  security/         command policy, path policy, secrets and redaction
  git/ github/      worktrees, diffs and pull requests
```

## The lifecycle in practice

**Story.** Free text. It gets an immutable revision; changing it creates the
next revision and re-runs the analysis.

**Research.** A read-only agent works through the repository until it can explain
the current behaviour end to end. It cannot write anything.

**Engineering review.** A structured document with one recommended approach, its
downsides, the risks, the testing strategy and a step by step plan. No
confidence percentages.

**Your notes.** You do not edit the review. You select a fragment and write what
is wrong with it. The review is regenerated from your notes and shows what
changed.

**Approval.** This is the gate that turns read-only analysis into write access.
High risk work, such as a database migration, needs a second explicit approval
before any code is written.

**Implementation.** Runs in an isolated sandbox on a Git worktree. The approved
review is a contract: work the review did not cover becomes a supplemental
review for you to decide on, never a silent expansion.

**QA.** A separate agent with a fresh context reviews the diff and the test
results. Findings go back to implementation, at most five times, and then the
task is blocked for a human.

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

Everything is configured through environment variables; see `.env.example`. The
ones that change behaviour most:

| Variable | Meaning |
| --- | --- |
| `PROJECT_ROOT` | The repository this installation manages |
| `AI_PROVIDER` | `anthropic`, `openai` or `mock` |
| `SANDBOX_DOCKER_ENABLED` | `false` runs tasks in host worktrees instead of containers |
| `MAX_QA_ITERATIONS` | How many fix cycles before a task is blocked |
| `GITHUB_TOKEN` | Without it the system stops at a local branch |
