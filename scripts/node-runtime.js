const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const rootDir = path.resolve(__dirname, '..');

function exists(filePath) {
  return Boolean(filePath) && fs.existsSync(filePath);
}

function commandOnPath(command, args = ['--version']) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });

  if (result.error || result.status !== 0) {
    return null;
  }

  if (args.length === 1 && args[0] === '--version') {
    return command;
  }

  return String(result.stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || null;
}

function preferredNodePath() {
  const nodeName = process.platform === 'win32' ? 'node.exe' : 'node';
  const candidates = [
    process.env.NFC_HELPER_NODE_PATH,
    path.join(rootDir, '.tooling', 'node', nodeName),
    path.join(rootDir, '.tooling', 'node-x64', nodeName),
    path.join(rootDir, '.tooling', 'node-win-x64', nodeName),
    '/usr/local/bin/node',
    '/opt/homebrew/bin/node',
    process.execPath,
  ];

  return candidates.find(exists) || commandOnPath(
    process.platform === 'win32' ? 'where' : 'which',
    ['node']
  );
}

function preferredNpmPath(nodePath) {
  const dir = path.dirname(nodePath);
  const npmName = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const npmPath = path.join(dir, npmName);
  return exists(npmPath) ? npmPath : npmName;
}

function preferredPythonPath() {
  const candidates = [
    process.env.PYTHON,
    path.join(rootDir, '.tooling', 'python', process.platform === 'win32' ? 'python.exe' : 'bin/python3'),
    path.join(rootDir, '.tooling', 'python3', process.platform === 'win32' ? 'python.exe' : 'bin/python3'),
  ];

  const existing = candidates.find(exists);
  if (existing) {
    return existing;
  }

  if (process.platform === 'win32') {
    return commandOnPath('where', ['python']) || commandOnPath('where', ['py']);
  }

  return commandOnPath('which', ['python3']) || commandOnPath('which', ['python']);
}

module.exports = {
  preferredNodePath,
  preferredNpmPath,
  preferredPythonPath,
};
