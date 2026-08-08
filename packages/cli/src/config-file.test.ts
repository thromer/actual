import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { resolveConfig } from './config';

// Unlike config.test.ts, these tests run against the real cosmiconfig so they
// cover where the config file is actually looked for.
describe('config file discovery', () => {
  const envKeys = [
    'ACTUAL_SERVER_URL',
    'ACTUAL_PASSWORD',
    'ACTUAL_SESSION_TOKEN',
    'ACTUAL_SYNC_ID',
    'ACTUAL_DATA_DIR',
    'ACTUAL_ENCRYPTION_PASSWORD',
    'ACTUAL_CACHE_TTL',
    'ACTUAL_LOCK_TIMEOUT',
    'ACTUAL_NO_LOCK',
    'XDG_CONFIG_HOME',
  ];
  const savedEnv: Record<string, string | undefined> = {};
  const savedCwd = process.cwd();

  let root: string;
  let globalConfigDir: string;

  beforeEach(() => {
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }

    root = mkdtempSync(join(tmpdir(), 'actual-cli-config-'));
    // env-paths reads XDG_CONFIG_HOME on every call, so this relocates the
    // directory cosmiconfig treats as the global config dir.
    process.env.XDG_CONFIG_HOME = join(root, 'xdg');
    globalConfigDir = join(root, 'xdg', 'actual');
    mkdirSync(globalConfigDir, { recursive: true });
    writeFileSync(
      join(globalConfigDir, 'config.json'),
      JSON.stringify({ serverUrl: 'http://global', password: 'globalpw' }),
    );
  });

  afterEach(() => {
    process.chdir(savedCwd);
    for (const key of envKeys) {
      if (savedEnv[key] !== undefined) {
        process.env[key] = savedEnv[key];
      } else {
        delete process.env[key];
      }
    }
    rmSync(root, { recursive: true, force: true });
  });

  it('reads the global config file from an unrelated directory', async () => {
    const workDir = join(root, 'work');
    mkdirSync(workDir);
    process.chdir(workDir);

    const config = await resolveConfig({});

    expect(config.serverUrl).toBe('http://global');
    expect(config.password).toBe('globalpw');
  });

  it('reads the global config file when the cwd is the global config dir', async () => {
    process.chdir(globalConfigDir);

    const config = await resolveConfig({});

    expect(config.serverUrl).toBe('http://global');
    expect(config.password).toBe('globalpw');
  });

  it('reads the global config file when the cwd is inside the global config dir', async () => {
    const nested = join(globalConfigDir, 'nested');
    mkdirSync(nested);
    process.chdir(nested);

    const config = await resolveConfig({});

    expect(config.serverUrl).toBe('http://global');
    expect(config.password).toBe('globalpw');
  });
});
