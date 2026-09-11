import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearDraft, readDraft, type DraftTarget } from '../lib/draft-field';

/**
 * This is a model of the failure, not a browser. There is no DOM in the
 * repository, so nothing here executes React or dispatches a real paste. What
 * it pins is the policy: the submit path reads the element, and no render
 * writes the element. The coverage guard below is what keeps that policy true
 * for inputs added later.
 */

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

interface Interleaving {
  chunkSize: number;
  commitEvery: number;
  dropEvery: number;
}

/**
 * Applies a long paste in chunks while something else commits in between. The
 * browser puts every chunk on the element whatever React is doing, but some
 * input events do not reach React, so what React last saw lags the element.
 */
function drivePaste(
  text: string,
  commit: (target: DraftTarget, lastSeen: string) => void,
  interleaving: Interleaving,
): DraftTarget {
  const target: DraftTarget = { value: '' };
  let lastSeen = '';
  let chunkIndex = 0;

  for (let at = 0; at < text.length; at += interleaving.chunkSize) {
    target.value += text.slice(at, at + interleaving.chunkSize);
    chunkIndex += 1;
    if (chunkIndex % interleaving.dropEvery !== 0) lastSeen = target.value;
    if (chunkIndex % interleaving.commitEvery === 0) commit(target, lastSeen);
  }

  return target;
}

const INTERLEAVING: Interleaving = { chunkSize: 40, commitEvery: 5, dropEvery: 7 };
const STORY = 'a'.repeat(4000);
const NOTE = 'Extend the existing NotificationService rather than adding another. '.repeat(60);

test('a controlled input loses characters when a poll commits during a long paste', () => {
  const target = drivePaste(
    STORY,
    (element, lastSeen) => {
      // What a `value` prop does on every render: React's idea of the text is
      // written back onto the element.
      element.value = lastSeen;
    },
    INTERLEAVING,
  );

  assert.ok(
    target.value.length < STORY.length,
    `expected characters to be lost, kept ${target.value.length} of ${STORY.length}`,
  );
});

test('an uncontrolled input keeps a four thousand character story through the same interleaving', () => {
  const target = drivePaste(STORY, () => {}, INTERLEAVING);

  assert.equal(readDraft(target), STORY);
  assert.equal(readDraft(target).length, 4000);

  clearDraft(target);
  assert.equal(readDraft(target), '');
});

test('an uncontrolled input keeps a long review note through the same interleaving', () => {
  const target = drivePaste(NOTE, () => {}, INTERLEAVING);

  assert.equal(readDraft(target), NOTE);

  clearDraft(target);
  assert.equal(readDraft(target), '');
});

test('reading and clearing an absent element neither throws nor invents text', () => {
  assert.equal(readDraft(null), '');
  clearDraft(null);
});

function tsxFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.next') continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...tsxFiles(full));
    else if (entry.name.endsWith('.tsx')) found.push(full);
  }
  return found;
}

/** Each `<textarea` opening tag, braces and quotes respected so an arrow does not end it early. */
function textareaTags(source: string): string[] {
  const tags: string[] = [];
  let at = source.indexOf('<textarea');

  while (at !== -1) {
    let cursor = at + '<textarea'.length;
    let depth = 0;
    let quote = '';
    while (cursor < source.length) {
      const character = source[cursor];
      if (quote) {
        if (character === quote) quote = '';
      } else if (character === '"' || character === "'" || character === '`') {
        quote = character;
      } else if (character === '{') {
        depth += 1;
      } else if (character === '}') {
        depth -= 1;
      } else if (character === '>' && depth === 0) {
        break;
      }
      cursor += 1;
    }
    tags.push(source.slice(at, cursor));
    at = source.indexOf('<textarea', cursor);
  }

  return tags;
}

test('every multi-line input in the cockpit goes through the one shared component', () => {
  const owners = tsxFiles(WEB_ROOT)
    .filter((file) => readFileSync(file, 'utf8').includes('<textarea'))
    .map((file) => path.relative(WEB_ROOT, file).split(path.sep).join('/'))
    .sort();

  assert.deepEqual(owners, ['components/draft-textarea.tsx']);
});

test('no textarea in the cockpit is controlled by a value prop', () => {
  for (const file of tsxFiles(WEB_ROOT)) {
    for (const tag of textareaTags(readFileSync(file, 'utf8'))) {
      assert.ok(
        !/[\s{]value\s*=/.test(tag),
        `${path.relative(WEB_ROOT, file)} passes a value prop to a textarea, which lets a render overwrite a paste`,
      );
    }
  }
});
