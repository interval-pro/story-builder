import { STATE_LABELS, stateTone } from '../lib/api';

export function StateBadge({ state }: { state: string }) {
  return <span className={`badge ${stateTone(state)}`}>{STATE_LABELS[state] ?? state}</span>;
}

export function RiskBadge({ level }: { level: string | null }) {
  if (!level) return null;
  const tone = level === 'HIGH' ? 'attention' : level === 'MEDIUM' ? 'running' : 'waiting';
  return <span className={`badge ${tone}`}>{level} risk</span>;
}
