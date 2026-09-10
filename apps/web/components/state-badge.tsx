import { STATE_LABELS, stateTone } from '../lib/api';

/** `prominent` is opt-in so only the task header enlarges the badge; the story
 *  list and the system table keep it at base size. */
export function StateBadge({ state, prominent = false }: { state: string; prominent?: boolean }) {
  const className = prominent ? `badge ${stateTone(state)} badge-lg` : `badge ${stateTone(state)}`;
  return <span className={className}>{STATE_LABELS[state] ?? state}</span>;
}

export function RiskBadge({ level }: { level: string | null }) {
  if (!level) return null;
  const tone = level === 'HIGH' ? 'attention' : level === 'MEDIUM' ? 'running' : 'waiting';
  return <span className={`badge ${tone}`}>{level} risk</span>;
}
