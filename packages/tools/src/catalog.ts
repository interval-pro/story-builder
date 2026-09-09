import { sha256 } from '@ai-engine/shared';
import type { ToolSpec } from './types';
import { fileStatsTool, listDirectoryTool, readFileTool, searchSymbolsTool, searchTextTool } from './tools/read-tools';
import { inspectDiffTool, inspectGitTool } from './tools/git-tools';
import { applyPatchTool, deleteFileTool, writeFileTool } from './tools/write-tools';
import { installDependencyTool, runBuildTool, runCommandTool, runSafeCommandTool, runTestsTool } from './tools/command-tools';
import { executeDatabaseDevTool, inspectDatabaseTool } from './tools/database-tools';
import { researchWebTool } from './tools/research-tools';
import { artifactReadTool, artifactWriteTool } from './tools/artifact-tools';

/** Every tool the system knows about. Agents only ever see a filtered subset. */
export const ALL_TOOLS: ToolSpec<any>[] = [
  readFileTool,
  listDirectoryTool,
  searchTextTool,
  searchSymbolsTool,
  fileStatsTool,
  inspectGitTool,
  inspectDiffTool,
  writeFileTool,
  applyPatchTool,
  deleteFileTool,
  runSafeCommandTool,
  runCommandTool,
  runTestsTool,
  runBuildTool,
  installDependencyTool,
  inspectDatabaseTool,
  executeDatabaseDevTool,
  researchWebTool,
  artifactReadTool,
  artifactWriteTool,
];

/**
 * Hash of the tool surface. Recorded with every agent run so a review can be
 * reproduced with the exact policy that produced it.
 */
export function toolPolicyVersion(): string {
  const fingerprint = ALL_TOOLS.map((tool) => `${tool.name}:${tool.capability}:${tool.phases.join('|')}`)
    .sort()
    .join('\n');
  return sha256(fingerprint).slice(0, 16);
}
