#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import process from 'node:process';
import { ChildMcp } from './child-mcp.mjs';
import { resolveOpenAiRuntime } from './runtime-resolver.mjs';
import { extractImageBytes, extractScreenshotPath, saveScreenshot } from './screenshot-artifacts.mjs';

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const runtimeRoot = process.env.CLAUDE_PLUGIN_DATA
  ? join(process.env.CLAUDE_PLUGIN_DATA, 'runtime')
  : null;
const sessionMarker = `openai-computer-session-${randomUUID()}`;
const runtimeDir = runtimeRoot
  ? join(runtimeRoot, sessionMarker)
  : await mkdtemp(join(os.tmpdir(), 'openai-computer-'));
const sessionId = `claude-openai-computer-${randomUUID()}`;
let turnId = `turn-${randomUUID()}`;
let clientCapabilities = {};
let child;
let childTools;
let nextHostRequestId = 1;
let stopping = false;
const hostRequests = new Map();

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id, value) {
  send({ jsonrpc: '2.0', id, result: value });
}

function error(id, code, message, data) {
  send({ jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } });
}

function metadata() {
  return {
    'x-codex-turn-metadata': JSON.stringify({
      session_id: sessionId,
      turn_id: turnId,
      thread_source: 'user',
      model: 'none',
    }),
  };
}

function hostRequest(method, params, timeoutMs = 120000) {
  const id = `openai-computer-${nextHostRequestId++}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      hostRequests.delete(id);
      reject(new Error(`Host request timed out: ${method}`));
    }, timeoutMs);
    hostRequests.set(id, {
      resolve: value => { clearTimeout(timer); resolve(value); },
      reject: cause => { clearTimeout(timer); reject(cause); },
    });
    send({ jsonrpc: '2.0', id, method, params });
  });
}

async function handleChildRequest(request) {
  if (request.method === 'roots/list') return { roots: [] };
  if (request.method === 'elicitation/create') {
    if (!clientCapabilities?.elicitation) return { action: 'decline' };
    return hostRequest('elicitation/create', request.params);
  }
  if (request.method === 'sampling/createMessage') {
    throw new Error('OpenAI computer-use never delegates browser work to another model');
  }
  throw new Error(`Unsupported OpenAI browser child request: ${request.method}`);
}

async function ensureChild() {
  if (child) return child;
  await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  const runtime = await resolveOpenAiRuntime();
  const candidate = new ChildMcp({
    runtime,
    runtimeDir,
    onRequest: handleChildRequest,
    capabilities: {
      ...(clientCapabilities?.elicitation ? { elicitation: clientCapabilities.elicitation } : {}),
      roots: { listChanged: false },
    },
  });
  try {
    await candidate.start();
    const listed = await candidate.request('tools/list', {});
    childTools = (listed.tools ?? [])
      .filter(tool => ['js', 'js_reset', 'turn_ended'].includes(tool.name))
      .map(tool => tool.name === 'turn_ended'
        ? { ...tool, _meta: { ...(tool._meta ?? {}), ui: { visibility: [] } } }
        : tool);
    if (!childTools.some(tool => tool.name === 'js') || !childTools.some(tool => tool.name === 'js_reset')) {
      throw new Error('Installed OpenAI computer-use node_repl is missing js/js_reset');
    }
    child = candidate;
    return child;
  } catch (cause) {
    await candidate.stop().catch(() => {});
    throw cause;
  }
}

async function persistScreenshot(code, output) {
  const blocks = output?.content ?? [];
  const requested = extractScreenshotPath(code);
  const saved = [];
  for (const block of blocks) {
    if (block?.type !== 'text' || typeof block.text !== 'string') continue;
    const image = extractImageBytes(block.text);
    if (!image) continue;
    const path = requested ?? defaultArtifactPath(image.ext);
    await saveScreenshot(path, image.bytes);
    block.text = block.text.replace(BLOB_REDACT, `[binary image ${image.bytes.length} bytes saved to ${path}]`);
    saved.push({ path, bytes: image.bytes.length });
  }
  return saved;
}

const BLOB_REDACT = /\{"0":\d{1,3}(?:,"\d+":\d{1,3}){1023,}\}|\{"data":"[A-Za-z0-9+/=]{1368,}"(?:,"[^"]*":"[^"]*")*\}/g;

function appendSavedNotice(output, saved) {
  if (!saved.length) return output;
  const lines = saved.map(s => `Screenshot saved to ${s.path} (${s.bytes} bytes).`);
  const notice = { type: 'text', text: lines.join('\n') };
  if (Array.isArray(output?.content)) return { ...output, content: [...output.content, notice] };
  return output;
}

async function handleRequest(message) {
  const { id, method, params = {} } = message;
  try {
    if (method === 'initialize') {
      clientCapabilities = params.capabilities ?? {};
      result(id, {
        protocolVersion: params.protocolVersion ?? '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'openai-computer', version: '0.1.0' },
        instructions: 'UI automation through a persistent JavaScript session using the initialized OpenAI computer-use CUA API.',
      });
      return;
    }

    if (method === 'ping') {
      result(id, {});
      return;
    }

    if (method === 'tools/list') {
      await ensureChild();
      result(id, { tools: childTools });
      return;
    }

    if (method === 'tools/call') {
      if (!['js', 'js_reset', 'turn_ended'].includes(params.name)) {
        error(id, -32602, `Unknown OpenAI computer-use tool: ${params.name}`);
        return;
      }
      const active = await ensureChild();
      if (params.name === 'turn_ended') {
        const output = await active.tool('turn_ended', {
          hook_event_name: params.arguments?.hook_event_name || 'Stop',
          session_id: sessionId,
          turn_id: turnId,
        }, metadata(), 30000);
        turnId = `turn-${randomUUID()}`;
        result(id, output);
        return;
      }
      const output = await active.tool(params.name, params.arguments ?? {}, metadata());
      const saved = await persistScreenshot(params.arguments?.code, output);
      result(id, saved ? appendSavedNotice(output, saved) : output);
      return;
    }

    error(id, -32601, `Method not found: ${method}`);
  } catch (cause) {
    error(id, -32000, cause?.message ?? String(cause));
  }
}

async function shutdown() {
  if (stopping) return;
  stopping = true;
  for (const waiter of hostRequests.values()) waiter.reject(new Error('OpenAI computer-use proxy stopped'));
  hostRequests.clear();
  if (child) {
    await child.tool('turn_ended', {
      hook_event_name: 'SessionEnd',
      session_id: sessionId,
      turn_id: turnId,
    }, metadata(), 10000).catch(() => {});
    await child.stop().catch(() => {});
  }
  await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
  if (runtimeRoot) await rm(runtimeRoot, { recursive: false }).catch(() => {});
}

const input = createInterface({ input: process.stdin });
input.on('line', line => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  if (message.id !== undefined && !message.method) {
    const waiter = hostRequests.get(message.id);
    if (!waiter) return;
    hostRequests.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
    else waiter.resolve(message.result);
    return;
  }

  if (message.id !== undefined && message.method) {
    void handleRequest(message);
  }
});
input.once('close', () => shutdown().finally(() => process.exit(0)));
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => shutdown().finally(() => process.exit(0)));
}
