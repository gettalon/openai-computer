import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bundle = join(root, 'skills', 'openai-computer');

async function json(path) {
  return JSON.parse(await readFile(join(root, path), 'utf8'));
}

test('bundle contains one valid skill and its MCP server', async () => {
  const skill = await readFile(join(bundle, 'SKILL.md'), 'utf8');
  assert.match(skill, /^---\nname: openai-computer\ndescription: .+\n---/);
  const mcp = await json('skills/openai-computer/.mcp.json');
  assert.equal(mcp.mcpServers['openai-computer'].command, 'node');
  assert.deepEqual(mcp.mcpServers['openai-computer'].args, ['${CLAUDE_PLUGIN_ROOT}/scripts/proxy-server.mjs']);
});

test('plugin metadata is portable and points at the bundle skill', async () => {
  const plugin = await json('skills/openai-computer/.claude-plugin/plugin.json');
  assert.equal(plugin.name, 'openai-computer');
  assert.equal(plugin.version, '0.1.0');
  assert.deepEqual(plugin.skills, ['./']);
  assert.doesNotMatch(JSON.stringify(plugin), /@|\/Users\//);
});

test('child spawns with full banner and sky trusted service', async () => {
  const child = await readFile(join(bundle, 'scripts', 'child-mcp.mjs'), 'utf8');
  assert.match(child, /banner\.js/);
  assert.doesNotMatch(child, /banner-browser\.js/);
  assert.match(child, /sky.*@oai\/sky\/service/);
  assert.match(child, /computer-description\.md/);
});

test('probe verifies the computer surface, not browser tabs', async () => {
  const probe = await readFile(join(bundle, 'scripts', 'probe.mjs'), 'utf8');
  assert.match(probe, /GETAPP=/);
  assert.match(probe, /cua\.getApp/);
});

test('skill, readme, and security docs contain no local-only paths', async () => {
  const files = ['skills/openai-computer/SKILL.md', 'README.md', 'SECURITY.md', 'tests/proxy-live.py'];
  for (const file of files) {
    const text = await readFile(join(root, file), 'utf8');
    assert.doesNotMatch(text, /\/Users\/hunter|iclass\.one/);
  }
});

test('screenshot helper recovers image bytes and requested path', async () => {
  const { extractImageBytes, extractScreenshotPath } = await import(
    '../skills/openai-computer/scripts/screenshot-artifacts.mjs'
  );
  const blob = {};
  for (let i = 0; i < 1500; i += 1) blob[String(i)] = i % 256;
  blob['0'] = 0xff;
  blob['1'] = 0xd8;
  blob['2'] = 0xff;
  assert.equal(
    extractScreenshotPath('await app.screenshot({ path: "/tmp/shot.png" })'),
    '/tmp/shot.png',
  );
  assert.equal(extractScreenshotPath('await app.getAXState()'), null);
  assert.equal(extractImageBytes(`ok ${JSON.stringify(blob)} done`).bytes.length, 1500);
  assert.equal(extractImageBytes('no image payload here'), null);
  assert.equal(extractImageBytes(JSON.stringify({ 0: 1, 1: 2 })), null, 'too-small blobs are rejected');
});
