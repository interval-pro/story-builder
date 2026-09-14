'use client';

import { useMemo } from 'react';
import type { ChatMessage } from '../lib/api';
import { relativeAge } from '../lib/format';
import { parseMarkdown } from '../lib/markdown';
import { MarkdownView } from './markdown-view';
import { Badge, ErrorText } from './ui';

/**
 * One message in the chat window, as a bubble.
 *
 * What the person sent sits on the right and the engine's replies on the left, so
 * who said what is read from where it is; the name is still there for a screen
 * reader. A reply is formatted, a person's own message is shown exactly as typed.
 *
 * Not memoised: the page re-renders on every poll, and that is what keeps "2
 * minutes ago" current. Only the parse is kept, per content string.
 */
export function ChatMessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user';
  const blocks = useMemo(() => (isUser ? [] : parseMarkdown(message.content)), [isUser, message.content]);
  const inProgress = message.status === 'PENDING' || message.status === 'STREAMING';

  let body = null;
  if (isUser) {
    body = message.content ? <div className="bubble-text">{message.content}</div> : null;
  } else if (message.content) {
    body = <MarkdownView blocks={blocks} />;
  } else if (inProgress) {
    body = (
      <span className="typing" aria-hidden="true">
        <span className="typing-dot" />
        <span className="typing-dot" />
        <span className="typing-dot" />
      </span>
    );
  }

  return (
    <div className={`bubble-row ${message.role}`}>
      <div className={`bubble ${message.role}`}>
        <span className="visually-hidden">{isUser ? 'You' : 'Story Builder'}</span>
        {body}
        {message.toolCalls.length > 0 ? (
          <div className="bubble-tools">
            {message.toolCalls.slice(0, 16).map((call, index) => (
              <span className="tool-chip" key={`${call.name}-${index}`}>
                {call.name}
              </span>
            ))}
          </div>
        ) : null}
        <div className="bubble-meta">
          {message.status === 'STREAMING' ? <Badge tone="waiting">writing</Badge> : null}
          {message.status === 'PENDING' ? <Badge tone="waiting">queued</Badge> : null}
          {message.status === 'FAILED' ? <Badge tone="critical">failed</Badge> : null}
          <span className="meta">{relativeAge(message.createdAt)}</span>
        </div>
        {message.error ? <ErrorText>{message.error}</ErrorText> : null}
      </div>
    </div>
  );
}
