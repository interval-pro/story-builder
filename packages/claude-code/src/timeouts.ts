/**
 * Each agent runs in two passes: one that explores with tools, and one that
 * writes the answer with every tool switched off. Writing a long structured
 * document takes at least as long as the exploring did, so the second pass
 * gets the same budget as the first unless one is set for it explicitly.
 */
export function resultTimeoutFor(options: { timeoutMs: number; resultTimeoutMs?: number }): number {
  return options.resultTimeoutMs ?? options.timeoutMs;
}
