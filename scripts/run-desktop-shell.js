#!/usr/bin/env node

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const electronBin = path.join(rootDir, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');
const hasDisplay = Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
const isHeadlessContainer = !hasDisplay && (Boolean(process.env.CI) || fs.existsSync('/.dockerenv') || fs.existsSync('/run/.containerenv'));

function printUsage() {
  console.log('Desktop shell is only supported in a real GUI session or a display-enabled environment.');
  console.log('Use the normal local web app flow instead:');
  console.log('  ./start-local.sh');
  console.log('Or run this on a desktop machine with DISPLAY/WAYLAND_DISPLAY set.');
}

if (!hasDisplay) {
  printUsage();
  process.exit(1);
}

if (!fs.existsSync(electronBin)) {
  console.error('Electron dependency is missing. Run: npm install');
  process.exit(1);
}

const child = spawn(electronBin, ['.'], {
  cwd: rootDir,
  stdio: 'inherit',
  env: {
    ...process.env,
    ELECTRON_ENABLE_LOGGING: '1',
  },
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

child.on('error', (error) => {
  console.error('Failed to launch Electron shell:', error.message);
  process.exit(1);
});

if (process.argv.includes('--check')) {
  console.log('Desktop shell check passed: GUI display detected.');
  process.exit(0);
}
