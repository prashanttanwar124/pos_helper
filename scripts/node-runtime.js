const fs = require('fs');
const path = require('path');

function exists(filePath) {
  return Boolean(filePath) && fs.existsSync(filePath);
}

function preferredNodePath() {
  const candidates = [
    process.env.NFC_HELPER_NODE_PATH,
    '/usr/local/bin/node',
    '/opt/homebrew/bin/node',
    process.execPath,
  ];

  return candidates.find(exists);
}

function preferredNpmPath(nodePath) {
  const dir = path.dirname(nodePath);
  const npmName = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const npmPath = path.join(dir, npmName);
  return exists(npmPath) ? npmPath : npmName;
}

module.exports = {
  preferredNodePath,
  preferredNpmPath,
};
