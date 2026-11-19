const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const crypto = require('node:crypto');

const args = process.argv.slice(2);
const option = name => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const branch = option('branch');
const appPort = Number(option('port') || process.env.PORT || 3000);
const displayName = option('name');
const watch = args.includes('--watch');

if (!Number.isInteger(appPort) || appPort < 1 || appPort > 65535) {
  console.error('Port must be a number between 1 and 65535.');
  process.exit(1);
}
if (branch && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(branch)) {
  console.error('Branch name must use letters, numbers, and single hyphens.');
  process.exit(1);
}

const rootEnvPath = path.join(__dirname, '.env');
const baseConfig = { ...dotenv.parse(fs.existsSync(rootEnvPath) ? fs.readFileSync(rootEnvPath) : ''), ...process.env };
const branchDirectory = branch ? path.join(__dirname, '.branches', branch.toLowerCase()) : null;
const branchEnvPath = branchDirectory && path.join(branchDirectory, '.env');
let config = baseConfig;

if (branchDirectory) {
  fs.mkdirSync(branchDirectory, { recursive: true });
  if (!fs.existsSync(branchEnvPath)) {
    const branchLabel = displayName || branch.split('-').map(word => word[0].toUpperCase() + word.slice(1)).join(' ');
    const generatedPassword = process.env.BRANCH_INITIAL_ADMIN_PASSWORD || crypto.randomBytes(18).toString('base64url');
    config = {
      ...baseConfig,
      PORT: String(appPort),
      SESSION_SECRET: crypto.randomBytes(48).toString('base64url'),
      ADMIN_EMAIL: baseConfig.ADMIN_EMAIL || `admin@${branch.toLowerCase()}.local`,
      ADMIN_PASSWORD: generatedPassword,
      PHARMACY_NAME: `${baseConfig.PHARMACY_NAME || 'Pharmacy'} - ${branchLabel}`,
      BRANCH_DIRECTORY: '[]'
    };
    const allowedKeys = new Set(['PORT', 'NODE_ENV', 'SESSION_SECRET', 'COOKIE_SECURE', 'ADMIN_NAME', 'ADMIN_EMAIL', 'ADMIN_PASSWORD', 'PHARMACY_NAME', 'PHARMACY_ADDRESS', 'PHARMACY_PHONE', 'CURRENCY', 'BRANCH_NETWORK_TOKEN', 'BRANCH_DIRECTORY']);
    const content = Object.entries(config)
      .filter(([key]) => allowedKeys.has(key))
      .map(([key, value]) => `${key}=${JSON.stringify(String(value))}`)
      .join('\n') + '\n';
    fs.writeFileSync(branchEnvPath, content, { flag: 'wx' });
    console.log(`Created independent local branch: ${branchLabel}`);
    console.log(`Initial administrator: ${config.ADMIN_EMAIL}`);
    console.log(`Initial password (save it now): ${generatedPassword}`);
  } else {
    config = { ...baseConfig, ...dotenv.parse(fs.readFileSync(branchEnvPath)) };
  }
}

const databasePort = 55432 + appPort - 3000;
if (databasePort < 1 || databasePort > 65535) {
  console.error('Derived local database port is invalid. Use an app port between 1 and 41023.');
  process.exit(1);
}
const pgliteServer = path.join(__dirname, 'node_modules', '@electric-sql', 'pglite-socket', 'dist', 'scripts', 'server.js');
const databasePath = branchDirectory
  ? path.join(branchDirectory, 'database')
  : path.join(__dirname, '.local-db');
const childEnv = { ...config, PORT: String(appPort) };
childEnv.LOCAL_PGLITE = 'true';
childEnv.LOCAL_BRANCH_PROVISIONING = 'true';
childEnv.LOCAL_MAIN_SITE_URL = baseConfig.LOCAL_MAIN_SITE_URL || `http://localhost:${Number(baseConfig.PORT || 3000)}`;
childEnv.LOCAL_MAIN_SITE_NAME = baseConfig.LOCAL_MAIN_SITE_NAME || baseConfig.PHARMACY_NAME || 'Main pharmacy';
if (branch) {
  childEnv.LOCAL_BRANCH_NAME = branch.toLowerCase();
  delete childEnv.BRANCH_INITIAL_ADMIN_PASSWORD;
  const branchLabel = displayName || branch.split('-').map(word => word[0].toUpperCase() + word.slice(1)).join(' ');
  fs.writeFileSync(path.join(branchDirectory, 'branch.json'), JSON.stringify({ id: branch.toLowerCase(), name: branchLabel, port: appPort }, null, 2) + '\n');
} else {
  delete childEnv.LOCAL_BRANCH_NAME;
}
const appCommand = watch ? 'node --watch server.js' : 'node server.js';
const child = spawn(process.execPath, [
  pgliteServer,
  `--db=${databasePath}`,
  `--port=${databasePort}`,
  `--run=${appCommand}`,
  '--include-database-url'
], { stdio: 'inherit', cwd: __dirname, env: childEnv });

child.on('error', error => {
  console.error('Could not start the local database:', error.message);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
