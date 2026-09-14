export const EVENT_TYPES = [
  'ProjectCreated',
  'StoryCreated',
  'StoryRevisionCreated',
  'TaskCreated',
  'TaskStateChanged',
  'AnalysisStarted',
  'ResearchCompleted',
  'ReviewGenerated',
  'HumanNoteAdded',
  'ReviewRegenerated',
  'ReviewApproved',
  'SupplementalReviewCreated',
  'ImplementationStarted',
  'ToolCalled',
  'FileModified',
  'TestStarted',
  'TestPassed',
  'TestFailed',
  'FixStarted',
  'QAStarted',
  'QARejected',
  'QAApproved',
  'FinalReviewGenerated',
  'PRCreated',
  'TaskCompleted',
  'TaskBlocked',
  'TaskPaused',
  'TaskStopped',
  'TaskFailed',
  'CheckpointCreated',
  'BaseMoved',
  'PrincipleLearned',
  'InvariantExtracted',
  'KnowledgeSnapshotCreated',
  'RuntimeManifestGenerated',
  'InstallationCandidateReady',
  'InstallationApplyStarted',
  /** A finished story was rebased and merged into the project's work branch. */
  'StoryMerged',
  /** The merge stopped on conflicts and the working tree is waiting for someone. */
  'MergeConflicted',
  /** The merge was undone, putting the work branch back where it was. */
  'MergeUndone',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export const ACTOR_TYPES = ['human', 'agent', 'orchestrator', 'worker', 'system'] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];
