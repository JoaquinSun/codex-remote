'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalizeSelection, normalizeCatalog, validateSelection, threadParams, turnParams, effectiveModel, loadModelMap, saveModelMap } = require('../src/models');

const catalog = normalizeCatalog([
  { id: 'catalog-id', model: 'example-fast', displayName: 'Fast', defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] },
  { id: 'example-plain', model: 'example-plain', supportedReasoningEfforts: [] },
]);

test('uses dynamic catalog identifiers and only the selected model’s supported efforts', () => {
  assert.deepEqual(validateSelection({ model: 'catalog-id' }, catalog), { model: 'example-fast', reasoningEffort: 'low' });
  assert.deepEqual(validateSelection({ model: 'example-fast', reasoningEffort: 'high' }, catalog), { model: 'example-fast', reasoningEffort: 'high' });
  assert.deepEqual(validateSelection({ model: 'example-plain' }, catalog), { model: 'example-plain', reasoningEffort: null });
  assert.throws(() => validateSelection({ model: 'example-fast', reasoningEffort: 'ultra' }, catalog), { statusCode: 400 });
  assert.throws(() => validateSelection({ model: 'missing-model' }, catalog), { statusCode: 400 });
});

test('catalog hides hidden entries, deduplicates slugs, and supports older effort lists', () => {
  const models = normalizeCatalog([
    { model: 'hidden', hidden: true },
    { model: 'visible', supportedReasoningEfforts: ['low', 'high', 'low', null] },
    { model: 'visible' },
    null,
  ]);
  assert.equal(models.length, 1);
  assert.equal(models[0].displayName, 'visible');
  assert.deepEqual(models[0].supportedReasoningEfforts.map((option) => option.reasoningEffort), ['low', 'high']);
  assert.deepEqual(models[0].inputModalities, ['text', 'image']);
});

test('follow desktop omits model overrides from both RPC paths', () => {
  const selection = normalizeSelection({ model: null });
  assert.deepEqual(threadParams(selection), {});
  assert.deepEqual(turnParams(selection), {});
});

test('effort reaches the native thread and turn RPC fields', () => {
  const selection = { model: 'example-fast', reasoningEffort: 'high' };
  assert.deepEqual(threadParams(selection), { model: 'example-fast', config: { model_reasoning_effort: 'high' } });
  assert.deepEqual(turnParams(selection), { model: 'example-fast', effort: 'high' });
});

test('reads effective model and effort from metadata and settings notifications', () => {
  assert.deepEqual(effectiveModel(null, { model: 'example-fast', reasoningEffort: 'high' }), { model: 'example-fast', reasoningEffort: 'high' });
  assert.deepEqual(effectiveModel({ model: 'example-plain', effort: null }, { model: 'example-fast', reasoningEffort: 'high' }), { model: 'example-plain', reasoningEffort: null });
  assert.deepEqual(effectiveModel({ threadSettings: { model: 'example-fast', effort: 'low' } }), { model: 'example-fast', reasoningEffort: 'low' });
});

test('persists different sessions and ignores only invalid saved entries', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-remote-model-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'models.json');
  saveModelMap(file, { first: { model: 'example-fast', reasoningEffort: 'high' }, second: { model: 'example-plain' } });
  const saved = loadModelMap(file);
  assert.equal(saved.first.reasoningEffort, 'high');
  assert.equal(saved.second.model, 'example-plain');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.ok(!fs.existsSync(file + '.tmp'));
  fs.writeFileSync(file, JSON.stringify({ good: { model: 'example-fast' }, bad: { model: ['invalid'] } }));
  assert.deepEqual(Object.keys(loadModelMap(file)), ['good']);
});

test('rejects malformed settings and effort without a selected model', () => {
  for (const value of [[], 'model', { model: 'has whitespace' }, { model: 1 }, { reasoningEffort: 'high' }]) {
    assert.throws(() => normalizeSelection(value), { statusCode: 400 });
  }
});
