# Installation topology: the layer lives outside the project it serves

Date: 2026-09-10
Status: approved, stage 1

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
   the repository being worked on. Worktrees and artifacts default to
   `<INSTALL_ROOT>/.ai-workspaces` and `<INSTALL_ROOT>/.artifacts`, so the
   project repository stays clean.
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

## Deferred to stage 2

- Registering the installation as a second project and removing `task.kind`
  entirely, so stories target a project rather than carry a kind.
- Building a candidate version side by side, running migrations and self tests,
  switching the pointer and restarting.
- Syncing with upstream as a normal Git merge, with conflicts surfaced as work.
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
