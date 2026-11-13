'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { groupTurnItems, activitySummary } = require('../public/chat-view');

function item(type, id, extra = {}) { return { type, id, ...extra }; }
function messages(groups) { return groups.filter((group) => group.type === 'message').map((group) => group.item.id); }

test('keeps all text visible and folds only consecutive commands and tools', () => {
  const input = [
    item('userMessage', 'user'),
    item('agentMessage', 'progress', { phase: 'commentary', text: 'Checking files' }),
    item('reasoning', 'thought', { summary: ['Thinking'] }),
    item('commandExecution', 'command', { command: 'cat file.js', exitCode: 0 }),
    item('mcpToolCall', 'tool'),
    item('agentMessage', 'answer', { phase: 'final_answer', text: 'Done' }),
  ];
  const groups = groupTurnItems(input);
  assert.deepEqual(groups.map((group) => group.type), ['message', 'message', 'message', 'activity', 'message']);
  assert.deepEqual(messages(groups), ['user', 'progress', 'thought', 'answer']);
  assert.deepEqual(groups[3].items.map((entry) => entry.id), ['command', 'tool']);
  assert.equal(input.length, 6);
});

test('retains progress text and answers for legacy providers that omit phase', () => {
  const groups = groupTurnItems([
    item('userMessage', 'user'), item('agentMessage', 'progress', { text: 'Let me check' }),
    item('commandExecution', 'command'), item('agentMessage', 'answer', { text: 'Here is the answer' }),
  ]);
  assert.deepEqual(messages(groups), ['user', 'progress', 'answer']);
  assert.equal(groups[2].items[0].id, 'command');
});

test('a legacy progress message stays visible when more tool work follows', () => {
  const groups = groupTurnItems([item('agentMessage', 'progress'), item('commandExecution', 'command')]);
  assert.equal(groups.length, 2);
  assert.deepEqual(messages(groups), ['progress']);
  assert.equal(groups[1].type, 'activity');
});

test('keeps partial answers, user steering, and optimistic echoes in their original order', () => {
  const groups = groupTurnItems([
    item('userMessage', 'first'), item('commandExecution', 'command'),
    item('agentMessage', 'partial', { phase: 'partial_answer' }),
    item('userMessage', 'steering'), item('mcpToolCall', 'tool'),
    item('localEcho', 'echo'), item('reasoning', 'thought'),
    item('agentMessage', 'final', { phase: 'final_answer' }),
  ]);
  assert.deepEqual(messages(groups), ['first', 'partial', 'steering', 'echo', 'thought', 'final']);
  assert.deepEqual(groups.filter((group) => group.type === 'activity').map((group) => group.items.map((entry) => entry.id)), [['command'], ['tool']]);
});

test('questions and proposed plans remain visible for the user to respond to', () => {
  const groups = groupTurnItems([
    item('plan', 'plan'), item('agentMessage', 'question', { phase: 'commentary', questions: [{ question: 'Which directory?' }] }),
    item('commandExecution', 'command'), item('exitedReviewMode', 'review'),
  ]);
  assert.deepEqual(messages(groups), ['plan', 'question', 'review']);
});

test('summaries count unique changed files and expose failures without printing commands', () => {
  const summary = activitySummary([
    item('commandExecution', 'a', { command: 'secret-command', status: 'completed', exitCode: 1 }),
    item('fileChange', 'b', { changes: [{ path: 'app.js' }, { path: 'style.css' }] }),
    item('fileChange', 'c', { changes: [{ path: 'app.js' }] }),
    item('mcpToolCall', 'd', { error: { message: 'error' } }),
  ], { status: 'completed' });
  assert.equal(summary.counts, '1 次执行 · 2 个文件 · 1 次工具调用 · 2 个步骤失败');
  assert.equal(summary.failed, true);
  assert.ok(!JSON.stringify(summary).includes('secret-command'));
});

test('streaming tool summary names the current action without moving progress text into it', () => {
  const summary = activitySummary([
    item('agentMessage', 'first', { phase: 'commentary', text: 'First update' }),
    item('agentMessage', 'second', { phase: 'commentary', text: 'Reading\n the source' }),
    item('commandExecution', 'command', { status: 'inProgress', command: 'cat raw-file', commandActions: [{ type: 'read' }] }),
  ], { running: true });
  assert.equal(summary.label, '正在读取文件');
  assert.ok(!JSON.stringify(summary).includes('Reading'));
  assert.ok(!JSON.stringify(summary).includes('cat raw-file'));
  assert.equal(activitySummary([], { status: 'interrupted' }).label, '已中断 · 执行过程');
});
