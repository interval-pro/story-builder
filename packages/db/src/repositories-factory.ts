import type { Queryable } from './client';
import {
  AgentRepository,
  ApprovalRepository,
  ArtifactRepository,
  CheckpointRepository,
  ConflictRepository,
  GitChangeRepository,
  ImpactRepository,
  InstallationApplyRepository,
  InvariantRepository,
  KnowledgeRepository,
  LockRepository,
  MetricRepository,
  PrincipleRepository,
  ProjectRepository,
  QaRunRepository,
  ReviewRepository,
  RuntimeManifestRepository,
  SandboxRepository,
  StoryRepository,
  TaskDependencyRepository,
  TaskRepository,
  TaskRunRepository,
  TestRunRepository,
  ToolCallRepository,
} from './repositories';

export interface Repositories {
  projects: ProjectRepository;
  stories: StoryRepository;
  tasks: TaskRepository;
  runs: TaskRunRepository;
  toolCalls: ToolCallRepository;
  checkpoints: CheckpointRepository;
  reviews: ReviewRepository;
  approvals: ApprovalRepository;
  agents: AgentRepository;
  artifacts: ArtifactRepository;
  sandboxes: SandboxRepository;
  testRuns: TestRunRepository;
  qaRuns: QaRunRepository;
  metrics: MetricRepository;
  principles: PrincipleRepository;
  invariants: InvariantRepository;
  knowledge: KnowledgeRepository;
  runtimeManifests: RuntimeManifestRepository;
  impact: ImpactRepository;
  conflicts: ConflictRepository;
  locks: LockRepository;
  dependencies: TaskDependencyRepository;
  gitChanges: GitChangeRepository;
  installationApplies: InstallationApplyRepository;
}

/**
 * Repositories are bound to a Queryable, so the same code works against the
 * pool or inside a transaction.
 */
export function createRepositories(db: Queryable): Repositories {
  return {
    projects: new ProjectRepository(db),
    stories: new StoryRepository(db),
    tasks: new TaskRepository(db),
    runs: new TaskRunRepository(db),
    toolCalls: new ToolCallRepository(db),
    checkpoints: new CheckpointRepository(db),
    reviews: new ReviewRepository(db),
    approvals: new ApprovalRepository(db),
    agents: new AgentRepository(db),
    artifacts: new ArtifactRepository(db),
    sandboxes: new SandboxRepository(db),
    testRuns: new TestRunRepository(db),
    qaRuns: new QaRunRepository(db),
    metrics: new MetricRepository(db),
    principles: new PrincipleRepository(db),
    invariants: new InvariantRepository(db),
    knowledge: new KnowledgeRepository(db),
    runtimeManifests: new RuntimeManifestRepository(db),
    impact: new ImpactRepository(db),
    conflicts: new ConflictRepository(db),
    locks: new LockRepository(db),
    dependencies: new TaskDependencyRepository(db),
    gitChanges: new GitChangeRepository(db),
    installationApplies: new InstallationApplyRepository(db),
  };
}
