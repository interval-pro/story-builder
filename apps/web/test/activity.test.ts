import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  chatActivity,
  ideaActivity,
  jobActivity,
  jobStatusesByTask,
  runActivity,
  setupActivity,
  stepActivity,
  taskActivity,
  type Activity,
} from '../lib/activity';
import type { TaskStep } from '../lib/api';

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function table(fn: (value: string) => Activity, cases: [string, Activity][]) {
  for (const [value, expected] of cases) assert.equal(fn(value), expected, `${value} should be ${expected}`);
}

test('a job pulses while a worker holds it and sits still while it is queued', () => {
  table(jobActivity, [
    ['RUNNING', 'working'],
    ['PENDING', 'queued'],
    ['COMPLETED', null],
    ['FAILED', null],
    ['CANCELLED', null],
  ]);
});

test('a run shows activity only while it is running', () => {
  table(runActivity, [
    ['RUNNING', 'working'],
    ['COMPLETED', null],
    ['FAILED', null],
  ]);
});

test('an idea is working while it is thought through and queued while it waits for a slot', () => {
  table(ideaActivity, [
    ['THINKING', 'working'],
    ['QUEUED', 'queued'],
    ['ASKING', null],
    ['READY', null],
    ['FAILED', null],
    ['DISCARDED', null],
  ]);
});

test('a chat reply is queued until the worker starts writing it', () => {
  table(chatActivity, [
    ['STREAMING', 'working'],
    ['PENDING', 'queued'],
    ['COMPLETE', null],
    ['FAILED', null],
  ]);
});

test('project setup follows the same rule as a job', () => {
  table(setupActivity, [
    ['RUNNING', 'working'],
    ['PENDING', 'queued'],
    ['READY', null],
    ['FAILED', null],
  ]);
});

test('a queued step from the progress walk reads as queued', () => {
  const queued: TaskStep['status'] = 'QUEUED';
  assert.equal(stepActivity(queued), 'queued');
  table(stepActivity, [
    ['RUNNING', 'working'],
    ['WAITING', null],
    ['DONE', null],
    ['PENDING', null],
    ['BLOCKED', null],
  ]);
});

test('a task is decided by its job, not by what its state name suggests', () => {
  // The orchestrator writes REVIEW_REGENERATING when it queues the job.
  assert.equal(taskActivity('REVIEW_REGENERATING', 'PENDING'), 'queued');
  assert.equal(taskActivity('REVIEW_REGENERATING', 'RUNNING'), 'working');
  assert.equal(taskActivity('PUSHING', 'PENDING'), 'queued');
});

test('a task waiting for a person shows no activity, even with a job in the queue', () => {
  assert.equal(taskActivity('REVIEW_READY', null), null);
  assert.equal(taskActivity('REVIEW_READY', 'PENDING'), null);
  assert.equal(taskActivity('PAUSED', 'PENDING'), null);
});

test('a task known to have no job is queued only when it is waiting on another story', () => {
  assert.equal(taskActivity('WAITING_FOR_TASK', null), 'queued');
  assert.equal(taskActivity('IMPLEMENTING', null), null);
});

test('without the queue feed the state name is the evidence left', () => {
  assert.equal(taskActivity('ANALYSIS_QUEUED', undefined), 'queued');
  assert.equal(taskActivity('IMPLEMENTING', undefined), 'working');
  assert.equal(taskActivity('COMPLETED', undefined), null);
});

test('the queue feed is read per task, and a running job wins over a pending one', () => {
  const statuses = jobStatusesByTask([
    { taskId: 'a', status: 'RUNNING' },
    { taskId: 'a', status: 'PENDING' },
    { taskId: 'b', status: 'PENDING' },
    { taskId: null, status: 'RUNNING' },
  ]);
  assert.equal(statuses.get('a'), 'RUNNING');
  assert.equal(statuses.get('b'), 'PENDING');
  assert.equal(statuses.get('c'), undefined);
  assert.equal(jobStatusesByTask(null).size, 0);
});

/**
 * One animation for "the AI is working", not one per page. The pulse may drive
 * the shared indicator and the running progress mark and nothing else, and no
 * second pulsing or blinking animation may appear beside it.
 */
test('the pulse is used only by the shared indicator and the running step', () => {
  const css = readFileSync(path.join(WEB_ROOT, 'app', 'globals.css'), 'utf8');

  const keyframes = [...css.matchAll(/@keyframes\s+([\w-]+)/g)].map((match) => match[1]!);
  assert.deepEqual(
    keyframes.filter((name) => /pulse|blink/i.test(name)),
    ['ip-pulse'],
    'there should be exactly one pulsing animation',
  );

  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  const users = rules
    .filter((match) => /animation[^;]*ip-pulse/.test(match[2]!))
    .map((match) => match[1]!.trim().replace(/\s+/g, ' '));
  assert.deepEqual(users.sort(), ['.activity.working', '.step.running .step-mark']);

  const reduced = [...css.matchAll(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?\})\s*\}/g)].map(
    (match) => match[1]!,
  );
  assert.ok(
    reduced.some((block) => /\.activity\.working[^{]*\{[^}]*animation:\s*none/.test(block)),
    'reduced motion should stop the working indicator rather than speed it up',
  );
});

function sources(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const full = path.join(directory, name);
    if (statSync(full).isDirectory()) return sources(full);
    return full.endsWith('.tsx') ? [full] : [];
  });
}

test('pages draw the indicator through the component rather than by class name', () => {
  const offenders = [...sources(path.join(WEB_ROOT, 'app')), ...sources(path.join(WEB_ROOT, 'components'))]
    .filter((file) => path.basename(file) !== 'ui.tsx')
    .filter((file) => /className=[{"'`][^>]*\bactivity\b/.test(readFileSync(file, 'utf8')))
    .map((file) => path.relative(WEB_ROOT, file));
  assert.deepEqual(offenders, []);
});
