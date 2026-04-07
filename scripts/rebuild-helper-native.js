const { spawnSync } = require('child_process');
const path = require('path');
const { preferredNodePath, preferredNpmPath } = require('./node-runtime');

const rootDir = path.resolve(__dirname, '..');
const nodePath = preferredNodePath();
const npmPath = preferredNpmPath(nodePath);

if (!nodePath) {
  console.error('No usable Node runtime found for rebuilding native modules.');
  process.exit(1);
}

const result = spawnSync(
  npmPath,
  ['rebuild', '@pokusew/pcsclite'],
  {
    cwd: rootDir,
    stdio: 'inherit',
    env: {
      ...process.env,
      npm_config_cache: path.join(rootDir, '.npm-cache'),
      npm_config_nodedir: '/usr/local',
      NFC_HELPER_NODE_PATH: nodePath,
    },
  }
);

if (result.status !== 0) {
  process.exit(result.status || 1);
}

console.log(`Rebuilt native helper module using ${nodePath}`);
