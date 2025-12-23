#!/usr/bin/env node
const path = require('path');
const { spawn } = require('child_process');

// Get the electron executable path from the installed dependency
const electron = require('electron');

// Launch electron with our main.js, passing through all CLI args
const child = spawn(electron, [path.join(__dirname, '..'), ...process.argv.slice(2)], {
  stdio: 'inherit',
  windowsHide: false
});

child.on('close', (code) => process.exit(code));
