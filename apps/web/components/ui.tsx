'use client';

import { useEffect, type ReactNode } from 'react';
import { explainState, explainVerdict, type Tone } from '../lib/labels';

/**
 * The design system, as the cockpit needs it.
 *
 * These are the primitives the Interval Pro brief defines — button, card, alert,
 * dialog, field, badge — rebuilt against the tokens in globals.css rather than
 * imported, because the cockpit is a standalone Next application with no
 * workspace dependencies and that is worth keeping.
 */

export function Button({
  children,
  onClick,
  variant = 'primary',
  size = 'md',
  disabled,
  type = 'button',
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
  disabled?: boolean;
  type?: 'button' | 'submit';
  title?: string;
}) {
  const classes = ['btn', variant === 'primary' ? '' : variant, size === 'sm' ? 'sm' : ''].filter(Boolean).join(' ');
  return (
    <button className={classes} onClick={onClick} disabled={disabled} type={type} title={title}>
      {children}
    </button>
  );
}

export function Card({
  children,
  tone,
  onClick,
  className,
}: {
  children: ReactNode;
  tone?: 'plain' | 'light' | 'olive';
  onClick?: () => void;
  className?: string;
}) {
  const classes = ['card', tone ?? '', onClick ? 'clickable' : '', className ?? ''].filter(Boolean).join(' ');
  if (onClick) {
    return (
      <div className={classes} onClick={onClick} role="button" tabIndex={0}>
        {children}
      </div>
    );
  }
  return <div className={classes}>{children}</div>;
}

export function Alert({
  tone = 'info',
  title,
  children,
}: {
  tone?: 'info' | 'caution' | 'critical' | 'success';
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className={`alert ${tone === 'info' ? '' : tone}`} role={tone === 'critical' ? 'alert' : 'status'}>
      <div className="col" style={{ flex: 1 }}>
        <span className="alert-title">{title}</span>
        {children ? <div className="alert-body">{children}</div> : null}
      </div>
    </div>
  );
}

export function Badge({ tone, children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`badge ${tone ?? ''}`}>{children}</span>;
}

/**
 * A badge that explains itself.
 *
 * The state names in this system are jargon, and the complaint that produced this
 * component was exactly that: the statuses are confusing. The explanation sits on
 * the badge rather than in documentation, and answers the two questions a person
 * actually has — what has happened, and what happens next.
 */
export function StateBadge({ state, large = false }: { state: string; large?: boolean }) {
  const explanation = explainState(state);
  return (
    <span className="explained" tabIndex={0}>
      <span className={`badge ${explanation.tone} ${large ? 'lg' : ''}`}>{explanation.label}</span>
      <span className="explanation">
        <span className="explanation-title">{explanation.means}</span>
        <span className="explanation-next">{explanation.next}</span>
      </span>
    </span>
  );
}

export function VerdictBadge({ verdict }: { verdict: string }) {
  const explanation = explainVerdict(verdict);
  return (
    <span className="explained" tabIndex={0}>
      <span className={`badge ${explanation.tone}`}>{explanation.label}</span>
      <span className="explanation">
        <span className="explanation-title">{explanation.means}</span>
        <span className="explanation-next">{explanation.next}</span>
      </span>
    </span>
  );
}

export function Tile({
  value,
  label,
  tone,
  onClick,
}: {
  value: ReactNode;
  label: string;
  tone?: 'attention' | 'positive' | 'caution';
  onClick?: () => void;
}) {
  return (
    <div className="tile" onClick={onClick} style={onClick ? { cursor: 'pointer' } : undefined}>
      <div className={`tile-value ${tone ?? ''}`}>{value}</div>
      <div className="tile-label">{label}</div>
    </div>
  );
}

export function Meta({ children }: { children: ReactNode }) {
  return <div className="meta">{children}</div>;
}

export function Bar({ percent, tone }: { percent: number; tone?: 'positive' | 'caution' | 'critical' }) {
  return (
    <div className="bar">
      <div className={`bar-fill ${tone ?? ''}`} style={{ width: `${Math.max(0, Math.min(100, percent))}%` }} />
    </div>
  );
}

export function KeyValue({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="kv">
      <span className="kv-key">{label}</span>
      <span className="kv-value">{children}</span>
    </div>
  );
}

export function Dialog({
  open,
  title,
  eyebrow,
  onClose,
  children,
  footer,
  wide = false,
}: {
  open: boolean;
  title: string;
  eyebrow?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    function escape(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    if (open) document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className={`dialog ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="row-between">
          <div className="col">
            {eyebrow ? <span className="meta">{eyebrow}</span> : null}
            <h2 className="subhead">{title}</h2>
          </div>
          <button className="dialog-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        {children}
        {footer ? <div className="row">{footer}</div> : null}
      </div>
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label?: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="field">
      {label ? <span className="meta">{label}</span> : null}
      {children}
      {hint ? <span className="body-sm">{hint}</span> : null}
    </label>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}

export function ErrorText({ children }: { children: ReactNode }) {
  return <p className="error">{children}</p>;
}

export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: { key: T; label: string; count?: number }[];
  active: T;
  onChange: (key: T) => void;
}) {
  return (
    <div className="tabs">
      {tabs.map((tab) => (
        <button
          key={tab.key}
          className={`tab ${tab.key === active ? 'active' : ''}`}
          onClick={() => onChange(tab.key)}
        >
          {tab.label}
          {tab.count ? <span className="tab-count">{tab.count}</span> : null}
        </button>
      ))}
    </div>
  );
}
