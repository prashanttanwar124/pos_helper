const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { preferredNodePath, preferredNpmPath, preferredPythonPath } = require('./node-runtime');

const rootDir = path.resolve(__dirname, '..');
const nodePath = preferredNodePath();
const npmPath = preferredNpmPath(nodePath);
const nodeDir = path.dirname(path.dirname(nodePath));
const pcscliteBinaryPath = path.join(
  rootDir,
  'node_modules',
  '@pokusew',
  'pcsclite',
  'build',
  'Release',
  'pcsclite.node'
);
const shouldForceRebuild = process.argv.includes('--force');
const shouldReuseExisting = process.argv.includes('--if-needed');

if (!nodePath) {
  console.error('No usable Node runtime found for rebuilding native modules.');
  process.exit(1);
}

if (!shouldForceRebuild && shouldReuseExisting && fs.existsSync(pcscliteBinaryPath)) {
  console.log(`Using existing native helper module at ${pcscliteBinaryPath}`);
  process.exit(0);
}

const env = {
  ...process.env,
  npm_config_cache: path.join(rootDir, '.npm-cache'),
  NFC_HELPER_NODE_PATH: nodePath,
};

if (process.platform !== 'win32') {
  const includeDir = path.join(nodeDir, 'include', 'node');
  if (fs.existsSync(includeDir)) {
    env.npm_config_nodedir = nodeDir;
  }
}

const pythonPath = preferredPythonPath();
if (pythonPath) {
  env.PYTHON = pythonPath;
  env.npm_config_python = pythonPath;
}

const result = spawnSync(
  npmPath,
  ['rebuild', '@pokusew/pcsclite'],
  {
    cwd: rootDir,
    stdio: 'inherit',
    env,
    shell: process.platform === 'win32',
  }
);

if (result.error) {
  console.error(result.error);
  process.exit(1);
}

if (result.status !== 0) {
  process.exit(result.status || 1);
}

console.log(`Rebuilt native helper module using ${nodePath}`);
