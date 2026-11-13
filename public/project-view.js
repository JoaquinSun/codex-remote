(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CodexProjectView = factory();
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  function normalizePath(value) {
    if (typeof value !== 'string' || !value) return '';
    return value.replace(/\/+$/, '') || '/';
  }

  function projectForThread(thread, projects) {
    if (!thread) return null;
    const available = Array.isArray(projects) ? projects : [];
    if (thread.projectId) {
      const explicit = available.find((project) => project.id === thread.projectId);
      if (explicit) return explicit;
    }
    const cwd = normalizePath(thread.cwd);
    if (!cwd) return null;
    let match = null;
    let matchedLength = -1;
    for (const project of available) {
      for (const root of project.roots || []) {
        const base = normalizePath(root && root.path);
        if (!base) continue;
        const inside = cwd === base || cwd.startsWith(base === '/' ? '/' : base + '/');
        if (inside && base.length > matchedLength) {
          match = project;
          matchedLength = base.length;
        }
      }
    }
    return match;
  }

  function threadActivity(thread) {
    return Number(thread.updatedAt || thread.createdAt) || 0;
  }

  function workingProjects(threads, projects, options) {
    const activeTurns = options && options.activeTurns || {};
    const waiting = new Set(options && options.waitingThreadIds || []);
    const unique = new Map();
    for (const thread of threads || []) {
      if (thread && thread.id) unique.set(thread.id, thread);
    }
    const groups = new Map();
    for (const thread of unique.values()) {
      if (!(Object.hasOwn(activeTurns, thread.id) && activeTurns[thread.id]) && thread.status?.type !== 'active') continue;
      const project = projectForThread(thread, projects);
      const cwd = normalizePath(thread.cwd);
      const root = project ? normalizePath(project.roots?.[0]?.path) : cwd;
      const key = project ? 'project:' + project.id : 'cwd:' + cwd;
      if (!groups.has(key)) {
        groups.set(key, {
          key,
          name: project ? project.name || '(未命名项目)' : cwd.split('/').filter(Boolean).pop() || '其他任务',
          root,
          threads: [],
          waitingCount: 0,
        });
      }
      const group = groups.get(key);
      group.threads.push(thread);
      if (waiting.has(thread.id)) group.waitingCount += 1;
    }
    for (const group of groups.values()) {
      group.threads.sort((a, b) => threadActivity(b) - threadActivity(a) || String(a.id).localeCompare(String(b.id)));
    }
    const catalog = Array.isArray(projects) ? projects : [];
    const order = new Map(catalog.map((project, index) => ['project:' + project.id, index]));
    return [...groups.values()].sort((a, b) =>
      (order.get(a.key) ?? catalog.length) - (order.get(b.key) ?? catalog.length) || a.key.localeCompare(b.key)
    );
  }

  /* The normal sidebar only loads a recent page. Resolve older active chats
     from list metadata, keeping pagination read-only and caching known chats. */
  async function includeWorkingThreads(firstPage, previousThreads, activeIds, fetchPage) {
    const threads = Array.isArray(firstPage.data) ? firstPage.data.slice() : [];
    const seen = new Set(threads.map((thread) => thread.id));
    const missing = new Set(activeIds);
    for (const id of seen) missing.delete(id);
    for (const thread of previousThreads || []) {
      if (!thread || !missing.has(thread.id)) continue;
      threads.push(thread);
      seen.add(thread.id);
      missing.delete(thread.id);
    }
    let cursor = firstPage.nextCursor;
    const cursors = new Set();
    while (missing.size && cursor && !cursors.has(cursor)) {
      cursors.add(cursor);
      let page;
      try {
        page = await fetchPage(cursor);
      } catch (error) {
        /* A failed background lookup must not discard the recent sidebar. */
        break;
      }
      for (const thread of page.data || []) {
        if (!thread || !missing.has(thread.id) || seen.has(thread.id)) continue;
        threads.push(thread);
        seen.add(thread.id);
        missing.delete(thread.id);
      }
      cursor = page.nextCursor;
    }
    return threads;
  }

  return { projectForThread, workingProjects, includeWorkingThreads };
});
