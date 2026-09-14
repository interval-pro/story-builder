'use client';

import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { safeHref, type MarkdownBlock, type MarkdownInline } from '../lib/markdown';
import { Button } from './ui';

type CodeData = Extract<MarkdownBlock, { type: 'code' }>;

// A reply's own headings sit below the page's, so its outline stays the page's.
const HEADING_TAGS = { 1: 'h3', 2: 'h4', 3: 'h5', 4: 'h6', 5: 'h6', 6: 'h6' } as const;

/**
 * A parsed reply, as elements.
 *
 * Everything here is built from the data `parseMarkdown` returns; no string from
 * a reply is ever given to the browser as markup, and a link is only a link when
 * its target is a web or mail address.
 */
export function MarkdownView({ blocks }: { blocks: MarkdownBlock[] }) {
  return <div className="markdown">{renderBlocks(blocks)}</div>;
}

function renderBlocks(blocks: MarkdownBlock[]): ReactNode {
  return blocks.map((block, index) => renderBlock(block, index));
}

function renderBlock(block: MarkdownBlock, key: number): ReactNode {
  switch (block.type) {
    case 'heading': {
      const Tag = HEADING_TAGS[block.level];
      return <Tag key={key}>{renderInline(block.children)}</Tag>;
    }
    case 'paragraph':
      return (
        <p key={key}>
          {block.lines.map((line, index) => (
            <Fragment key={index}>
              {index > 0 ? <br /> : null}
              {renderInline(line)}
            </Fragment>
          ))}
        </p>
      );
    case 'list': {
      const items = block.items.map((item, index) => <li key={index}>{renderBlocks(item)}</li>);
      return block.ordered ? (
        <ol key={key} start={block.start}>
          {items}
        </ol>
      ) : (
        <ul key={key}>{items}</ul>
      );
    }
    case 'blockquote':
      return <blockquote key={key}>{renderBlocks(block.children)}</blockquote>;
    case 'code':
      return <CodeBlock key={key} block={block} />;
    case 'rule':
      return <hr key={key} />;
  }
}

function renderInline(nodes: MarkdownInline[]): ReactNode {
  return nodes.map((node, index) => {
    switch (node.type) {
      case 'text':
        return <Fragment key={index}>{node.text}</Fragment>;
      case 'code':
        return <code key={index}>{node.text}</code>;
      case 'strong':
        return <strong key={index}>{renderInline(node.children)}</strong>;
      case 'emphasis':
        return <em key={index}>{renderInline(node.children)}</em>;
      case 'link': {
        // Checked again here, so the data cannot become a link some other way.
        const href = safeHref(node.href);
        if (!href) return <Fragment key={index}>{renderInline(node.children)}</Fragment>;
        return (
          <a key={index} href={href} target="_blank" rel="noopener noreferrer">
            {renderInline(node.children)}
          </a>
        );
      }
    }
  });
}

const COPY_LABELS = { idle: 'Copy', copied: 'Copied', failed: 'Copy failed' } as const;

/**
 * A code block with a copy button.
 *
 * It copies the code from the data rather than from the page, so what lands on
 * the clipboard is exactly the code, and it works while the block is still being
 * written.
 */
export function CodeBlock({ block }: { block: CodeData }) {
  const preRef = useRef<HTMLPreElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  const [state, setState] = useState<keyof typeof COPY_LABELS>('idle');

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  async function copy() {
    const copied = await copyText(block.code, preRef.current);
    if (!mounted.current) return;
    setState(copied ? 'copied' : 'failed');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 1500);
  }

  return (
    <div className="code-block">
      <div className="code-block-header">
        <span className="code-block-info">{block.info}</span>
        <Button variant="ghost" size="sm" onClick={() => void copy()}>
          {COPY_LABELS[state]}
        </Button>
      </div>
      <pre ref={preRef}>
        <code>{block.code}</code>
      </pre>
    </div>
  );
}

/**
 * Puts text on the clipboard, and says whether it did.
 *
 * The Clipboard API only exists on https and localhost. Anywhere else the code is
 * selected and copied the old way, and if that fails too it is left selected so
 * the person can copy it by hand.
 */
export async function copyText(code: string, fallbackElement: HTMLElement | null): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(code);
      return true;
    }
  } catch {
    // Refused or unavailable: fall through to selecting the block.
  }

  const selection = typeof window === 'undefined' ? null : window.getSelection();
  if (!fallbackElement || !selection) return false;
  const range = document.createRange();
  range.selectNodeContents(fallbackElement);
  selection.removeAllRanges();
  selection.addRange(range);
  try {
    const copied = document.execCommand('copy');
    if (copied) selection.removeAllRanges();
    return copied;
  } catch {
    return false;
  }
}
