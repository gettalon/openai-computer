import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdir, readFile } from 'node:fs/promises';
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
    const cuaResources = join(appResources, 'plugins', 'openai-bundled', 'plugins', 'unified-computer-use', 'resources');
    const [banner, baseDescription, browserDescription, computerDescription, outputDescription, resetDescription] = await Promise.all([
      readFile(join(cuaResources, 'banner.js'), 'utf8'),
      readFile(join(cuaResources, 'js-tool-description.md'), 'utf8'),
      readFile(join(cuaResources, 'browser-description.md'), 'utf8'),
      readFile(join(cuaResources, 'computer-description.md'), 'utf8'),
      readFile(join(cuaResources, 'js-output-description.md'), 'utf8'),
      readFile(join(cuaResources, 'js-reset.md'), 'utf8'),
    ]);
    const env = {
      HOME: process.env.HOME,
      USER: process.env.USER,
      LOGNAME: process.env.LOGNAME,
      LANG: process.env.LANG ?? 'en_US.UTF-8',
      SHELL: '/bin/zsh',
      PATH: '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
      TMPDIR: this.runtimeDir,
      CODEX_HOME: process.env.CODEX_HOME ?? join(homedir(), '.codex'),
      CODEX_CLI_PATH: paths.codex,
      NODE_REPL_NODE_PATH: paths.node,
      NODE_REPL_NODE_MODULE_DIRS: nodeModuleDirs.join(delimiter),
      NODE_REPL_TRUSTED_CODE_PATHS: [
        process.env.CODEX_HOME ?? join(homedir(), '.codex'),
        // --disable-sandbox below applies only to the inner Node REPL inside the signed Codex sandbox.
        ...nodeModuleDirs,
      ].join(':'),
      NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS: '1500',
      NODE_REPL_TRUSTED_SERVICES: JSON.stringify({ browser: paths.browserService, sky: '@oai/sky/service' }),
      NODE_REPL_JS_BANNER: banner,
      NODE_REPL_TOOL_OVERRIDES: JSON.stringify({
        server_instructions: 'UI automation through a persistent JavaScript session using the initialized OpenAI computer-use CUA API.',
        tools: {
          js: {
            description: [baseDescription, browserDescription, computerDescription, outputDescription].join('\n\n'),
            field_descriptions: { code: 'JavaScript to execute using the initialized OpenAI computer-use CUA runtime.' },
          },
          js_reset: { description: resetDescription },
        },
      }),
      BROWSER_USE_AVAILABLE_BACKENDS: 'chrome,iab',
      BROWSER_USE_CODEX_APP_BUILD_FLAVOR: 'prod',
      BROWSER_USE_CODEX_APP_VERSION: appVersion,
      BROWSER_USE_TINYSKY_ENABLED: '1',
    };

    this.child = spawn(paths.codex, [
      'sandbox',
      '-c', 'sandbox_mode="workspace-write"',
      '-c', 'shell_environment_policy.inherit="all"',
      '-c', `sandbox_workspace_write.writable_roots=[${JSON.stringify(env.CODEX_HOME)}]`,
      '--allow-unix-socket', '/tmp/codex-browser-use',
      '--', paths.nodeRepl, '--disable-sandbox',
    ], {
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
