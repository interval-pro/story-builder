# The layer becomes local: one checkout, no worktrees, nothing written into your projects

The shape this change moves to, decided in conversation:

- **Nothing is ever written into a project you add.** Not a marker, not a manifest,
  not a rules directory. The path is recorded and the directory is used. Nothing
  is read out of it either beyond the code itself.
- **Everything a project accumulates lives in the database.** Artifacts included:
  findings, transcripts, reports, diffs, test logs. The filesystem stops being
  half of the truth.
- **There are no worktrees.** A story works in the project directory itself, on a
  branch of its own, and one story at a time per project. This is what removes
  the disk cost entirely: worktrees were not large because of data, they were
  large because each one installed its own dependencies. Measured on this
  repository: 6.7 MB of source, 351 MB of `node_modules`, and four worktrees came
  to 1.4 GB.
- **The layer is a project like any other**, with two abilities the others do not
  have: it can rebuild itself and restart onto the result. It keeps a remote, so
  it can also push and open a pull request like anything else.
- **State that must be a file lives in one place**, `~/.story-builder`, and the
  checkout you edit holds nothing but code.

## What is on disk afterwards

```
~/works/story-builder/       the layer: code only, nothing machine-specific
~/.story-builder/
├── env                      how to reach the database, which ports
├── build.json               the commit the running build was made from
├── run/                     pid and log per service
├── snapshots/               a database dump taken before each migration
└── tmp/                     a file materialised from the database for one agent run
```

A second installation, if one is ever wanted, gets `~/.story-builder-<name>`
beside it. One level always.

## The branch lifecycle

A story owns the project directory for as long as it runs.

1. The first run checks the tree is clean, records the branch the person was on,
   and creates the story branch from the project's chosen work branch.
2. Every run commits what it produced onto that branch. This already happens.
3. Before each run the system checks it is still on that branch. If someone
   switched it from an editor, the run stops and says so rather than writing onto
   whatever is checked out now.
4. When the story finishes, stops or is paused, the work is committed and the
   directory returns to the work branch. Nothing is left half-changed and nothing
   is lost: the branch is still there.

**Serial per project.** A second story for the same project waits. The queue is
still global and still runs several projects at once; it simply never runs two
things in one directory. A chat turn against a busy project still answers, but
read-only, and says why.

## Merging

When a story is done it offers, in this order:

1. **Rebase onto the current work branch.** If that is clean there is no conflict
   and no conversation.
2. **Merge into the work branch**, recording the commit it was on first, so the
   merge can be undone with one action rather than a search through the reflog.
3. **Push and open a pull request**, when the project has a remote and the token
   grants write. That is checked when the project is added, not at the end.

A conflict offers three routes: let the engineer try, resolve it yourself in your
editor and press done, or start the story again from the current base. The
default is the middle one, because a conflict is exactly where a silent automatic
resolution is worst: both sides usually compile.

## Rebuilding the layer

Two independent facts, two indicators:

- `HEAD` differs from the commit in `build.json`: there are local changes that are
  not running yet.
- The newest release differs from `HEAD`: there is a newer version upstream.

The rebuild runs in this order, which is chosen so that the common failure costs
nothing:

1. Build the new commit while the old one is still running. A failed build stops
   nothing, because the running processes hold the old code in memory.
2. Only on success: snapshot the database, stop the services, migrate, run the
   tests, start again.
3. On any failure after the build: return to the commit in `build.json`, which is
   known good because it is what was running, rebuild it and start. Restore the
   snapshot if the migration had already run.

No ladder of older commits. There is exactly one known-good target and it is
already built.

## Settings, global and per project

Two scopes, separated in the interface. Global: how much runs at once, the queue
pause, the weekly token budget, the default model, the default chat mode. Per
project: its work branch, its GitHub token when the repository lives under a
different account, its model, its fix-cycle limit. A project value overrides the
global one; the global one overrides the environment; the environment overrides
the default, and the screen says which of the four a value came from.

## What this removes

- `WorktreeManager` from the task path, and the sandbox client with it. The
  Docker sandbox mounted a worktree; with no worktree there is nothing to mount.
  The sandbox manager stays in the tree, unused and unstarted, rather than being
  deleted in the same change as everything else.
- The installation marker, the runtime manifest file and the rules directory from
  every project.
- The artifacts directory.
- The `--repo` requirement from the installer, which has already gone.

## Order of work

1. Migration `0006`, domain types, and the settings scope.
2. Artifacts into the database, with a temporary file materialised only where an
   agent has to be pointed at one.
3. The branch lifecycle and per-project serialisation, replacing worktrees.
4. The state directory, `build.json`, and the rebuild flow.
5. Merging, with its three conflict routes.
6. The interface for all of it.
7. Tests, then a story run end to end against a scratch project.

## As built

Three things were decided while building rather than before it.

**The merge is a job, not an endpoint.** Merging needs the project's working
directory to itself, and the queue is what hands that out. An endpoint doing the
git work directly would be racing whatever story starts next. So the merge
button, the three routes out of a conflict and the undo are all one job type
with an action in its payload.

**A conflict holds the directory.** Resolving it in your own editor is the
default route, and that only works if the conflict is left in the tree. So the
project records which story's merge is unfinished, and the queue refuses to start
anything else there until it is settled — the same rule as a running story, for
the same reason.

**Stopping the services hands their jobs back.** The lease exists so that a
worker which dies unnoticed cannot have its job taken while it is still running.
That is right for a crash and wrong for a deliberate stop, where we know the
processes are gone. Without saying so, a restart left the last job of each worker
marked as running, and since a running job holds its project's directory, the
project stayed locked for the length of the lease: a system that looks up and
refuses to start anything. `dev-down.sh` now says so explicitly.

One defect was found only by running it: `git branch` creates a ref and leaves
you where you were, so the first run of a story created its branch and then wrote
on the branch the person was sitting on. It is now one operation, `switchToBranch`,
with a test naming the failure.
