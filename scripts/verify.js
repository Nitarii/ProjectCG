'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const checks = [
  ['--check', 'server.js'],
  ['--check', 'src/server/index.js'],
  ['--check', 'src/server/config/map.js'],
  ['--check', 'src/server/config/catalog.js'],
  ['--check', 'src/server/net/simple-ws.js'],
  ['--check', 'src/server/core/spatial-hash.js'],
  ['--check', 'src/server/core/fixed-loop.js'],
  ['--check', 'src/server/persistence/profile-store.js'],
  ['--check', 'scripts/stress-local.js'],
  ['--check', 'scripts/test-network.js'],
  ['--check', 'public/js/game.js'],
];
for (const args of checks) {
  const r = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status || 1);
}

// Les self-tests ne doivent jamais modifier la vraie progression locale.
const profilePath = path.join(root, 'data', 'profiles.json');
const hadProfile = fs.existsSync(profilePath);
const profileBackup = hadProfile ? fs.readFileSync(profilePath) : null;
let status = 1;
try {
  const self = spawnSync(process.execPath, ['server.js'], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, PROJECTPC_VERIFY_GEOMETRY:'1', PROJECTPC_VERIFY_ONLY:'1' }
  });
  status = self.status == null ? 1 : self.status;
} finally {
  if (hadProfile) fs.writeFileSync(profilePath, profileBackup);
  else if (fs.existsSync(profilePath)) fs.unlinkSync(profilePath);
}
if (status !== 0) process.exit(status);
const net = spawnSync(process.execPath, ['scripts/test-network.js'], {cwd:root,stdio:'inherit'});
if(net.status !== 0)process.exit(net.status||1);
console.log('ProjectPC verify: OK');
