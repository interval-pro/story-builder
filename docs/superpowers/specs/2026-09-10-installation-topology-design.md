# Installation topology: the layer lives outside the project it serves

Date: 2026-09-10
Status: stage 1 shipped in v0.1.1, stage 2 implemented

## Problem

`story-builder` is a layer that is installed onto a project and changes that
project through stories. Today the layer and the project are the same directory.
`PROJECT_ROOT` means both "the repository being worked on" and "where the engine
lives", agent prompts are read out of the worked-on repository, and task
worktrees and artifacts are written into it. That works only because the system
is currently running against its own source tree.

It also makes the two kinds of story incoherent. `SYSTEM_TASK` and
`PROJECT_TASK` mean different things depending on which repository the system
happens to be installed into, and neither is enforced: `task.kind` is read in
exactly one place, `packages/agents/src/context.ts:69`, where it is written into
the prompt as a sentence.

## Model

A project and the installation that serves it are two separate things with two
separate lifetimes.

- **The project** is any Git repository. It is identified by a local path. A
  remote is optional and only enables push and pull requests.
- **The installation** is a full snapshot of story-builder: engine code, web
  cockpit, agent prompts, policies, migrations and its own database. It is a Git
  clone of a story-builder release, living outside the project, by default under
  `~/.story-builder/<name>`.

The installation points at the project. The project carries a marker file so a
command run from inside the project can find its installation.

A story changes one of the two. A story against the project changes the project.
A story against the installation changes the engine that serves this project,
locally, without cutting an upstream release. Version divergence from the latest
upstream release is the expected, visible outcome of the second kind.

## Stage 1 scope

1. **Path split.** `INSTALL_ROOT` is where the engine lives. `PROJECT_ROOT` is
   the repository being worked on. Worktrees and artifacts live under
   `<INSTALL_ROOT>.state`, beside the installation rather than inside it: the
   installation directory is replaced wholesale when a new version is
   installed, while the database that indexes them survives, and keeping the
   two halves of that state on different lifetimes leaves rows pointing at
   files that are gone.
2. **Ownership of files.** Agent prompts, policies and installation defaults are
   read from the installation. The runtime manifest and project rules stay with
   the project, because they describe the project.
3. **Marker.** `init` writes `<project>/.ai-engineering/installation.json`
   recording the installation path, name and version. A lookup walks up from the
   working directory to find it.
4. **Bootstrap.** `install.sh` clones the latest release into
   `~/.story-builder/<name>`, installs and builds it, and runs its `init`
   against the project. No global package installs.
5. **Version state.** The installation reports which release tag and commit it
   runs, what the latest upstream release is, and which of three states it is
   in: up to date, behind, diverged. Local commits or a dirty tree mean
   diverged. Exposed on the CLI, the API and the cockpit.

## Stage 2

1. **The installation is a project.** `init` registers it alongside the
   repository being worked on, with `projects.kind` telling them apart. The kind
   carried by stories and tasks is dropped: a story targets a project, and the
   cockpit picks which one.
2. **An installation never pushes.** Its finished work waits on a local branch
   in the installation instead of becoming a pull request.
3. **Applying is a button, not an automatic step.** The engine must not swap
   itself out from under a running task, so a human decides when. The API only
   validates and hands the work to a detached process, because the API itself is
   stopped moments later. Progress is written to Postgres, which stays up, and
   the cockpit reads the outcome once the system answers again. Any failure
   restores the previous commit, rebuilds and restarts.
4. **The installation lives on a real branch.** Cloning a tag leaves a detached
   HEAD, which has nothing to merge into.

5. **Updating is the same path.** A newer release is applied exactly like a
   task, with a tag as the candidate instead of a branch, so an upgrade and a
   change of our own are applied, verified and rolled back identically. The
   merge is attempted as a fast forward first, so an untouched installation
   lands exactly on the release and reports itself as up to date, while one
   carrying its own commits merges and is honestly diverged.

## Deferred

- A remote URL as an alternative project input, with the engine owning the clone.

## Consequences

- The project repository no longer holds engine code, worktrees or artifacts.
  For a project like a car app, `.ai-engineering/` holds a runtime manifest,
  project rules and the marker, and nothing else.
- Two clones of story-builder exist on the machine when the system works on
  itself: the project at its own path and the installation under
  `~/.story-builder`. They are meant to drift apart.
- The database belongs to the installation and survives upgrades, with
  migrations closing any schema gap.
