import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseInline, parseMarkdown, safeHref, type MarkdownBlock, type MarkdownInline } from '../lib/markdown';

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The words a person reads, in the order the chat window would show them. */
function inlineText(nodes: MarkdownInline[]): string {
  return nodes.map((node) => ('children' in node ? inlineText(node.children) : node.text)).join('');
}

function blockText(blocks: MarkdownBlock[]): string {
  return blocks
    .map((block) => {
      switch (block.type) {
        case 'heading':
          return inlineText(block.children);
        case 'paragraph':
          return block.lines.map(inlineText).join('\n');
        case 'list':
          return block.items.map(blockText).join('\n');
        case 'blockquote':
          return blockText(block.children);
        case 'code':
          return [block.info, block.code].filter(Boolean).join('\n');
        case 'rule':
          return '';
      }
    })
    .join('\n\n');
}

function words(text: string): string[] {
  return text.match(/[A-Za-z0-9]+/g) ?? [];
}

/** Every node of a parse, however deep, so a test can ask whether any of them is a link. */
function allInline(blocks: MarkdownBlock[]): MarkdownInline[] {
  const found: MarkdownInline[] = [];
  const walk = (nodes: MarkdownInline[]) => {
    for (const node of nodes) {
      found.push(node);
      if ('children' in node) walk(node.children);
    }
  };
  for (const block of blocks) {
    if (block.type === 'heading') walk(block.children);
    if (block.type === 'paragraph') block.lines.forEach(walk);
    if (block.type === 'list') block.items.forEach((item) => found.push(...allInline(item)));
    if (block.type === 'blockquote') found.push(...allInline(block.children));
  }
  return found;
}

test('headings one to six are headings and a seventh hash is text', () => {
  for (let level = 1; level <= 6; level += 1) {
    assert.deepEqual(parseMarkdown(`${'#'.repeat(level)} Title`), [
      { type: 'heading', level, children: [{ type: 'text', text: 'Title' }] },
    ]);
  }
  assert.deepEqual(parseMarkdown('####### Title'), [
    { type: 'paragraph', lines: [[{ type: 'text', text: '####### Title' }]] },
  ]);
  assert.deepEqual(parseMarkdown('#hashtag'), [{ type: 'paragraph', lines: [[{ type: 'text', text: '#hashtag' }]] }]);
  assert.deepEqual(parseMarkdown('## Closed ##'), [
    { type: 'heading', level: 2, children: [{ type: 'text', text: 'Closed' }] },
  ]);
});

test('unordered lists take any bullet and keep continuation lines', () => {
  const blocks = parseMarkdown('- one\n* two\n+ three\n  still three');
  assert.equal(blocks.length, 1);
  const list = blocks[0]!;
  assert.equal(list.type, 'list');
  if (list.type !== 'list') return;
  assert.equal(list.ordered, false);
  assert.deepEqual(list.items.map(blockText), ['one', 'two', 'three\nstill three']);
});

test('ordered lists keep their start number and both delimiters', () => {
  const [list] = parseMarkdown('3. three\n4) four');
  assert.ok(list && list.type === 'list');
  assert.equal(list.ordered, true);
  assert.equal(list.start, 3);
  assert.deepEqual(list.items.map(blockText), ['three', 'four']);
});

test('lists nest by indentation, whether or not it lines up with the text', () => {
  for (const source of ['- outer\n  - inner\n- next', '1. outer\n  - inner\n2. next', '1. outer\n   - inner\n2. next']) {
    const [list] = parseMarkdown(source);
    assert.ok(list && list.type === 'list', source);
    assert.equal(list.items.length, 2, source);
    const [paragraph, nested] = list.items[0]!;
    assert.equal(paragraph?.type, 'paragraph', source);
    assert.ok(nested && nested.type === 'list', source);
    assert.equal(nested.ordered, false);
    assert.deepEqual(nested.items.map(blockText), ['inner']);
    assert.equal(blockText(list.items[1]!), 'next');
  }
});

test('a blank line between items keeps one list, and a paragraph after it ends the list', () => {
  const blocks = parseMarkdown('- one\n\n- two\n\nAfter the list.');
  assert.deepEqual(
    blocks.map((block) => block.type),
    ['list', 'paragraph'],
  );
  const list = blocks[0]!;
  assert.ok(list.type === 'list');
  assert.deepEqual(list.items.map(blockText), ['one', 'two']);
});

test('a list interrupts a paragraph, but a line reading like an empty item does not', () => {
  assert.deepEqual(
    parseMarkdown('Steps:\n1. first\n2. second').map((block) => block.type),
    ['paragraph', 'list'],
  );
  assert.deepEqual(
    parseMarkdown('Released in\n2024.').map((block) => block.type),
    ['paragraph'],
  );
});

test('a fenced block inside a list item stays in the item', () => {
  const [list] = parseMarkdown('- run this:\n  ```sh\n  npm test\n\n  npm run build\n  ```\n- then this');
  assert.ok(list && list.type === 'list');
  assert.equal(list.items.length, 2);
  const code = list.items[0]![1];
  assert.deepEqual(code, { type: 'code', info: 'sh', code: 'npm test\n\nnpm run build', closed: true });
});

test('blockquotes, rules and paragraphs with their line breaks', () => {
  assert.deepEqual(parseMarkdown('> quoted\n> still'), [
    {
      type: 'blockquote',
      children: [{ type: 'paragraph', lines: [[{ type: 'text', text: 'quoted' }], [{ type: 'text', text: 'still' }]] }],
    },
  ]);
  for (const rule of ['---', '***', '___', '- - -']) {
    assert.deepEqual(parseMarkdown(rule), [{ type: 'rule' }], rule);
  }
  assert.deepEqual(parseMarkdown('first line\nsecond line\n\nnext paragraph'), [
    { type: 'paragraph', lines: [[{ type: 'text', text: 'first line' }], [{ type: 'text', text: 'second line' }]] },
    { type: 'paragraph', lines: [[{ type: 'text', text: 'next paragraph' }]] },
  ]);
});

test('fenced code with and without an info string, with tildes and a longer closer', () => {
  assert.deepEqual(parseMarkdown('```ts\nconst a = 1;\n```'), [
    { type: 'code', info: 'ts', code: 'const a = 1;', closed: true },
  ]);
  assert.deepEqual(parseMarkdown('```\n# not a heading\n- not a list\n```'), [
    { type: 'code', info: '', code: '# not a heading\n- not a list', closed: true },
  ]);
  assert.deepEqual(parseMarkdown('~~~\ncode\n~~~'), [{ type: 'code', info: '', code: 'code', closed: true }]);
  assert.deepEqual(parseMarkdown('````\n```\ninner\n```\n`````'), [
    { type: 'code', info: '', code: '```\ninner\n```', closed: true },
  ]);
  assert.deepEqual(parseMarkdown('```\n```'), [{ type: 'code', info: '', code: '', closed: true }]);
});

test('an unclosed fence at the end is code to the end, marked unclosed', () => {
  assert.deepEqual(parseMarkdown('Here:\n```py\nprint(1)\n\n**not bold**\n'), [
    { type: 'paragraph', lines: [[{ type: 'text', text: 'Here:' }]] },
    { type: 'code', info: 'py', code: 'print(1)\n\n**not bold**', closed: false },
  ]);
});

test('code spans match their own run length and their contents are not formatted', () => {
  assert.deepEqual(parseInline('use `a*b*c` here'), [
    { type: 'text', text: 'use ' },
    { type: 'code', text: 'a*b*c' },
    { type: 'text', text: ' here' },
  ]);
  assert.deepEqual(parseInline('``a ` b``'), [{ type: 'code', text: 'a ` b' }]);
  assert.deepEqual(parseInline('`` `tick` ``'), [{ type: 'code', text: '`tick`' }]);
  assert.deepEqual(parseInline('trailing `'), [{ type: 'text', text: 'trailing `' }]);
  assert.deepEqual(parseInline('```unclosed'), [{ type: 'text', text: '```unclosed' }]);
});

test('strong and emphasis, with unpartnered markers kept as typed', () => {
  assert.deepEqual(parseInline('**bold** and *soft* and __also__ and _this_'), [
    { type: 'strong', children: [{ type: 'text', text: 'bold' }] },
    { type: 'text', text: ' and ' },
    { type: 'emphasis', children: [{ type: 'text', text: 'soft' }] },
    { type: 'text', text: ' and ' },
    { type: 'strong', children: [{ type: 'text', text: 'also' }] },
    { type: 'text', text: ' and ' },
    { type: 'emphasis', children: [{ type: 'text', text: 'this' }] },
  ]);
  assert.deepEqual(parseInline('*a **b** c*'), [
    {
      type: 'emphasis',
      children: [
        { type: 'text', text: 'a ' },
        { type: 'strong', children: [{ type: 'text', text: 'b' }] },
        { type: 'text', text: ' c' },
      ],
    },
  ]);
  assert.deepEqual(parseInline('***both***'), [
    { type: 'strong', children: [{ type: 'emphasis', children: [{ type: 'text', text: 'both' }] }] },
  ]);
  for (const literal of ['**half written', 'a * b * c', '2 * 3', '*', '**', '** spaced **']) {
    assert.deepEqual(parseInline(literal), [{ type: 'text', text: literal }], literal);
  }
});

test('an underscore inside a word is never emphasis', () => {
  for (const literal of ['snake_case_name', 'call my_function_here now', 'a_b_c']) {
    assert.deepEqual(parseInline(literal), [{ type: 'text', text: literal }], literal);
  }
});

test('backslash escapes produce the character and nothing else', () => {
  assert.deepEqual(parseInline('\\*not\\* \\`code\\` \\[x\\](y) C:\\path'), [
    { type: 'text', text: '*not* `code` [x](y) C:\\path' },
  ]);
});

test('links to the web and to mail are links', () => {
  assert.deepEqual(parseInline('see [the docs](https://example.com/a_(b)) now'), [
    { type: 'text', text: 'see ' },
    { type: 'link', href: 'https://example.com/a_(b)', children: [{ type: 'text', text: 'the docs' }] },
    { type: 'text', text: ' now' },
  ]);
  assert.deepEqual(parseInline('[**bold**](mailto:someone@example.com)'), [
    {
      type: 'link',
      href: 'mailto:someone@example.com',
      children: [{ type: 'strong', children: [{ type: 'text', text: 'bold' }] }],
    },
  ]);
});

test('safeHref accepts web and mail links only', () => {
  assert.equal(safeHref('http://example.com'), 'http://example.com');
  assert.equal(safeHref('HTTPS://example.com/x'), 'HTTPS://example.com/x');
  assert.equal(safeHref('  https://example.com  '), 'https://example.com');
  assert.equal(safeHref('mailto:a@example.com'), 'mailto:a@example.com');

  const rejected = [
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    '  JAVASCRIPT:alert(1)',
    'java\tscript:alert(1)',
    'java\nscript:alert(1)',
    '\u0000javascript:alert(1)',
    'vbscript:msgbox(1)',
    'data:text/html,<script>alert(1)</script>',
    'javascript&#58;alert(1)',
    '&#104;ttps://example.com',
    '/relative/path',
    'apps/web/app/chat/page.tsx',
    '//example.com',
    'example.com',
    'https:',
    'file:///etc/passwd',
  ];
  for (const href of rejected) {
    assert.equal(safeHref(href), null, JSON.stringify(href));
  }
});

test('a link with a refused target keeps its words and is not a link', () => {
  for (const source of [
    '[x](javascript:alert(1))',
    '[x]( JAVASCRIPT:alert(1))',
    '[x](java\tscript:alert(1))',
    '[x](data:text/html,hi)',
    '[x](/relative)',
  ]) {
    const blocks = parseMarkdown(source);
    assert.ok(!allInline(blocks).some((node) => node.type === 'link'), source);
    assert.equal(blockText(blocks), 'x', source);
  }
});

test('raw HTML comes out as the literal characters in a text node', () => {
  for (const html of ['<script>alert(1)</script>', '<img src=x onerror="alert(1)">', '<a href="javascript:alert(1)">x</a>']) {
    const blocks = parseMarkdown(html);
    assert.deepEqual(blocks, [{ type: 'paragraph', lines: [[{ type: 'text', text: html }]] }], html);
  }
});

test('text with no formatting in it comes back exactly as it went in', () => {
  const inputs = [
    'Hello there.',
    'A reply that runs over\nseveral lines\nwithout any syntax.',
    'One paragraph.\n\nAnother paragraph, with punctuation: commas, (parens), and 42 numbers!',
    'Arrows -> and <- and a price of $5 and 3 > 2 in the middle.',
    'Path like C:/Users/someone and a url-ish thing example.com/a.',
    'Non-ASCII: café, naïve, Привет, 日本語.',
  ];
  for (const input of inputs) {
    assert.equal(blockText(parseMarkdown(input)), input, input);
  }
});

const TRANSCRIPT = [
  'This project is checked out on a story branch, so I am reading only.',
  '',
  'Let me look at the chat page first.',
  '`Read`',
  '',
  '`Grep`',
  'Found it. The **message list** is rendered in `page.tsx`:',
  '',
  '```tsx',
  'view.messages.map((message) => (',
  '  <div key={message.id} className="turn">',
  '))',
  '```',
  '',
  '## What to change',
  '',
  '- replace the map',
  '  - keep the scroll effect',
  '- restyle the *turns*',
  '',
  '> Nothing else moves.',
  '',
  'That is all.',
].join('\n');

test('a transcript shaped like the worker writes it keeps every word, whole and cut short at any point', () => {
  const full = parseMarkdown(TRANSCRIPT);
  assert.deepEqual(
    full.map((block) => block.type),
    ['paragraph', 'paragraph', 'paragraph', 'code', 'heading', 'list', 'blockquote', 'paragraph'],
  );
  const code = full[3]!;
  assert.ok(code.type === 'code');
  assert.equal(code.closed, true);
  assert.equal(code.code, 'view.messages.map((message) => (\n  <div key={message.id} className="turn">\n))');

  for (let cut = 0; cut <= TRANSCRIPT.length; cut += 1) {
    const partial = TRANSCRIPT.slice(0, cut);
    const blocks = parseMarkdown(partial);
    assert.deepEqual(words(blockText(blocks)), words(partial), `cut at ${cut}: ${JSON.stringify(partial.slice(-20))}`);
  }
});

test('a transcript cut inside its code fence shows the rest as unclosed code', () => {
  const cut = TRANSCRIPT.indexOf('<div');
  const blocks = parseMarkdown(TRANSCRIPT.slice(0, cut));
  const last = blocks[blocks.length - 1]!;
  assert.ok(last.type === 'code');
  assert.equal(last.closed, false);
  assert.equal(last.info, 'tsx');
});

test('pathological input stays fast', () => {
  const started = Date.now();
  parseMarkdown('*a '.repeat(20_000));
  parseMarkdown('_a '.repeat(20_000));
  parseMarkdown('`a ``'.repeat(5_000));
  parseMarkdown('['.repeat(20_000));
  parseMarkdown('>'.repeat(5_000) + ' deep');
  parseMarkdown(Array.from({ length: 200 }, (_, depth) => `${'  '.repeat(depth)}- item`).join('\n'));
  assert.ok(Date.now() - started < 2_000, `took ${Date.now() - started}ms`);
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

test('nothing in the cockpit hands a string to the browser as HTML', () => {
  const offenders = tsxFiles(WEB_ROOT)
    .filter((file) => readFileSync(file, 'utf8').includes('dangerouslySetInnerHTML'))
    .map((file) => path.relative(WEB_ROOT, file));
  assert.deepEqual(offenders, []);
});
