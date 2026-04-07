const fs = require('fs');
const path = require('path');
const { preferredNodePath } = require('./node-runtime');

const rootDir = path.resolve(__dirname, '..');
const outputDir = path.join(rootDir, '.desktop-runtime');
const runtimeDir = path.join(outputDir, 'runtime');
const helperDir = path.join(outputDir, 'helper');
const nodeTargetName = process.platform === 'win32' ? 'node.exe' : 'node';
const nodeTargetPath = path.join(runtimeDir, nodeTargetName);

function resetDir(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
  fs.mkdirSync(dirPath, { recursive: true });
}

resetDir(outputDir);
fs.mkdirSync(runtimeDir, { recursive: true });
fs.mkdirSync(helperDir, { recursive: true });

const nodeSourcePath = preferredNodePath();

if (!nodeSourcePath) {
  throw new Error('No usable Node runtime found for desktop packaging.');
}

fs.copyFileSync(nodeSourcePath, nodeTargetPath);

for (const file of ['index.js', 'package.json', 'package-lock.json']) {
  const sourcePath = path.join(rootDir, file);
  if (fs.existsSync(sourcePath)) {
    fs.copyFileSync(sourcePath, path.join(helperDir, file));
  }
}

fs.cpSync(path.join(rootDir, 'node_modules'), path.join(helperDir, 'node_modules'), {
  recursive: true,
});

if (process.platform !== 'win32') {
  fs.chmodSync(nodeTargetPath, 0o755);
}

console.log(`Prepared desktop runtime in ${outputDir} using ${nodeSourcePath}`);
