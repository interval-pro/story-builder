'use client';

import { useRef, useState } from 'react';
import { api, type ReviewDocument, type ReviewNote, type ReviewVersion, type SectionDiff } from '../lib/api';
import { clearDraft, readDraft } from '../lib/draft-field';
import { DraftTextarea } from './draft-textarea';

interface Props {
  taskId: string;
  reviewId: string;
  version: ReviewVersion;
  notes: ReviewNote[];
  diff: SectionDiff[];
  canAct: boolean;
  onChanged: () => void;
}

/**
 * The review is a document the human annotates rather than edits. Selecting a
 * fragment and adding a note is the only way corrections enter the system.
 */
export function ReviewView({ taskId, reviewId, version, notes, diff, canAct, onChanged }: Props) {
  const [selection, setSelection] = useState<{ text: string; sectionKey: string | null } | null>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  // Only gates the button. The note itself is read off the element on submit.
  const [noteLength, setNoteLength] = useState(0);
  // The note card unmounts on Cancel, so the element takes its text with it.
  // This keeps a half-written note for the next selection, as it does today.
  const retainedNote = useRef('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDiff, setShowDiff] = useState(false);

  const diffByKey = new Map(diff.map((entry) => [entry.key, entry]));

  function captureSelection(sectionKey: string | null) {
    const text = typeof window === 'undefined' ? '' : (window.getSelection()?.toString() ?? '');
    if (text.trim().length > 0) setSelection({ text: text.trim(), sectionKey });
  }

  async function addNote() {
    const text = readDraft(noteRef.current);
    if (!selection || text.trim().length === 0) return;
    setBusy(true);
    try {
      await api.post(`/api/tasks/${taskId}/review/notes`, {
        reviewId,
        reviewVersionId: version.id,
        sectionKey: selection.sectionKey,
        anchorText: selection.text,
        note: text,
      });
      // Clear the element and the retained copy together, otherwise the next
      // selection reopens the card holding the note that was just submitted.
      clearDraft(noteRef.current);
      retainedNote.current = '';
      setNoteLength(0);
      setSelection(null);
      onChanged();
    } catch (noteError) {
      setError(noteError instanceof Error ? noteError.message : String(noteError));
    } finally {
      setBusy(false);
    }
  }

  async function act(path: string) {
    setBusy(true);
    try {
      await api.post(`/api/tasks/${taskId}/${path}`, {});
      onChanged();
    } catch (actError) {
      setError(actError instanceof Error ? actError.message : String(actError));
    } finally {
      setBusy(false);
    }
  }

  const document_: ReviewDocument = version.document;
  const openNotes = notes.filter((note) => note.status === 'OPEN');

  return (
    <div>
      <div className="card">
        <div className="card-row">
          <div>
            <div className="card-label">Engineering review</div>
            <div className="card-value">v{version.version}</div>
            <div className="card-detail">{new Date(version.createdAt).toLocaleString()}</div>
          </div>
          <div className="row">
            {diff.length > 0 ? (
              <button className="secondary" onClick={() => setShowDiff(!showDiff)}>
                {showDiff ? 'Hide changes' : 'Show changes from the previous version'}
              </button>
            ) : null}
            {canAct ? (
              <>
                <button className="secondary" disabled={busy || openNotes.length === 0} onClick={() => void act('review/regenerate')}>
                  Regenerate with {openNotes.length} note{openNotes.length === 1 ? '' : 's'}
                </button>
                <button disabled={busy} onClick={() => void act('review/approve')}>
                  Approve review
                </button>
              </>
            ) : null}
          </div>
        </div>
        <p>{document_.summary}</p>
      </div>

      {error ? <p className="error">{error}</p> : null}

      {selection ? (
        <div className="card">
          <div className="card-label">Selected fragment</div>
          <div className="note">
            <div className="anchor">{selection.text.slice(0, 400)}</div>
          </div>
          <DraftTextarea
            textareaRef={noteRef}
            rows={3}
            placeholder="Do not create another service. Extend the existing NotificationService."
            onLengthChange={setNoteLength}
            retain={retainedNote}
          />
          <div className="actions">
            <button onClick={() => void addNote()} disabled={busy || noteLength === 0}>
              Add note
            </button>
            <button className="secondary" onClick={() => setSelection(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {document_.sections
        .filter((section) => section.body.trim().length > 0)
        .map((section) => {
          const sectionDiff = diffByKey.get(section.key);
          const changed = showDiff && sectionDiff && sectionDiff.status !== 'unchanged';
          return (
            <div key={section.key} className="card">
              <div className="card-row">
                <h3>{section.title}</h3>
                {sectionDiff && sectionDiff.status !== 'unchanged' ? (
                  <span className="badge running">{sectionDiff.status}</span>
                ) : null}
              </div>
              {changed && sectionDiff.before ? (
                <div>
                  <div className="card-label">Previous version</div>
                  <pre>{sectionDiff.before}</pre>
                </div>
              ) : null}
              <div
                className={`section-body selectable ${changed ? 'diff-changed' : ''}`}
                onMouseUp={() => captureSelection(section.key)}
              >
                {section.body}
              </div>
              {notes
                .filter((note) => note.sectionKey === section.key)
                .map((note) => (
                  <div key={note.id} className="note">
                    <div className="anchor">on: {note.anchorText.slice(0, 200)}</div>
                    <div>{note.note}</div>
                    <div className="card-detail">{note.status.toLowerCase()}</div>
                  </div>
                ))}
            </div>
          );
        })}

      {document_.implementationSteps.length > 0 ? (
        <div className="card">
          <h3>Implementation plan</h3>
          <ol>
            {document_.implementationSteps
              .slice()
              .sort((a, b) => a.order - b.order)
              .map((step) => (
                <li key={step.order}>
                  <strong>{step.title}</strong>
                  <div>{step.detail}</div>
                  {step.files.length > 0 ? <div className="card-detail">{step.files.join(', ')}</div> : null}
                </li>
              ))}
          </ol>
        </div>
      ) : null}

      {document_.riskSignals.length > 0 ? (
        <div className="card">
          <h3>Risk signals</h3>
          <div className="table-scroll">
            <table>
              <tbody>
                {document_.riskSignals.map((signal) => (
                  <tr key={signal.indicator + signal.evidence}>
                    <td className="col-lg">{signal.indicator}</td>
                    <td>{signal.evidence}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {notes.filter((note) => !note.sectionKey).length > 0 ? (
        <div className="card">
          <h3>Notes</h3>
          {notes
            .filter((note) => !note.sectionKey)
            .map((note) => (
              <div key={note.id} className="note">
                <div className="anchor">on: {note.anchorText.slice(0, 200)}</div>
                <div>{note.note}</div>
              </div>
            ))}
        </div>
      ) : null}
    </div>
  );
}
