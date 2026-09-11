'use client';

import { useRef, useState } from 'react';
import {
  api,
  type Decision,
  type ReviewNote,
  type ReviewVersion,
  type SectionDiff,
} from '../lib/api';
import { Alert, Badge, Button, Card, Empty, ErrorText, Field } from '../components/ui';
import { DraftTextarea } from './draft-textarea';
import { clearDraft, readDraft } from '../lib/draft-field';
import { formatStamp } from '../lib/format';

interface Props {
  taskId: string;
  reviewId: string;
  version: ReviewVersion;
  notes: ReviewNote[];
  diff: SectionDiff[];
  decisions: Decision[];
  canAct: boolean;
  onChanged: () => void;
}

/**
 * The plan, short first.
 *
 * The full document is twenty two sections and almost nobody read it before
 * approving, which means the approval was being given against something unread.
 * So the short version is the page, the full document is one click away, and the
 * decisions sit between them because they are what actually has to be answered.
 */
export function PlanView({ taskId, reviewId, version, notes, diff, decisions, canAct, onChanged }: Props) {
  const [full, setFull] = useState(false);
  const [selection, setSelection] = useState<{ text: string; sectionKey: string | null } | null>(null);
  const [writingOwn, setWritingOwn] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const ownRef = useRef<HTMLTextAreaElement>(null);
  // The note card unmounts on Cancel, so the element takes its text with it.
  // This keeps a half-written note for the next selection.
  const retainedNote = useRef('');

  const document_ = version.document;
  const brief = document_.brief;
  const openNotes = notes.filter((note) => note.status === 'OPEN');
  const openBlocking = decisions.filter((decision) => decision.blocking && decision.status === 'OPEN');
  const diffByKey = new Map(diff.map((entry) => [entry.key, entry]));

  function capture(sectionKey: string | null) {
    const text = typeof window === 'undefined' ? '' : (window.getSelection()?.toString() ?? '');
    if (text.trim().length > 0) setSelection({ text: text.trim(), sectionKey });
  }

  async function addNote() {
    if (!selection) return;
    const text = readDraft(noteRef.current).trim();
    if (!text) {
      setError('A note needs some text.');
      return;
    }
    setBusy(true);
    try {
      await api.post(`/api/tasks/${taskId}/review/notes`, {
        reviewId,
        reviewVersionId: version.id,
        sectionKey: selection.sectionKey,
        anchorText: selection.text,
        note: text,
      });
      // The element and the retained copy are cleared together, otherwise the
      // next selection reopens the card holding the note just submitted.
      clearDraft(noteRef.current);
      retainedNote.current = '';
      setSelection(null);
      setError(null);
      onChanged();
    } catch (postError) {
      setError(postError instanceof Error ? postError.message : String(postError));
    } finally {
      setBusy(false);
    }
  }

  async function answer(decision: Decision, chosenKey: string, customAnswer?: string) {
    setBusy(true);
    try {
      await api.post(`/api/tasks/${taskId}/decisions/${decision.key}`, { chosenKey, customAnswer });
      setWritingOwn(null);
      setError(null);
      onChanged();
    } catch (postError) {
      setError(postError instanceof Error ? postError.message : String(postError));
    } finally {
      setBusy(false);
    }
  }

  async function act(path: string) {
    setBusy(true);
    try {
      await api.post(`/api/tasks/${taskId}/${path}`);
      setError(null);
      onChanged();
    } catch (postError) {
      setError(postError instanceof Error ? postError.message : String(postError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      {error ? <ErrorText>{error}</ErrorText> : null}

      {openBlocking.length > 0 && canAct ? (
        <Alert tone="caution" title="Decisions first">
          {openBlocking.length === 1 ? 'One decision has' : `${openBlocking.length} decisions have`} to be answered
          before this plan can be approved. Implementing without an answer would mean guessing, which is exactly what
          these exist to prevent.
        </Alert>
      ) : null}

      <Card>
        <div className="row-between">
          <div className="col">
            <span className="meta">
              The plan · version {version.version} · {formatStamp(version.createdAt)}
            </span>
            <h2 className="heading" style={{ marginTop: 8 }}>
              {brief?.headline || document_.summary.split('.')[0] || 'No short version was written'}
            </h2>
          </div>
          <Button variant="ghost" onClick={() => setFull(!full)}>
            {full ? 'Hide the detail' : 'Read all of it'}
          </Button>
        </div>

        {brief ? (
          <>
            <div className="prose">{brief.approach}</div>

            <div className="split" style={{ marginTop: 8 }}>
              <div className="wide col">
                <span className="meta">What changes</span>
                {brief.changes.map((line) => (
                  <div key={line} className="body-sm" style={{ color: 'var(--ivory-100)' }}>
                    — {line}
                  </div>
                ))}
              </div>
              <div className="narrow col">
                <span className="meta">Worth knowing</span>
                {brief.watchOut.length === 0 ? (
                  <span className="body-sm">Nothing was flagged.</span>
                ) : (
                  brief.watchOut.map((line) => (
                    <div key={line} className="body-sm" style={{ color: 'var(--ochre-500)' }}>
                      — {line}
                    </div>
                  ))
                )}
                {brief.effort ? <span className="meta" style={{ marginTop: 8 }}>Size: {brief.effort}</span> : null}
              </div>
            </div>
          </>
        ) : (
          <div className="prose">{document_.summary}</div>
        )}

        {canAct ? (
          <div className="row" style={{ borderTop: '1px solid var(--line-hairline)', paddingTop: 18, marginTop: 8 }}>
            <Button onClick={() => void act('review/approve')} disabled={busy || openBlocking.length > 0}>
              Approve the plan
            </Button>
            <Button
              variant="secondary"
              onClick={() => void act('review/regenerate')}
              disabled={busy || openNotes.length === 0}
            >
              Rewrite with {openNotes.length} note{openNotes.length === 1 ? '' : 's'}
            </Button>
            <span className="meta">Nothing is written until you approve</span>
          </div>
        ) : null}
      </Card>

      {decisions.length > 0 ? (
        <section className="stack">
          <div className="row-between">
            <h3 className="subhead">Decisions</h3>
            <span className="meta">
              {decisions.filter((decision) => decision.status === 'ANSWERED').length} of {decisions.length} answered
            </span>
          </div>

          {decisions.map((decision) => {
            const chosen = decision.options.find((option) => option.key === decision.chosenKey);
            return (
              <Card key={decision.key}>
                <div className="row">
                  {decision.blocking ? <Badge tone="critical">Blocking</Badge> : <Badge>Optional</Badge>}
                  {decision.status === 'ANSWERED' ? <Badge tone="done">Answered</Badge> : null}
                </div>
                <div className="prose" style={{ fontSize: 18 }}>
                  {decision.question}
                </div>
                {decision.detail ? <span className="body-sm">{decision.detail}</span> : null}

                {decision.status === 'ANSWERED' ? (
                  <div className="note">
                    <span className="meta">Your answer</span>
                    <div className="body-sm" style={{ color: 'var(--ivory-100)' }}>
                      {decision.chosenKey === 'custom'
                        ? decision.customAnswer
                        : decision.chosenKey === 'agent'
                          ? 'Left to the engineer, with the reasons above.'
                          : `${chosen?.label ?? decision.chosenKey}${chosen?.detail ? ` — ${chosen.detail}` : ''}`}
                    </div>
                  </div>
                ) : (
                  <div className="choices">
                    {decision.options.map((option) => (
                      <button
                        key={option.key}
                        className="choice"
                        onClick={() => void answer(decision, option.key)}
                        disabled={busy || !canAct}
                      >
                        {option.recommended ? <span className="choice-recommended">Recommended</span> : null}
                        <span className="choice-label">{option.label}</span>
                        {option.detail ? <span className="choice-detail">{option.detail}</span> : null}
                        {option.consequence ? (
                          <span className="choice-consequence">Costs: {option.consequence}</span>
                        ) : null}
                      </button>
                    ))}

                    {writingOwn === decision.key ? (
                      <Card tone="plain">
                        <Field label="How it should be resolved">
                          <DraftTextarea
                            textareaRef={ownRef}
                            rows={4}
                            placeholder="Extend the existing mailer rather than adding a service."
                          />
                        </Field>
                        <div className="row">
                          <Button
                            size="sm"
                            onClick={() => void answer(decision, 'custom', readDraft(ownRef.current))}
                            disabled={busy}
                          >
                            Use this
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setWritingOwn(null)}>
                            Cancel
                          </Button>
                        </div>
                      </Card>
                    ) : (
                      <button className="choice" onClick={() => setWritingOwn(decision.key)} disabled={busy || !canAct}>
                        <span className="choice-label">I will say how</span>
                        <span className="choice-detail">Describe the resolution in your own words.</span>
                      </button>
                    )}

                    <button className="choice" onClick={() => void answer(decision, 'agent')} disabled={busy || !canAct}>
                      <span className="choice-label">Whatever you judge best</span>
                      <span className="choice-detail">
                        The engineer chooses, knowing the options above and their consequences.
                      </span>
                      <span className="choice-consequence">
                        Recorded as your decision to delegate, not as an unanswered question
                      </span>
                    </button>
                  </div>
                )}
              </Card>
            );
          })}
        </section>
      ) : null}

      {document_.implementationSteps.length > 0 ? (
        <Card>
          <span className="meta">How it will be done</span>
          <div className="steps">
            {document_.implementationSteps
              .slice()
              .sort((a, b) => a.order - b.order)
              .map((step) => (
                <div key={step.order} className="step done">
                  <span className="step-mark">{String(step.order).padStart(2, '0')}</span>
                  <div className="grow">
                    <div className="step-name">{step.title}</div>
                    <div className="body-sm">{step.detail}</div>
                    {step.files.length > 0 ? <div className="mono">{step.files.join(' · ')}</div> : null}
                  </div>
                </div>
              ))}
          </div>
        </Card>
      ) : null}

      {selection ? (
        <Card>
          <span className="meta">Selected fragment · your note</span>
          <div className="note-anchor">“{selection.text.slice(0, 400)}”</div>
          <Field>
            <DraftTextarea
              textareaRef={noteRef}
              rows={3}
              retain={retainedNote}
              placeholder="Do not create another service. Extend the existing mailer — this behaviour belongs to the same boundary."
            />
          </Field>
          <div className="row">
            <Button size="sm" onClick={() => void addNote()} disabled={busy}>
              Add the note
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSelection(null)}>
              Cancel
            </Button>
          </div>
        </Card>
      ) : null}

      {notes.length > 0 ? (
        <section className="stack">
          <h3 className="subhead">Your notes</h3>
          {notes.map((note) => (
            <div className="note" key={note.id}>
              <div className="note-anchor">“{note.anchorText.slice(0, 240)}”</div>
              <div className="body-sm" style={{ color: 'var(--ivory-100)' }}>
                {note.note}
              </div>
              <span className="meta">{note.status.toLowerCase()}</span>
            </div>
          ))}
        </section>
      ) : null}

      {full ? (
        <section className="stack">
          <div className="row-between">
            <h3 className="subhead">All of it</h3>
            <span className="meta">Select any fragment to leave a note on it</span>
          </div>
          {document_.sections.filter((section) => section.body.trim().length > 0).length === 0 ? (
            <Empty>The plan has no filled sections.</Empty>
          ) : (
            document_.sections
              .filter((section) => section.body.trim().length > 0)
              .map((section) => {
                const sectionDiff = diffByKey.get(section.key);
                const changed = sectionDiff && sectionDiff.status !== 'unchanged';
                return (
                  <Card key={section.key}>
                    <div className="row-between">
                      <span className="meta">{section.title}</span>
                      {changed ? <Badge tone="caution">{sectionDiff.status}</Badge> : null}
                    </div>
                    <div className="prose" onMouseUp={() => capture(section.key)} style={{ cursor: 'text' }}>
                      {section.body}
                    </div>
                    {notes
                      .filter((note) => note.sectionKey === section.key)
                      .map((note) => (
                        <div className="note" key={note.id}>
                          <div className="note-anchor">“{note.anchorText.slice(0, 200)}”</div>
                          <div className="body-sm" style={{ color: 'var(--ivory-100)' }}>
                            {note.note}
                          </div>
                        </div>
                      ))}
                  </Card>
                );
              })
          )}

          {document_.riskSignals.length > 0 ? (
            <Card>
              <span className="meta">Risk signals</span>
              <div className="table-scroll">
                <table>
                  <tbody>
                    {document_.riskSignals.map((signal) => (
                      <tr key={signal.indicator + signal.evidence}>
                        <td style={{ width: '30%' }}>{signal.indicator}</td>
                        <td>{signal.evidence}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
