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

`--restricted` removes the tools that run commands or code, so a read-only phase
has no write tool to attempt in the first place. In Docker mode the workspace is
also mounted read-only underneath, so the guarantee does not rest on a flag alone.

## Secrets

Raw secrets never enter a model prompt. Tool output is scrubbed before it is
returned to an agent or written to the event log. Production credentials are
denied by default and have no allow path.
