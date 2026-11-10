'use strict';

const fs = require('node:fs');
const path = require('node:path');

function invalidSelection(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function normalizeSelection(value) {
  if (value == null) return { model: null, reasoningEffort: null };
  if (typeof value !== 'object' || Array.isArray(value)) throw invalidSelection('model settings must be an object');
  const model = value.model == null || value.model === '' ? null : value.model;
  const effort = value.reasoningEffort == null || value.reasoningEffort === '' ? null : value.reasoningEffort;
  if (model !== null && (typeof model !== 'string' || model.length > 200 || !model.trim() || /\s|[\u0000-\u001f]/.test(model))) {
    throw invalidSelection('invalid model');
  }
  if (effort !== null && (typeof effort !== 'string' || effort.length > 32 || !/^[a-z]+$/.test(effort))) {
    throw invalidSelection('invalid reasoning effort');
  }
  if (!model && effort) throw invalidSelection('select a model before setting reasoning effort');
  return { model, reasoningEffort: effort };
}

function normalizeCatalog(entries) {
  const seen = new Set();
  const out = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || entry.hidden === true) continue;
    const model = entry.model || entry.id;
    if (typeof model !== 'string' || !model || seen.has(model)) continue;
    seen.add(model);
    const efforts = [];
    for (const option of Array.isArray(entry.supportedReasoningEfforts) ? entry.supportedReasoningEfforts : []) {
      const reasoningEffort = typeof option === 'string' ? option : option && option.reasoningEffort;
      if (typeof reasoningEffort !== 'string' || efforts.some((candidate) => candidate.reasoningEffort === reasoningEffort)) continue;
      efforts.push({ reasoningEffort, description: typeof option.description === 'string' ? option.description : '' });
    }
    out.push({
      id: entry.id || model,
      model,
      displayName: entry.displayName || model,
      description: entry.description || '',
      isDefault: entry.isDefault === true,
      defaultReasoningEffort: entry.defaultReasoningEffort || null,
      supportedReasoningEfforts: efforts,
      inputModalities: Array.isArray(entry.inputModalities) ? entry.inputModalities : ['text', 'image'],
    });
  }
  return out;
}

function validateSelection(value, catalog) {
  const selection = normalizeSelection(value);
  if (!selection.model) return selection;
  const entry = catalog.find((candidate) => candidate.model === selection.model || candidate.id === selection.model);
  if (!entry) throw invalidSelection('这个模型不在当前 Codex 的模型列表中，请刷新后重新选择。');
  const efforts = entry.supportedReasoningEfforts.map((option) => option.reasoningEffort);
  if (selection.reasoningEffort && !efforts.includes(selection.reasoningEffort)) {
    throw invalidSelection('这个模型不支持所选的思考强度，请重新选择。');
  }
  const defaultEffort = efforts.includes(entry.defaultReasoningEffort) ? entry.defaultReasoningEffort : efforts[0] || null;
  return { model: entry.model, reasoningEffort: selection.reasoningEffort || defaultEffort };
}

/* thread/start and thread/resume take effort through config; turn/start uses effort. */
function threadParams(selection) {
  if (!selection || !selection.model) return {};
  const params = { model: selection.model };
  if (selection.reasoningEffort) params.config = { model_reasoning_effort: selection.reasoningEffort };
  return params;
}

function turnParams(selection) {
  if (!selection || !selection.model) return {};
  return Object.assign({ model: selection.model }, selection.reasoningEffort ? { effort: selection.reasoningEffort } : {});
}

function effectiveModel(settings, thread) {
  const source = settings && (settings.threadSettings || settings);
  const model = (source && source.model) || (thread && thread.model) || null;
  if (!model) return null;
  const effort = source ? (source.effort !== undefined ? source.effort : source.reasoningEffort) : undefined;
  return {
    model,
    reasoningEffort: effort !== undefined ? effort : (thread && thread.reasoningEffort) || null,
  };
}

function loadModelMap(file) {
  const out = Object.create(null);
  if (!file) return out;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const [threadId, value] of Object.entries(raw || {})) {
      try {
        const selection = normalizeSelection(value);
        if (selection.model) out[threadId] = selection;
      } catch (error) {
        // Ignore an invalid saved entry without losing other sessions' choices.
      }
    }
  } catch (error) {}
  return out;
}

function saveModelMap(file, map) {
  if (!file) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.tmp';
  try {
    fs.writeFileSync(temporary, JSON.stringify(map, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) {}
  }
}

module.exports = { normalizeSelection, normalizeCatalog, validateSelection, threadParams, turnParams, effectiveModel, loadModelMap, saveModelMap };
