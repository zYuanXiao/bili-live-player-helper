'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..', 'extension');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const packageInfo = JSON.parse(fs.readFileSync(path.join(root, '..', 'package.json'), 'utf8'));
if (manifest.version !== packageInfo.version) throw new Error('Package and extension versions must match');
for (const file of fs.readdirSync(root).filter(name => name.endsWith('.js'))) {
  new vm.Script(fs.readFileSync(path.join(root, file), 'utf8'), { filename: file });
  console.log(`Syntax OK: ${file}`);
}
const popup = fs.readFileSync(path.join(root, manifest.action.default_popup), 'utf8');
const required = new Set(['manifest.json', manifest.background.service_worker, manifest.action.default_popup,
  ...manifest.content_scripts.flatMap(entry => entry.js), ...Object.values(manifest.icons),
  ...Object.values(manifest.action.default_icon), ...Array.from(popup.matchAll(/(?:src|href)="([^"]+)"/g), match => match[1])]);
for (const file of required) {
  const asset = path.resolve(root, file);
  if (!asset.startsWith(root + path.sep) || !fs.statSync(asset).isFile()) throw new Error(`Invalid package asset: ${file}`);
}
function walk(directory) {
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    const asset = path.join(directory, item.name);
    if (item.isSymbolicLink()) throw new Error(`Symlink not allowed: ${asset}`);
    if (item.isDirectory()) walk(asset);
    else if (!required.has(path.relative(root, asset).split(path.sep).join('/'))) throw new Error(`Unreferenced extension asset: ${asset}`);
  }
}
walk(root);
const allowedHosts = new Set(['https://live.bilibili.com/*', 'https://api.live.bilibili.com/*', 'https://www.bilibili.com/blackboard/live/live-activity-player.html*']);
if (manifest.manifest_version !== 3 || JSON.stringify(manifest.permissions) !== '["storage"]' || manifest.host_permissions.some(host => !allowedHosts.has(host))) throw new Error('Unexpected manifest permissions');
console.log('Manifest and packaged assets OK');
