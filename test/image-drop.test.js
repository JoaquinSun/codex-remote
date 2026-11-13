'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { bind } = require('../public/image-drop');

function dropTarget() {
  const events = new Map();
  const windowEvents = new Map();
  const result = { active: false, ready: true, files: [], errors: [] };
  const reset = bind({
    target: { addEventListener: (name, handler) => events.set(name, handler) },
    viewport: { addEventListener: (name, handler) => windowEvents.set(name, handler) },
    canAttach: () => result.ready,
    onActive: (active) => { result.active = active; },
    onFiles: async (files) => { result.files.push(...files); },
    onRejected: (message) => { result.errors.push(message); },
  });
  const dispatch = async (name, transfer = { types: ['Files'], files: [] }, extra = {}) => {
    const event = { dataTransfer: transfer, prevented: false,
      preventDefault() { this.prevented = true; }, ...extra };
    await (events.get(name) || windowEvents.get(name))(event);
    return event;
  };
  return { result, dispatch, reset };
}

test('dropping multiple image files adds only images and blocks browser file navigation', async () => {
  const { result, dispatch } = dropTarget();
  const transfer = { types: ['Files'], files: [
    { name: 'one.png', type: 'image/png' }, { name: 'notes.txt', type: 'text/plain' },
    { name: 'two.jpg', type: 'image/jpeg' },
  ] };
  assert.equal((await dispatch('dragenter', transfer)).prevented, true);
  assert.equal(result.active, true);
  await dispatch('dragover', transfer);
  assert.equal(transfer.dropEffect, 'copy');
  assert.equal((await dispatch('drop', transfer)).prevented, true);
  assert.equal(result.active, false);
  assert.deepEqual(result.files.map((file) => file.name), ['one.png', 'two.jpg']);
});

test('dragging normal text leaves the browser text drag behavior intact', async () => {
  const { result, dispatch } = dropTarget();
  const transfer = { types: ['text/plain'], files: [], items: [{ kind: 'string' }] };
  for (const name of ['dragenter', 'dragover', 'drop']) {
    assert.equal((await dispatch(name, transfer)).prevented, false);
  }
  assert.equal(result.active, false);
  assert.deepEqual(result.files, []);
});

test('nested drag targets do not flicker and cancellation clears the drop hint', async () => {
  const { result, dispatch } = dropTarget();
  await dispatch('dragenter');
  await dispatch('dragenter');
  await dispatch('dragleave');
  assert.equal(result.active, true);
  await dispatch('dragleave');
  assert.equal(result.active, false);
  for (const [name, extra] of [['keydown', { key: 'Escape' }], ['blur', {}], ['dragend', {}]]) {
    await dispatch('dragenter');
    await dispatch(name, undefined, extra);
    assert.equal(result.active, false);
  }
});

test('file drops before opening a chat are rejected without adding attachments', async () => {
  const { result, dispatch } = dropTarget();
  result.ready = false;
  const transfer = { types: ['Files'], files: [{ type: 'image/png', name: 'one.png' }] };
  await dispatch('dragenter', transfer);
  assert.equal(result.active, false);
  await dispatch('dragover', transfer);
  assert.equal(transfer.dropEffect, 'none');
  assert.equal((await dispatch('drop', transfer)).prevented, true);
  assert.match(result.errors[0], /先打开一条对话/);
  assert.deepEqual(result.files, []);
});

test('unsupported files are rejected while the browser stays on the conversation', async () => {
  const { result, dispatch } = dropTarget();
  assert.equal((await dispatch('drop', { types: ['Files'], files: [{ name: 'report.pdf', type: 'application/pdf' }] })).prevented, true);
  assert.match(result.errors[0], /仅支持拖入图片/);
  assert.equal(result.active, false);
  assert.deepEqual(result.files, []);
});

test('protected file items are accepted when the file list is not populated', async () => {
  const { result, dispatch } = dropTarget();
  const image = { name: 'one.png', type: 'image/png' };
  const transfer = { types: [], files: [], items: [{ kind: 'file', getAsFile: () => image }] };
  await dispatch('dragenter', transfer);
  assert.equal(result.active, true);
  await dispatch('drop', transfer);
  assert.deepEqual(result.files, [image]);
});
