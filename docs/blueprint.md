# AI Engineering System — v0 Implementation Blueprint

> **Части от този документ вече не описват системата.** Той е планът на v0, в
> който един слой обслужва точно едно repository. Промяната в
> `docs/plan-cockpit-v2.md` смени това: една инсталация обслужва колкото проекта
> добавиш, опашката е обща за всички, преди пускането на стори има стъпка за
> изграждането му от идея, решенията по ревюто са редове които спират одобрението,
> и разходът се мери в токени, не в пари. Където този документ и README си
> противоречат, README е верният.

## 1. Цел

Системата представлява AI engineering layer, който се инсталира върху конкретен Git repository и работи единствено с този проект.

Основният lifecycle е:

```text
Developer Story
      ↓
Deep Repository Research
      ↓
Engineering Review
      ↓
Human Notes
      ↓
Regenerated Review
      ↓
Human Approval
      ↓
Implementation
      ↓
Automated Tests
      ↓
Independent QA Review
      ↓
Fix ↔ QA Loop
      ↓
Final Implementation Review
      ↓
Human Approval
      ↓
Rebase / Integration Validation
      ↓
Push
      ↓
GitHub PR
      ↓
Learning / Project Brain Update
```

Системата трябва да може да използва абсолютно същия lifecycle и върху собствената си имплементация.

Това означава, че `.ai-engineering/` е проект като всеки друг аспект на codebase-а и може да бъде променян чрез stories.

---

# 2. Основни архитектурни принципи

### 2.1 AI не е authority

LLM агентите могат да анализират и предлагат действия.

Те не управляват lifecycle-а.

```text
LLM       = reasoning
Tools     = capabilities
Orchestrator = authority
Sandbox   = execution
Postgres  = source of truth
Git       = source of truth за source code
```

### 2.2 Агентите са stateless

Никакво важно състояние не трябва да съществува единствено в LLM context.

След всяка значима стъпка резултатът се записва.

При crash нов worker трябва да може да продължи task-а без стария conversation context.

### 2.3 Human intent е gate

Преди approval:

```text
READ ONLY
```

След approval:

```text
WRITE разрешен само в task sandbox
```

При промяна на одобрения intent се изисква ново human decision/review.

### 2.4 Execution е resumable

Crash на:

- worker;
- Docker container;
- API;
- server;
- model provider;
- host restart;

не трябва да унищожава task-а.

### 2.5 Никаква работа върху live project working copy

Всеки task работи върху собствен Git snapshot/worktree.

### 2.6 Никакъв директен production access

Task sandbox получава само изрично разрешени development/test capabilities.

---

# 3. Начин на инсталиране

Всеки repository съдържа:

```text
project/
├── .ai-engineering/
│   ├── version
│   ├── bootstrap/
│   ├── versions/
│   ├── current
│   ├── config/
│   ├── agents/
│   ├── policies/
│   ├── runtime/
│   ├── migrations/
│   ├── project-rules/
│   └── runtime-manifest.yaml
│
├── src/
├── ...
└── .git/
```

Системата се vendor-ва в проекта.

Canonical source съществува в отделен GitHub repository.

Проектът използва конкретна версия.

Пример:

```text
.ai-engineering/version

0.4.2
```

---

# 4. CLI

Минималният CLI:

```text
ai-engine init
ai-engine start
ai-engine stop
ai-engine status
ai-engine update
ai-engine rollback
ai-engine export
ai-engine import
```

`init` трябва:

```text
detect repo
→ validate Git
→ install .ai-engineering
→ detect Docker
→ initialize configuration
→ start system stack
→ initialize Postgres
→ inspect project
→ generate runtime manifest
→ validate project runtime
→ create initial Project Knowledge
→ open/show Web UI
```

Docker е задължителен dependency за v0.

---

# 5. Технологичен стек

## Monorepo

TypeScript end-to-end.

Препоръчана структура:

```text
.ai-engineering/current/

apps/
  web/
  api/
  orchestrator/
  worker/
  sandbox-manager/
  cli/

packages/
  domain/
  db/
  events/
  queue/
  artifacts/
  ai-provider/
  agents/
  tools/
  git/
  github/
  project-brain/
  project-knowledge/
  conflict-engine/
  runtime-manifest/
  security/
  shared/
```

### Runtime

```text
Node.js
TypeScript
React
Next.js
PostgreSQL
pgvector
Docker
Docker Compose
Git
GitHub API
```

За DB abstraction бих използвал Drizzle или сходен лек SQL-first ORM.

За v0 не е необходим Redis.

---

# 6. Docker architecture

Основният AI stack:

```text
┌──────────────────┐
│      Web UI      │
└────────┬─────────┘
         │
┌────────▼─────────┐
│       API        │
└────────┬─────────┘
         │
┌────────▼─────────┐
│   Orchestrator   │
└────────┬─────────┘
         │
         ├─────────────┐
         ↓             ↓
┌────────────────┐ ┌─────────────────┐
│    Workers     │ │ Sandbox Manager │
└────────────────┘ └────────┬────────┘
                            │
                        Docker daemon
                            │
              ┌─────────────┼──────────────┐
              ↓             ↓              ↓
          Task A          Task B          Task C
          Sandbox         Sandbox         Sandbox

               ┌────────────────────┐
               │     PostgreSQL     │
               └────────────────────┘

               ┌────────────────────┐
               │ Artifact Storage   │
               │ persistent volume  │
               └────────────────────┘
```

Само Sandbox Manager има privileged Docker capabilities.

Workers нямат директен Docker socket access.

---

# 7. Task workspace model

При стартиране на task:

```text
Story Revision
+
Base Branch
+
Base Commit
+
Knowledge Snapshot
+
Agent Versions
=
Immutable Execution Starting Point
```

Пример:

```text
story_revision: 4
base_branch: main
base_commit: a94f81c
knowledge_snapshot: 32
research_agent_version: 7
review_agent_version: 4
```

Sandbox Manager създава:

```text
/ai-workspaces/task-123/
```

чрез Git worktree.

После:

```text
HOST
/ai-workspaces/task-123

          ↓ volume mount

CONTAINER
/workspace
```

Analysis container:

```text
/workspace → read-only
```

Implementation container:

```text
/workspace → read-write
```

Основният developer working directory никога не се mount-ва read-write.

---

# 8. Story model

Във v0 story е само свободен текст.

Пример:

```text
Когато user промени email-а си,
изпращай verification email и не приемай
новия email за verified преди verification-а.
```

Story има immutable revisions.

```text
Story
 ├── Revision 1
 ├── Revision 2
 └── Revision 3
```

След началото на analysis revision-ът се заключва.

Промяна на story:

```text
Revision N
→ new Revision N+1
→ targeted re-analysis
```

При фундаментална промяна:

```text
full re-analysis
```

---

# 9. Основна state machine

State machine-ът е deterministic code.

```text
DRAFT

ANALYSIS_QUEUED
ANALYZING

REVIEW_READY

REVIEW_FEEDBACK_RECEIVED
REVIEW_REGENERATING

REVIEW_APPROVED

HIGH_RISK_CONFIRMATION_REQUIRED

IMPLEMENTATION_QUEUED
IMPLEMENTING

QA_QUEUED
QA_RUNNING

FIX_REQUIRED
FIXING

BLOCKED

FINAL_REVIEW_READY

PR_APPROVAL_REQUIRED

INTEGRATION_VALIDATION

PUSHING

PR_CREATED

COMPLETED
```

Глобални interruption states:

```text
PAUSING
PAUSED

STOPPING
STOPPED

FAILED

ROLLING_BACK
ROLLED_BACK
```

Само Orchestrator има право да прави state transitions.

---

# 10. Durable queue

Postgres се използва и като durable job queue.

Не използваме Redis във v0.

Job примерно:

```text
id
task_id
job_type
payload
status
attempt
available_at
locked_by
locked_at
created_at
completed_at
```

Worker claiming може да използва:

```sql
FOR UPDATE SKIP LOCKED
```

Създаването на task transition + job може да бъде в една DB transaction.

Това решава много crash/resume проблеми.

---

# 11. Event log

Освен normal current-state tables се пази immutable append-only event log.

Пример:

```text
StoryCreated
StoryRevisionCreated
AnalysisStarted
FileInspected
ReviewGenerated
HumanNoteAdded
ReviewRegenerated
ReviewApproved
ImplementationStarted
ToolCalled
FileModified
TestStarted
TestFailed
FixStarted
QAStarted
QARejected
QAApproved
FinalReviewGenerated
PRApproved
PRCreated
TaskCompleted
```

Минимална структура:

```text
event_id
project_id
task_id
run_id
event_type
actor_type
actor_id
payload_json
created_at
sequence
```

Никога не update-ваме стар event.

---

# 12. Artifact storage

Postgres не трябва да съдържа огромни execution artifacts.

Postgres пази metadata.

Файловете се пазят в Artifact Storage.

За v0:

```text
Docker persistent volume
```

Абстракция:

```text
ArtifactStore

put()
get()
delete()
stream()
```

По-късно implementation може да стане:

```text
S3
MinIO
Azure Blob
etc.
```

Artifacts:

```text
test logs
build logs
large diffs
review snapshots
runtime logs
research artifacts
QA reports
screenshots
coverage reports
```

---

# 13. Multi-agent pipeline

Във v0 pipeline-ът е фиксиран.

Не правим AI orchestrator.

## Research Agent

Отговорност:

```text
understand story
understand repository
find relevant code
trace execution paths
inspect tests
inspect DB
inspect runtime configuration
inspect dependencies
research external sources if needed
build impact analysis
```

Няма write access.

## Engineering Review Agent

Получава:

```text
story
research artifacts
Project Brain
Project Knowledge
Invariants
Runtime Manifest
```

Генерира review.

## Implementation Agent

Получава само approved review.

Може:

```text
edit code
run terminal
install dependencies
run services
create migrations
modify tests
run build
run tests
debug
```

## QA Agent

Независим от Implementation Agent.

Прави:

```text
diff review
test verification
edge-case analysis
regression analysis
security review
invariant verification
architecture review
migration review
```

При проблем:

```text
QA → Implementation → QA
```

Максимум по подразбиране:

```text
5 iterations
```

След това:

```text
BLOCKED
```

---

# 14. Engineering Review

Review трябва да бъде дълбок engineering artifact.

Минимална структура:

```text
Story Understanding

Current System Behavior

Relevant Architecture

Execution / Data Flow

Affected Modules

Affected Files

Affected Symbols

Database Impact

API / Contract Impact

Configuration Impact

Dependencies

External Research Findings

Recommended Approach

Why This Approach

Downsides / Trade-offs

Risks

Edge Cases

Migration Considerations

Testing Strategy

Implementation Plan

Expected Changed Files / Symbols

Open Decisions / Blocking Questions
```

По подразбиране се дава **един recommended approach**.

Алтернативи се споменават само ако има реален architectural trade-off.

Задължително се показват недостатъците на препоръчания вариант.

Не използваме confidence percentages във v0.

---

# 15. Human review notes

Човекът не редактира AI review-то директно.

Той маркира конкретен fragment и добавя note.

Пример:

```text
AI:
Create a new NotificationService.

HUMAN NOTE:
Do not create another service.
Extend the existing NotificationService.
```

След това:

```text
Review v1
+
Human Notes
+
Repository Context
+
Project Brain

↓

Review v2
```

Review v2 показва diff спрямо v1.

Пазим review version history.

---

# 16. Learning от човешки corrections

Не пазим correction-а просто като текстово правило.

AI трябва да извлече **мисловния принцип зад correction-а**.

Пример:

Human:

```text
Don't create another service.
Use the existing NotificationService.
```

Неправилно learning:

```text
Always use NotificationService.
```

Правилно:

```text
Prefer extending an existing domain responsibility
instead of introducing another component when
the new behavior belongs to the same domain boundary.
```

Това влиза автоматично в Project Brain.

---

# 17. Project Brain

Project Brain има три основни слоя.

## Principles

Как екипът взима engineering решения.

Категории:

```text
architecture
code_style
testing
data_access
error_handling
security
performance
api_design
dependencies
deployment
domain_design
general
```

Principle:

```text
id
category
statement
scope
status
strength/confidence
evidence_count
created_at
updated_at
supersedes_id
```

## Project Knowledge

Как проектът реално е устроен.

Примерни entities:

```text
module
service
class
function
database_table
database_column
endpoint
event
queue
external_service
configuration
test_suite
```

## Invariants

Неща, които не трябва да бъдат нарушавани.

Пример:

```text
Payment execution is idempotent.

User email becomes verified only
after verification flow completes.
```

Invariants се извличат автоматично, но консервативно.

---

# 18. Knowledge graph

Във v0 graph-ът остава в Postgres.

Не използваме отделна graph DB.

Примерни edges:

```text
controller CALLS service

service USES repository

repository READS table

endpoint TRIGGERS service

service EMITS event

test COVERS symbol

module DEPENDS_ON module
```

Това се използва за impact analysis.

---

# 19. Knowledge snapshots

Knowledge не е просто globally mutable.

Всеки task използва snapshot.

```text
Knowledge Snapshot K42
valid for Git commit abc123
```

След merge:

```text
K43
valid for Git commit def456
```

Task, стартиран върху K42, не започва автоматично да използва K43.

При rebase:

```text
rebase
→ knowledge refresh
→ targeted re-analysis
→ conflict validation
→ continue
```

---

# 20. Project Runtime Manifest

Системата трябва да е language/framework agnostic.

Затова проектът има auto-generated Runtime Manifest.

Пример:

```yaml
project:
  language:
    - typescript

setup:
  commands:
    - npm ci

build:
  commands:
    - npm run build

test:
  commands:
    - npm test

lint:
  commands:
    - npm run lint

services:
  - name: postgres
    start: docker compose up -d postgres

database:
  migrate:
    - npm run migrate
  reset:
    - npm run db:reset
```

Manifest-ът се извлича от:

```text
package.json
Dockerfile
docker-compose
README
CI configuration
Makefile
csproj
pom.xml
pyproject.toml
Cargo.toml
etc.
```

После системата го валидира реално в sandbox.

---

# 21. Tool layer

Нито един agent няма директен system access.

Всичко става през tools.

Core tools:

```text
read_file
list_directory
search_text
search_symbols
inspect_git
inspect_diff

write_file
apply_patch

run_command
run_tests
run_build

inspect_database
execute_database_dev

research_web

artifact_read
artifact_write
```

Всеки tool има:

```text
permissions
phase restrictions
input validation
timeout
audit logging
output limits
```

---

# 22. Capability model

Agent не получава permissions глобално.

Получава capabilities според state-а.

Research:

```text
read repository
run safe inspection commands
run existing tests
web research
```

Implementation:

```text
write workspace
run build
modify dependencies
run migrations
start local services
```

GitHub push:

```text
НЕ се разрешава
докато човек не натисне Approve & Create PR
```

---

# 23. Secrets

Raw secrets не влизат в LLM prompt.

Secrets service/capability layer управлява:

```text
LLM provider credentials
GitHub credentials
private package registry credentials
development API credentials
```

Production credentials:

```text
DENIED BY DEFAULT
```

Tool results трябва да redaction-ват secrets.

---

# 24. Network policy

Research може да използва интернет.

Trust hierarchy:

```text
repository/runtime evidence
↓
official documentation
↓
official release notes
↓
GitHub issues/discussions
↓
Stack Overflow
↓
technical forums / Reddit / community
```

Community информация никога не се приема директно за истина.

Трябва да бъде валидирана спрямо:

```text
project dependency version
actual runtime
tests
official documentation when possible
```

Project secrets не трябва да бъдат изпращани към web research.

---

# 25. Task sandbox

Всеки task има собствен:

```text
Git worktree
Docker sandbox
filesystem
container network
test DB
logs
runtime state
```

Tasks могат да вървят паралелно.

Package caches и Docker layers могат физически да бъдат shared за performance, но logical execution environment остава изолиран.

---

# 26. Sandbox Manager

Отделен runtime process.

Отговорности:

```text
create sandbox
destroy sandbox
pause sandbox
resume sandbox
inspect health
mount workspace
configure network
create development DB
run containers
restore checkpoint
```

Sandbox Manager е единственият service с Docker privileges.

---

# 27. Checkpoints

След всяка значима стъпка се създава checkpoint.

Checkpoint съдържа:

```text
task state
git HEAD
git diff reference
workspace metadata
DB migration state
running services
agent version
knowledge snapshot
execution plan position
```

При restart:

```text
load task
→ load checkpoint
→ inspect actual sandbox
→ reconcile desired vs actual state
→ resume
```

---

# 28. Pause / Stop / Resume

### Pause

```text
finish current atomic operation
save checkpoint
stop execution
```

### Resume

```text
validate state
restore services if needed
load context
continue
```

### Stop

```text
terminate execution
optionally rollback
mark task stopped
```

Developer няма direct shell/IDE access до task sandbox.

---

# 29. Risk model

Прост:

```text
LOW
MEDIUM
HIGH
```

High-risk indicators:

```text
database migrations
destructive operations
auth
security
core shared modules
public API changes
large blast radius
deployment changes
data transformations
weak/no tests
```

High risk:

```text
Review Approval
+
Second explicit Execution Approval
```

---

# 30. Migration safety

DB migrations се третират специално.

Преди destructive migration:

```text
snapshot
→ run migration against test/copy
→ verify schema
→ verify data
→ run tests
→ human approval if data can be lost
→ execute
```

След migration:

```text
schema validation
data validation
application tests
migration sequence validation
```

---

# 31. Conflict Coordination

Паралелните tasks трябва да се следят постоянно.

Всеки task има Impact Manifest.

Пример:

```text
files
symbols
modules
database tables
database columns
migrations
APIs
events
contracts
domains
invariants
```

---

# 32. Project Coordinator

Поддържа active task graph.

```text
Task A
Task B
Task C
```

и relationships:

```text
conflicts_with
depends_on
blocks
shares_resource
```

Impact Manifest се обновява по време на implementation.

Всяко ново откритие trigger-ва conflict reevaluation.

---

# 33. Видове конфликт

### Git conflict

Двата task-а променят конфликтни code regions.

### Symbol conflict

Двата task-а променят една функция/class/interface.

### Migration conflict

Migration ordering/versioning conflict.

### Schema conflict

Двата task-а променят несъвместимо DB schema.

### Contract conflict

API/event/interface incompatibility.

### Semantic conflict

Промени в различен код, които логически си противоречат.

### Invariant conflict

Task нарушава системно правило, от което друг task зависи.

---

# 34. Locks

Hard locks:

```text
database schema critical region
migration chain
public contracts
other critical resources
```

Soft coordination:

```text
ordinary code
modules
symbols
```

Ако Task B зависи от Task A:

```text
Task B → WAITING_FOR_TASK
```

След merge на A:

```text
update base
→ targeted re-analysis
→ QA
→ continue B
```

Не можем математически да гарантираме, че AI ще открие абсолютно всеки semantic conflict предварително.

Можем да гарантираме:

```text
continuous reevaluation
+
automatic pause on detected conflict
+
mandatory clean integration validation before PR
```

---

# 35. Base Drift Monitor

Всеки task знае:

```text
base_branch
base_commit
```

Системата периодично fetch-ва remote.

Ако main се промени:

```text
BASE_MOVED
```

Не rebase-ваме task-а постоянно.

Преди finalization:

```text
fetch latest
→ conflict analysis
→ rebase/update
→ Project Knowledge refresh
→ migration validation
→ full QA
→ final report
```

---

# 36. QA loop

Implementation Agent завършва.

QA Agent получава fresh context и diff.

```text
Implementation
↓
QA
↓
Problem?
├── No → Final Review
└── Yes → Fix
             ↓
            QA
```

Максимум:

```text
5 automatic loops
```

Ако fix изисква architectural scope change:

```text
BLOCKED
→ supplemental engineering review
→ human decision
```

---

# 37. Supplemental reviews

По време на implementation AI може да открие непредвиден проблем.

Пример:

```text
Approved plan:
Service change only.

Discovered:
DB migration is required.
```

Agent няма право тихо да разширява approved intent.

Създава:

```text
Supplemental Review
```

към същия task.

След human decision:

```text
update approved plan
→ resume
```

---

# 38. Final Implementation Review

Преди PR developer вижда:

```text
Summary

Approved Plan

Actual Implementation

Planned vs Actual

Changed Files

Changed Symbols

Additional Changes

Reason for Deviations

Tests Added

Tests Modified

Tests Removed

Why Existing Tests Changed

Build Result

Test Result

QA Findings

Resolved QA Findings

Migration Result

Remaining Risks

Git Diff

Suggested Commits
```

---

# 39. Git model

Task:

```text
ai/story-123-user-email-verification
```

Implementation остава local.

До final approval:

```text
NO PUSH
```

След:

```text
Approve & Create PR
```

системата:

```text
fetch latest
rebase
validate conflicts
run migrations validation
run full QA
create clean commits
push
create GitHub PR
```

---

# 40. GitHub integration

Само GitHub във v0.

Абстракцията все пак да бъде малка:

```text
GitRemoteProvider
```

Но реално implementation:

```text
GitHubProvider
```

Поддържа:

```text
push branch
create PR
read base branch
fetch repository metadata
```

---

# 41. Project/system task distinction

Два вида task:

```text
PROJECT_TASK
SYSTEM_TASK
```

PROJECT_TASK:

```text
не променя .ai-engineering/
```

SYSTEM_TASK:

```text
може да променя цялата AI система
```

Но дори това правило може по-късно да бъде развивано чрез system stories.

---

# 42. Self-modification

Всичко може да бъде променяно чрез stories:

```text
frontend
backend
orchestrator
workers
agents
prompts
tool definitions
policies
DB
migrations
Project Brain logic
Sandbox Manager
bootstrap
updater
recovery system
```

Но активната работеща версия никога не се overwrite-ва директно.

---

# 43. Version model

```text
.ai-engineering/

versions/
  0.8.0/
  0.9.0/
  0.10.0/

current
```

Candidate version се инсталира side-by-side.

---

# 44. Self-upgrade lifecycle

```text
Current Known Good
       ↓
Download / Build Candidate
       ↓
Create State Snapshot
       ↓
Clone State
       ↓
Run Candidate Migrations
       ↓
Start Candidate
       ↓
Self Tests
       ↓
Recovery Tests
       ↓
Health Checks
       ↓
Switch Current
       ↓
Post-switch Verification
```

Fail:

```text
Candidate Failed
      ↓
Restore previous runtime
      ↓
Restore compatible DB/state snapshot
      ↓
Mark candidate FAILED
```

---

# 45. Known-good versions

Пазим минимум:

```text
3 known-good versions
```

Всеки known-good version има:

```text
runtime version
system DB snapshot
schema version
Project Brain snapshot
Project Knowledge snapshot
configuration
migration metadata
artifact metadata
```

---

# 46. Bootstrap update

Дори bootstrap може да се променя.

Но new bootstrap никога не заменя единственото работещо копие.

Старият known-good updater валидира candidate bootstrap, преди switch.

По този начин всичко остава self-modifiable, без да губим recovery path.

---

# 47. Agent versioning

Всеки execution записва:

```text
agent type
agent version
prompt version/hash
model provider
model
model config
tool policy version
Project Brain snapshot
Project Knowledge snapshot
```

Така review може да бъде възпроизведен и сравняван.

---

# 48. Model provider abstraction

Тънък interface:

```text
generate()
stream()
structuredOutput()
toolCall()
```

Provider adapter например:

```text
OpenAIProvider
AnthropicProvider
...
```

Agent configuration определя provider/model.

Core логиката не зависи от конкретен provider.

---

# 49. Agent definitions

Version-controlled:

```text
.ai-engineering/agents/

research.md
review.md
implementation.md
qa.md
learning.md
```

System story може да ги променя.

Пример:

```text
QA agent currently misses race conditions.
Improve QA agent instructions so concurrency and
shared mutable state are always reviewed.
```

---

# 50. Agent evaluation data

Още във v0 събираме:

```text
human correction count
review regeneration count
QA rejection count
fix iteration count
planned-vs-actual files
blocking review count
test failure count
task completion time
agent/tool failures
```

Не е необходимо analytics UI във v0.

Data трябва просто да съществува.

---

# 51. Historical evals

По-късно нов agent/prompt може да бъде оценяван върху исторически stories.

```text
Old QA Agent
vs
New QA Agent
```

върху запазени diffs и known outcomes.

Това ще стане основа на измеримо self-improvement.

---

# 52. Frontend v0

Не правим Jira clone.

Web UI е AI Engineering Cockpit.

Основни screens:

```text
Stories

Story Detail

Engineering Review

Implementation Execution

Final Review

Project Brain

Project Knowledge

System Status
```

---

# 53. Story screen

Минимум:

```text
New Story textarea
Create
```

Story Detail:

```text
status
revision
base commit
risk
current stage
agent activity
blocking decision
review
implementation
QA
final report
PR
```

---

# 54. Engineering Review UX

Review се показва като rich document.

Developer може:

```text
select text
→ Add Note
```

Notes се показват anchored към selected fragment.

Actions:

```text
Regenerate Review
Approve Review
```

---

# 55. Execution UI

Показва:

```text
Current State

Current Agent

Current Step

Task Sandbox Health

Latest Tool Activity

Tests

QA Iteration

Conflict State

Base Drift

Pause

Stop

Resume
```

Machine audit може да бъде secondary/debug view.

---

# 56. Project Brain UI

Single-user във v0.

Показва:

```text
Principles
Knowledge
Invariants
```

Позволява inspection/editing.

По-късно roles ще ограничат това само за admin/lead.

---

# 57. Data model

Минималните DB entities трябва да включват:

```text
projects

stories
story_revisions

tasks
task_runs
task_checkpoints

reviews
review_versions
review_notes

decisions
approvals

agents
agent_versions
agent_runs

tool_calls

events

jobs

artifacts

project_brain_principles
principle_evidence

knowledge_snapshots
knowledge_entities
knowledge_edges

invariants
invariant_evidence

impact_manifests
impact_resources

task_dependencies
task_conflicts
resource_locks

sandboxes

test_runs
qa_runs

git_refs
git_changes

system_versions
system_state_snapshots
system_migrations

runtime_manifests

metrics
```

---

# 58. API boundaries

Примерни API групи:

```text
/api/stories
/api/tasks
/api/reviews
/api/approvals
/api/executions
/api/project-brain
/api/project-knowledge
/api/conflicts
/api/system
/api/versions
/api/artifacts
```

Web UI никога не управлява workers директно.

Всичко минава през API → DB → Orchestrator.

---

# 59. Какво трябва да изградим РЪЧНО

Това е най-важната част.

Не трябва ръчно да изградим цялата крайна система.

Трябва ръчно да изградим **минималния self-development kernel**.

## Bootstrap Milestone M0

Той трябва да може да направи само:

```text
Create Story

↓

Research repository

↓

Generate Engineering Review

↓

Add Human Note

↓

Regenerate Review

↓

Approve

↓

Create isolated task worktree/sandbox

↓

Implementation Agent edits code

↓

Run project tests

↓

QA Agent reviews

↓

Fix loop

↓

Final Implementation Report

↓

Human Approval

↓

Produce Git diff/commit
```

Не е необходимо първата ръчна версия веднага да има:

```text
advanced conflict engine
perfect Project Brain
historical evals
full self-updater
complex metrics UI
multi-user
roles
GitLab
Kubernetes
parallel subtasks
advanced semantic graph
```

Тези неща могат да бъдат първите stories.

---

# 60. Минималният ръчен build order

## M0.1 Repository skeleton

Създаваме monorepo, shared packages и Docker Compose.

Acceptance:

```text
docker compose up
```

стартира Web/API/Postgres/Worker/Orchestrator/Sandbox Manager.

## M0.2 Database + event log + queue

Създаваме core schema.

Acceptance:

task може да бъде записан, queued, claimed и resumed след process restart.

## M0.3 Story UI

Textarea + create story + story detail.

Acceptance:

story се записва като immutable revision.

## M0.4 Provider abstraction

Първи AI provider adapter.

Acceptance:

Research Agent може да получи structured output.

## M0.5 Read-only research tools

```text
read_file
list_directory
search
git inspection
safe command
```

Acceptance:

agent може да анализира repo без write access.

## M0.6 Research Agent

Генерира structured repository findings.

## M0.7 Engineering Review Agent

Превръща findings в review artifact.

## M0.8 Human notes + regeneration

Selection + anchored note + Review v2.

## M0.9 Approval gate

Approve отключва implementation.

## M0.10 Sandbox Manager

Създава Git worktree + Docker sandbox.

## M0.11 Implementation tools

```text
write
patch
command
build
tests
```

## M0.12 Implementation Agent

Изпълнява approved plan.

## M0.13 QA Agent

Review + tests + maximum five fix cycles.

## M0.14 Final Report

Planned vs Actual.

## M0.15 Human PR gate

Първоначално дори може да завършва с локален Git commit.

Следващото story може да добави GitHub PR.

---

# 61. Definition of Bootstrap Success

Bootstrap Core е готов само ако можем реално да подадем story на **самата AI система** и тя да модифицира собствения си source code.

Например:

```text
Add persistent Project Brain principles.
Extract reusable engineering principles
from human review notes and store them in PostgreSQL.
```

Системата трябва сама да:

```text
анализира собствения си код
→ направи review
→ приеме notes
→ implement
→ test
→ QA
→ report
```

Това е моментът, в който започва истинското self-development.

---

# 62. Първи self-development backlog

След Bootstrap Core не бихме писали останалото ръчно.

Бих подавал stories приблизително в този ред.

### SYS-001 — Persistent Project Brain

Добавяне на structured Principles storage и retrieval.

### SYS-002 — Automatic Learning from Human Notes

Извличане на generalized engineering principles от corrections.

### SYS-003 — Project Knowledge

Извличане на modules, symbols, DB entities и architecture.

### SYS-004 — Knowledge Graph

Добавяне на relations между Project Knowledge entities.

### SYS-005 — Conservative Invariant Extraction

Извличане и validation на system invariants.

### SYS-006 — Knowledge Snapshot Versioning

Bind Project Knowledge към Git commit.

### SYS-007 — Project Runtime Manifest

Автоматично detect-ване и validation на build/test/runtime commands.

### SYS-008 — GitHub Integration

Push + PR creation след human gate.

### SYS-009 — Base Drift Detection

Следене дали main се е променил спрямо task base.

### SYS-010 — Integration Validation

Rebase + full QA преди PR.

### SYS-011 — Impact Manifest

Structured impact tracking за всеки task.

### SYS-012 — Active Task Coordinator

Следене на паралелни tasks.

### SYS-013 — Hard Resource Locks

DB/schema/migrations/public contracts.

### SYS-014 — Semantic Conflict Detection

Cross-task semantic analysis.

### SYS-015 — Task Dependencies

WAITING_FOR_TASK и automatic re-analysis след dependency merge.

### SYS-016 — Risk Classification

LOW/MEDIUM/HIGH.

### SYS-017 — High Risk Second Gate

Допълнително execution approval.

### SYS-018 — Strong Migration Validation

DB snapshots, test migrations и destructive-change gate.

### SYS-019 — Pause/Resume Improvements

Пълно execution state reconciliation.

### SYS-020 — Artifact Storage Abstraction

Large logs/reports извън Postgres.

### SYS-021 — Agent Version Tracking

Prompt/model/tools hashes във всеки run.

### SYS-022 — Agent Metrics

Quality metrics.

### SYS-023 — Historical Agent Evaluation

Replay/evaluation върху стари stories.

### SYS-024 — Self-Versioning

Versioned `.ai-engineering/versions`.

### SYS-025 — State Snapshots

System DB + Brain + config snapshot.

### SYS-026 — Side-by-side Upgrade

Candidate install without replacing current.

### SYS-027 — Automatic Rollback

Rollback при failed health/self tests.

### SYS-028 — Three Known-Good Versions

Retention и compatibility metadata.

### SYS-029 — Bootstrap Self-Upgrade

Safe upgrade на launcher/updater.

### SYS-030 — Export / Import

Portable AI project state.

---

# 63. Как бих започнал реално

Не бих започнал с Project Brain.

Не бих започнал с conflict detection.

Не бих започнал със self-update.

Първо трябва да докажем едно:

> Може ли системата надеждно да получи story, да разбере codebase-а, да предложи разумна промяна, да приеме human correction и след approval да направи работещ implementation?

Ако това не работи, всички останали компоненти са без значение.

Следователно първият development milestone е:

```text
STORY
→ RESEARCH
→ REVIEW
→ HUMAN NOTE
→ REVIEW V2
→ APPROVE
→ IMPLEMENT
→ TEST
→ QA
→ FINAL REPORT
```

Когато това заработи върху **собствения repository на AI системата**, спираме да разработваме feature-ите ръчно и започваме да използваме SYS stories.

---

# 64. Крайната философия

Системата не трябва да бъде агент, на който казваме:

```text
“Напиши ми feature.”
```

Тя трябва да бъде **engineering process**, в който AI участва като множество инженери.

Тя трябва да знае:

```text
как изглежда проектът;
как екипът мисли;
какви решения са били вземани;
кои invariants не трябва да се нарушават;
какво точно е одобрил човекът;
какво AI реално е променил;
как е валидирал промяната;
какво е научил от човешките corrections.
```

А self-development моделът трябва да бъде:

```text
working system N

        ↓ story

candidate system N+1

        ↓ deep review

human approval

        ↓ implementation

self tests + QA

        ↓ isolated validation

candidate healthy?

YES → activate
NO  → keep N and generate failure story
```

Така системата не е просто AI, който пише код.

Тя постепенно се превръща в **versioned, auditable, project-specific autonomous engineering organization**, в която човекът определя intent-а и крайните решения, а AI извършва research, design, implementation, validation и постепенно научава начина, по който този конкретен проект трябва да бъде развиван.