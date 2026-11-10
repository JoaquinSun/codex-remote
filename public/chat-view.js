(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CodexChatView = factory();
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  const TOOL_TYPES = new Set([
    'commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall',
    'collabToolCall', 'webSearch', 'imageView', 'imageGeneration', 'functionCallOutput',
  ]);

  function isAnswer(item) {
    return item.type === 'agentMessage' && (
      item.phase === 'final_answer' || item.phase === 'partial_answer' ||
      (Array.isArray(item.questions) && item.questions.length > 0)
    );
  }

  /* Older providers omit phase. Keep their last reply visible, while putting
     messages followed by more tool work into the execution history. */
  function legacyAnswers(items) {
    const answers = new Set();
    let start = 0;
    function finish(end) {
      let candidate = -1;
      let explicit = -1;
      for (let index = start; index < end; index += 1) {
        const item = items[index];
        if (isAnswer(item)) explicit = index;
        if (item.type === 'agentMessage' && !item.phase) candidate = index;
      }
      if (candidate > explicit && !items.slice(candidate + 1, end).some((item) => TOOL_TYPES.has(item.type))) {
        answers.add(candidate);
      }
    }
    for (let index = 0; index <= items.length; index += 1) {
      if (index === items.length || items[index].type === 'userMessage' || items[index].type === 'localEcho') {
        finish(index);
        start = index + 1;
      }
    }
    return answers;
  }

  function groupTurnItems(value) {
    const items = (Array.isArray(value) ? value : []).filter((item) => item && typeof item === 'object');
    const legacy = legacyAnswers(items);
    const groups = [];
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      const visible = item.type === 'userMessage' || item.type === 'localEcho' || item.type === 'plan' ||
        item.type === 'exitedReviewMode' || isAnswer(item) || legacy.has(index);
      if (visible) {
        groups.push({ type: 'message', item });
        continue;
      }
      const previous = groups[groups.length - 1];
      if (previous && previous.type === 'activity') previous.items.push(item);
      else groups.push({ type: 'activity', key: String(item.id || 'item-' + index), items: [item] });
    }
    return groups;
  }

  function failedItem(item) {
    return item.status === 'failed' || item.status === 'declined' || item.success === false || Boolean(item.error) ||
      (item.type === 'commandExecution' && item.exitCode != null && item.exitCode !== 0);
  }

  function activeLabel(item) {
    if (!item) return '正在处理';
    if (item.type === 'commandExecution') {
      const action = (item.commandActions || []).find((candidate) => candidate && candidate.type !== 'unknown');
      if (action && action.type === 'read') return '正在读取文件';
      if (action && action.type === 'search') return '正在搜索内容';
      if (action && action.type === 'listFiles') return '正在查看文件';
      return '正在执行命令';
    }
    if (item.type === 'fileChange') return '正在修改文件';
    if (item.type === 'webSearch') return '正在搜索网页';
    if (item.type === 'reasoning') return '正在思考';
    if (item.type === 'mcpToolCall' || item.type === 'dynamicToolCall' || item.type === 'collabToolCall') return '正在调用工具';
    return '正在处理';
  }

  function activitySummary(items, options) {
    const running = Boolean(options && options.running);
    let commands = 0;
    let tools = 0;
    let failures = 0;
    const files = new Set();
    let commentary = '';
    let current = null;
    for (const item of items) {
      if (item.type === 'commandExecution') commands += 1;
      else if (item.type === 'fileChange') {
        for (const change of item.changes || []) if (change && change.path) files.add(change.path);
      } else if (TOOL_TYPES.has(item.type)) tools += 1;
      if (failedItem(item)) failures += 1;
      if (item.type === 'agentMessage' && item.text) commentary = String(item.text).replace(/\s+/g, ' ').trim();
      if (item.status === 'inProgress' || item.type === 'reasoning') current = item;
    }
    const counts = [];
    if (commands) counts.push(commands + ' 次执行');
    if (files.size) counts.push(files.size + ' 个文件');
    if (tools) counts.push(tools + ' 次工具调用');
    if (failures) counts.push(failures + ' 个步骤失败');
    const interrupted = options && options.status === 'interrupted';
    const failed = failures > 0 || (options && options.status === 'failed');
    return {
      label: running ? activeLabel(current) : interrupted ? '已中断 · 执行过程' : '执行过程',
      counts: counts.join(' · ') || '思考与进度',
      preview: running ? commentary.slice(0, 120) : '',
      icon: running ? '◐' : failed ? '!' : interrupted ? '○' : '✓',
      failed,
      running,
    };
  }

  return { groupTurnItems, activitySummary, failedItem };
});
