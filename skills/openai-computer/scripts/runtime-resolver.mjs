import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function registryPath() {
  return join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'chrome-native-hosts-v2.json');
}

async function exists(path) {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function sha256(path) {
  const contents = await readFile(path);
  return createHash('sha256').update(contents).digest('hex');
}

function isCompatible(entry) {
  return entry?.schemaVersion === 2
    && entry?.nativeHostProtocolVersion === 2
    && entry?.appServerProtocolVersion === 2
    && entry?.channel === 'prod'
    && entry?.extensionIds?.includes('hehggadaopoacecdllhhajmbjkdcmajg')
    && entry?.paths;
}

export async function resolveOpenAiRuntime(overridePath) {
  if (process.platform !== 'darwin') {
    throw new Error('OpenAI Chrome runtime discovery is currently supported only on macOS');
  }
  const REGISTRY_PATH = overridePath ?? registryPath();
  let registry;
  try {
    registry = JSON.parse(await readFile(REGISTRY_PATH, 'utf8'));
  } catch {
    throw new Error(`Unable to read OpenAI Chrome runtime registry at ${REGISTRY_PATH}`);
  }
  if (!registry || !Array.isArray(registry.entries)) {
    throw new Error(`Unexpected OpenAI Chrome runtime registry format at ${REGISTRY_PATH}`);
  }
  const candidates = (registry.entries ?? [])
    .filter(isCompatible)
    .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));

  for (const entry of candidates) {
    const paths = entry.paths;
    const required = {
      codex: paths.codexCliPath,
      node: paths.nodePath,
      nodeRepl: paths.nodeReplPath,
      browserClient: paths.browserClientPath,
      browserService: paths.browserServicePath,
    };

    if ((await Promise.all(Object.values(required).map(exists))).every(Boolean)) {
      const pluginRoot = paths.browserClientPath.replace(/\/scripts\/browser-client\.mjs$/, '');
      const pluginManifest = join(pluginRoot, '.codex-plugin', 'plugin.json');
      const apiManifest = join(pluginRoot, 'docs', 'api.json');
      const metadata = await readFile(pluginManifest, 'utf8').then(JSON.parse).catch(() => ({}));

      return {
        registryPath: REGISTRY_PATH,
        appVersion: entry.appVersion,
        pluginVersion: metadata.version ?? null,
        nodeModuleDirs: paths.nodeModuleDirs ?? [],
        paths: { ...required, pluginManifest, apiManifest },
        hashes: {
          browserClient: await sha256(required.browserClient),
          browserService: await sha256(required.browserService),
          nodeRepl: await sha256(required.nodeRepl),
          codex: await sha256(required.codex),
          apiManifest: await sha256(apiManifest),
        },
      };
    }
  }

  throw new Error(`No compatible OpenAI Chrome runtime found in ${REGISTRY_PATH}`);
}
