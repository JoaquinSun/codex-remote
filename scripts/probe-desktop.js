'use strict';

/* Read-only desktop diagnostics: no messages, task interruption, or window
   navigation. Pass an existing chat id to inspect ownership and model state. */
const { DesktopConnection } = require('../src/desktop');

async function main() {
  const connection = new DesktopConnection();
  try {
    await connection.connect();
    console.log('ChatGPT desktop IPC connected:', connection.socketPath);
    const threadId = process.argv[2];
    if (!threadId) return;
    const owner = await connection.findOwner(threadId);
    if (!owner) {
      console.log('This chat is not currently owned by a desktop window.');
      return;
    }
    console.log('Desktop chat owner found.');
    const result = await connection.callThread(threadId, 'thread-follower-read-model-settings', {}, owner);
    console.log('Desktop model:', result?.settings?.model || '(unspecified)');
    console.log('Reasoning effort:', result?.settings?.reasoningEffort || '(default)');
    const state = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Desktop state subscription timed out')), 5000);
      connection.once('state', (id, value) => { clearTimeout(timer); resolve(value); });
    });
    connection.follow(threadId, owner.clientId);
    const snapshot = await state;
    console.log('Desktop runtime status:', snapshot.threadRuntimeStatus?.type || '(unknown)');
    console.log('Pending desktop requests:', snapshot.requests?.length || 0);
    console.log('History excluded from subscription cache:', !Object.hasOwn(snapshot, 'turnHistory') && !Object.hasOwn(snapshot, 'turns'));
  } finally {
    connection.close();
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
