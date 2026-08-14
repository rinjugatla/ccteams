/**
 * Tests for lib/prompt.js's createTtyPrompter(). Previously hardcoded
 * process.stdin/process.stdout, which made it untestable in a `node --test`
 * run (neither stream can be scripted or observed there) — createTtyPrompter()
 * now accepts { input, output } so a test can inject a node:stream PassThrough
 * pair instead. lib/migrate.js's real call site (createTtyPrompter() with no
 * arguments) is unaffected — input/output default to the real TTY streams.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createTtyPrompter } from '../lib/prompt.js';

describe('createTtyPrompter({ input, output })', () => {
  test('ask(question) resolves with the injected input line', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const prompter = createTtyPrompter({ input, output });

    const askPromise = prompter.ask('overwrite? ');
    input.write('y\n');

    const answer = await askPromise;
    assert.equal(answer, 'y');

    prompter.close();
  });

  test('the question text is written to the injected output stream', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const prompter = createTtyPrompter({ input, output });

    let written = '';
    output.on('data', (chunk) => {
      written += chunk.toString('utf8');
    });

    const askPromise = prompter.ask('overwrite this file? ');
    input.write('n\n');
    await askPromise;

    assert.ok(written.includes('overwrite this file? '), `expected the question on output, got: ${written}`);

    prompter.close();
  });

  test('close() releases the injected input stream\'s listeners (no hang, no leak)', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const prompter = createTtyPrompter({ input, output });

    const listenersBeforeClose = input.listenerCount('data') + input.listenerCount('keypress');
    assert.ok(listenersBeforeClose > 0, 'sanity check: readline actually attached listeners to input');

    prompter.close();

    const listenersAfterClose = input.listenerCount('data') + input.listenerCount('keypress');
    assert.equal(listenersAfterClose, 0, 'close() must release the listeners readline attached to input');
  });
});
