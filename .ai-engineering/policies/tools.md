# Tool policy

No agent has direct system access. Every action goes through the tool layer,
which enforces the capability, the phase, input validation, a timeout, an output
limit and an audit record.

## Capabilities by phase

| Phase | May read | May write workspace | May run commands | May reach the network |
| --- | --- | --- | --- | --- |
| Research | yes | no | inspection only | yes, labelled by trust tier |
| Review | yes | no | inspection only | yes, labelled by trust tier |
| Implementation | yes | yes | yes | no |
| QA | yes | no | tests only | no |
| Final report | yes | no | no | no |
| Integration | yes | yes | yes | no |
| Push | yes | no | no | GitHub only, after approval |

## Refused everywhere

Docker access, cluster access, privilege escalation, changing Git remotes,
pushing without an approval, piping downloaded scripts into a shell, reading
credential files, and writing outside the task workspace.

## How the phases map onto Claude Code

When the agents run as headless Claude Code sessions, the capability model is
translated into the CLI's own permission flags.

| Phase | Flags |
| --- | --- |
| Research, Review | `--restricted`, editing tools denied |
| QA, Final report | `--restricted`, editing tools denied |
| Implementation, Integration | `--permission-mode acceptEdits`, push, remote, sudo, docker and kubectl denied |
| Push | `--restricted`, everything denied; the system pushes, not the agent |
| Review, work pass only | `--add-dir` for the task's artifact directory, so the findings are read rather than re-sent inline |
| Every phase, both passes | delegation and harness-discovery tools denied |

`--restricted` removes the tools that run commands or code, so a read-only phase
has no write tool to attempt in the first place. In Docker mode the workspace is
also mounted read-only underneath, so the guarantee does not rest on a flag alone.

Delegation and discovery are denied separately, because `--restricted` says
nothing about either and the two writing phases do not set it at all. No phase
may spawn a subagent: each of the five agents has a narrow job, its own prompt
and its own worktree, and a subagent would open a second context window to do
work the agent was already asked to do. No phase may search the harness for
tools either, since an agent that spends turns finding out what exists is not
doing the work it was given.

The delegation half is governed by one setting, `AGENT_ALLOW_SUBAGENTS`, which is
off. Harness discovery stays denied whatever that setting says. Both denials
apply to the work pass and to the pass that writes the structured answer, which
are built from the same module so a denial cannot reach one and miss the other.

## Secrets

Raw secrets never enter a model prompt. Tool output is scrubbed before it is
returned to an agent or written to the event log. Production credentials are
denied by default and have no allow path.
