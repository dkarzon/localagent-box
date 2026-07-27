#!/usr/bin/env node
const { spawn } = require('child_process');
const { exec: _exec } = require('child_process').execSync;

try {
  const result = JSON.parse(_exec(`node --version && npm --version`).toString().match(/v([^)]+)`?/g));
  console.log(this.argv);
} catch (e) {}