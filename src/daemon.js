'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const runFile = promisify(execFile);

function codexHome(environment = process.env) {
  return environment.CODEX_HOME || path.join(os.homedir(), '.codex');
}

function defaultAppServerSocket(environment = process.env) {
  return path.join(codexHome(environment), 'app-server-control', 'app-server-control.sock');
}

function canExecute(filename) {
  try {
    fs.accessSync(filename, fs.constants.X_OK);
    return fs.statSync(filename).isFile();
  } catch {
    return false;
  }
}

function findCodexBinary(environment = process.env, executable = canExecute) {
  if (environment.CODEX_REMOTE_CODEX) {
    if (executable(environment.CODEX_REMOTE_CODEX)) return environment.CODEX_REMOTE_CODEX;
    throw new Error('CODEX_REMOTE_CODEX 指定的 Codex 程序不可执行。');
  }
  /* Use the CLI shipped with the desktop app first. The managed package is
     a fallback for machines whose desktop installation is elsewhere. */
  const candidates = [
    '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
    '/Applications/Codex.app/Contents/Resources/codex',
    path.join(codexHome(environment), 'packages', 'app-server-daemon', 'current', 'bin', 'codex'),
    ...(environment.PATH || '').split(path.delimiter).filter(Boolean).map(directory => path.join(directory, 'codex')),
  ];
  const binary = candidates.find(executable);
  if (!binary) throw new Error('未找到 ChatGPT 的 Codex 数据服务管理程序，请检查桌面 App 是否安装完整。');
  return binary;
}

async function startManagedAppServer(options = {}) {
  const environment = options.environment || process.env;
  const binary = options.binary || findCodexBinary(environment);
  /* This idempotent command restores Codex's shared local daemon. It does
     not restart it, change remote-control settings, or submit a turn. */
  try {
    await (options.runFile || runFile)(binary, ['app-server', 'daemon', 'start'], {
      timeout: 15000,
      maxBuffer: 256 * 1024,
      windowsHide: true,
      env: { ...environment, CODEX_HOME: codexHome(environment) },
    });
  } catch (cause) {
    const detail = cause.killed ? '启动超时' : cause.message;
    throw new Error(`无法启动本地聊天数据服务：${detail}`, { cause });
  }
}

module.exports = { defaultAppServerSocket, findCodexBinary, startManagedAppServer };
