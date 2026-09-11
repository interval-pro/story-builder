# AI Engineering System

An engineering process in which AI participates as several engineers. It is a
layer installed beside one Git repository, working only on that project.

The layer and the project are two separate things. The layer is a clone of a
released version living outside your repository, by default under
`~/.story-builder/<name>`. Your repository only gains a marker naming the
installation that serves it, a runtime manifest and a place for its own rules.

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
curl -fsSL https://raw.githubusercontent.com/interval-pro/story-builder/main/install.sh -o install.sh
chmod +x install.sh
./install.sh --repo /absolute/path/to/your/repository
```

That clones the latest release into `~/.story-builder/<name>`, builds it, starts
Postgres and points the installation at your repository. Then start it:

```bash
cd ~/.story-builder/<name>
./scripts/dev-up.sh
```

Open http://localhost:3000 and write a story.

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

If the push fails the task is blocked with the Git error attached, and the
message says explicitly when no token was configured.

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
| `AGENT_ENGINE` | `claude-code` (default) or `builtin` |
| `AGENT_ALLOW_SUBAGENTS` | `false` (default). Lets an agent delegate. If you turn it on, one subagent at a time is the limit; the CLI cannot enforce that |
| `AI_PROVIDER` | Only for the builtin engine: `anthropic`, `openai` or `mock` |
| `SANDBOX_DOCKER_ENABLED` | `false` runs tasks in host worktrees instead of containers |
| `MAX_QA_ITERATIONS` | How many fix cycles before a task is blocked |
| `GITHUB_TOKEN` | Needed to push. Without it the system stops at a local branch |
