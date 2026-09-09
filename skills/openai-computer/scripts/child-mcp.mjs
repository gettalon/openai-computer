import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

export class ChildMcp {
  constructor({ runtime, runtimeDir, onRequest, capabilities = {} }) {
    this.runtime = runtime;
    this.runtimeDir = runtimeDir;
    this.onRequest = onRequest;
    this.capabilities = capabilities;
    this.nextId = 1;
    this.pending = new Map();
  }

  async start() {
    await mkdir(this.runtimeDir, { recursive: true, mode: 0o700 });
    const { paths, appVersion, nodeModuleDirs } = this.runtime;
    const appResources = paths.node.replace(/\/cua_node\/bin\/node$/, '');
    const env = {
      ...process.env,
      HOME: process.env.HOME ?? homedir(),
      LANG: process.env.LANG ?? 'en_US.UTF-8',
      CODEX_HOME: process.env.CODEX_HOME ?? join(homedir(), '.codex'),
      CODEX_CLI_PATH: paths.codex,
      CUA_REPL_NODE_REPL_PATH: paths.nodeRepl,
      CUA_REPL_ENABLED_SURFACES: 'browser,computer',
      BROWSER_USE_AVAILABLE_BACKENDS: 'chrome,iab',
      BROWSER_USE_CODEX_APP_BUILD_FLAVOR: 'prod',
      BROWSER_USE_CODEX_APP_VERSION: appVersion,
      BROWSER_USE_TINYSKY_ENABLED: '1',
      NODE_REPL_NODE_PATH: paths.node,
      NODE_REPL_NODE_MODULE_DIRS: nodeModuleDirs.join(delimiter),
      NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS: '1500',
      NODE_REPL_TRUSTED_CODE_PATHS: [
        process.env.CODEX_HOME ?? join(homedir(), '.codex'),
        ...nodeModuleDirs,
      ].join(':'),
    };
    const launcher = join(appResources, 'plugins', 'openai-bundled', 'plugins', 'unified-computer-use', 'scripts', 'launch.mjs');

    this.child = spawn(paths.node, [launcher], {
      cwd: this.runtimeDir,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.stderr = '';
    this.child.stderr.on('data', chunk => {
      this.stderr = (this.stderr + chunk.toString()).slice(-16000);
    });
    this.child.once('error', error => this.rejectAll(error));
    this.child.once('exit', (code, signal) => {
      this.rejectAll(new Error(`OpenAI node_repl exited (${signal ?? code}). ${this.stderr}`));
    });

    const lines = createInterface({ input: this.child.stdout });
    lines.on('line', line => this.handleLine(line));

    await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: this.capabilities,
      clientInfo: { name: 'claude-openai-computer', version: '0.1.0' },
    });
    this.notify('notifications/initialized', {});
  }

  handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.stderr = (this.stderr + `\n${line}`).slice(-16000);
      return;
    }

    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
      else waiter.resolve(message.result);
      return;
    }

    if (message.id !== undefined && message.method) {
      Promise.resolve(this.onRequest?.(message))
        .then(result => this.send({ jsonrpc: '2.0', id: message.id, result: result ?? {} }))
        .catch(error => this.send({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32000, message: error?.message ?? String(error) },
        }));
    }
  }

  send(message) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  notify(method, params) {
    this.send({ jsonrpc: '2.0', method, params });
  }

  request(method, params, meta, timeoutMs = 120000) {
    const id = this.nextId++;
    const request = { jsonrpc: '2.0', id, method, params };
    if (meta) request.params = { ...params, _meta: meta };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`OpenAI node_repl request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
      this.send(request);
    });
  }

  tool(name, args, meta, timeoutMs = 120000) {
    return this.request('tools/call', { name, arguments: args }, meta, timeoutMs);
  }

  async stop() {
    if (!this.child || this.child.killed) return;
    this.child.kill('SIGTERM');
    await new Promise(resolve => {
      const timer = setTimeout(() => {
        this.child.kill('SIGKILL');
        resolve();
      }, 5000);
      this.child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    }).catch(() => {});
  }

  rejectAll(error) {
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
  }
}
