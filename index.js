'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const rootDir = __dirname;
const clientDir = path.join(rootDir, 'client');
const serverDir = path.join(rootDir, 'server');
const isWin = process.platform === 'win32';
const npmCmd = isWin ? 'npm.cmd' : 'npm';
const npxCmd = isWin ? 'npx.cmd' : 'npx';

function log(msg) {
  console.log(`[TPA Launcher] ${msg}`);
}

function loadEnvFile(envPath) {
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eqIndex = line.indexOf('=');
    if (eqIndex === -1) continue;
    const key = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function getLatestMtime(targetPath) {
  if (!fs.existsSync(targetPath)) return 0;
  const stat = fs.statSync(targetPath);
  if (stat.isFile()) return stat.mtimeMs;

  let latest = stat.mtimeMs;
  for (const entry of fs.readdirSync(targetPath, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') {
      continue;
    }
    const childMtime = getLatestMtime(path.join(targetPath, entry.name));
    if (childMtime > latest) latest = childMtime;
  }
  return latest;
}

function runSync(command, args, cwd) {
  const needsShell = isWin && command.endsWith('.cmd');
  log(`Running "${command} ${args.join(' ')}" in ${path.relative(rootDir, cwd) || '.'}`);
  const result = spawnSync(command, args, {
    cwd,
    env: process.env,
    stdio: 'inherit',
    shell: needsShell,
  });

  if (result.error) {
    console.error(`[TPA Launcher] Failed to execute ${command}:`, result.error);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`[TPA Launcher] Command exited with code ${result.status}`);
    process.exit(result.status || 1);
  }
}

function ensureDependencies(dir, name) {
  const nodeModulesDir = path.join(dir, 'node_modules');
  const stampFile = path.join(nodeModulesDir, '.tpa-install-stamp');
  const pkgFile = path.join(dir, 'package.json');
  const forceInstall = process.env.FORCE_INSTALL === 'true';

  const hasNodeModules =
    fs.existsSync(nodeModulesDir) &&
    fs.readdirSync(nodeModulesDir).filter((f) => !f.startsWith('.')).length > 0;

  let needsInstall = forceInstall || !hasNodeModules;

  if (!needsInstall && fs.existsSync(stampFile) && fs.existsSync(pkgFile)) {
    if (fs.statSync(pkgFile).mtimeMs > fs.statSync(stampFile).mtimeMs) {
      needsInstall = true;
    }
  }

  if (needsInstall) {
    log(`Installing ${name} dependencies...`);
    runSync(npmCmd, ['install', '--no-audit', '--no-fund'], dir);
    try {
      fs.writeFileSync(stampFile, new Date().toISOString(), 'utf8');
    } catch {
      // Non-fatal if stamp cannot be written
    }
  }
}

function ensureClientBuild() {
  const distIndex = path.join(clientDir, 'dist', 'index.html');
  const forceBuild = process.env.FORCE_BUILD === 'true';

  let needsBuild = forceBuild || !fs.existsSync(distIndex);
  if (!needsBuild) {
    const distMtime = fs.statSync(distIndex).mtimeMs;
    const latestSrcMtime = Math.max(
      getLatestMtime(path.join(clientDir, 'src')),
      getLatestMtime(path.join(clientDir, 'index.html')),
      getLatestMtime(path.join(clientDir, 'package.json')),
      getLatestMtime(path.join(clientDir, 'vite.config.ts'))
    );
    if (latestSrcMtime > distMtime) {
      needsBuild = true;
    }
  }

  if (needsBuild) {
    log('Building client frontend...');
    runSync(npmCmd, ['run', 'build'], clientDir);
  } else {
    log('Client build is up to date.');
  }
}

function ensureServerBuild() {
  const distIndex = path.join(serverDir, 'dist', 'index.js');
  const prismaClientDir = path.join(serverDir, 'node_modules', '.prisma', 'client');
  const offlineMode = process.env.OFFLINE_MODE !== 'false';
  const forceBuild = process.env.FORCE_BUILD === 'true';

  log('Configuring Prisma schema...');
  runSync(process.execPath, ['prisma/setup.js'], serverDir);

  const schemaMtime = getLatestMtime(path.join(serverDir, 'prisma', 'schema.prisma'));
  const prismaMtime = getLatestMtime(prismaClientDir);
  if (forceBuild || !fs.existsSync(prismaClientDir) || schemaMtime > prismaMtime) {
    log('Generating Prisma client...');
    runSync(npxCmd, ['prisma', 'generate'], serverDir);
  }

  if (offlineMode || process.env.AUTO_DB_PUSH === 'true') {
    log(`Syncing database schema (${offlineMode ? 'SQLite' : 'PostgreSQL'})...`);
    runSync(npxCmd, ['prisma', 'db', 'push'], serverDir);
  }

  let needsBuild = forceBuild || !fs.existsSync(distIndex);
  if (!needsBuild) {
    const distMtime = fs.statSync(distIndex).mtimeMs;
    const latestSrcMtime = Math.max(
      getLatestMtime(path.join(serverDir, 'src')),
      getLatestMtime(path.join(serverDir, 'package.json')),
      getLatestMtime(path.join(serverDir, 'tsconfig.json'))
    );
    if (latestSrcMtime > distMtime) {
      needsBuild = true;
    }
  }

  if (needsBuild) {
    log('Building server backend...');
    runSync(npmCmd, ['run', 'build'], serverDir);
  } else {
    log('Server build is up to date.');
  }
}

function main() {
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor < 20) {
    console.error(
      `[TPA Launcher] Node.js v20+ is required (detected v${process.versions.node}). Please switch the Node.js version to 20 or 22 in your Altare Startup settings.`
    );
    process.exit(1);
  }

  // Load optional root .env first, then server/.env as fallback
  loadEnvFile(path.join(rootDir, '.env'));
  loadEnvFile(path.join(serverDir, '.env'));

  // Default to production + offline SQLite unless explicitly overridden
  if (!process.env.NODE_ENV) process.env.NODE_ENV = 'production';
  if (!process.env.OFFLINE_MODE) process.env.OFFLINE_MODE = 'true';

  log(`Starting The People's Assembly (Node v${process.versions.node})...`);
  ensureDependencies(clientDir, 'client');
  ensureDependencies(serverDir, 'server');
  ensureClientBuild();
  ensureServerBuild();

  const port = process.env.SERVER_PORT || process.env.PORT || '3000';
  log(`Launching server on port ${port}...`);

  const child = spawn(process.execPath, ['dist/index.js'], {
    cwd: serverDir,
    env: process.env,
    stdio: 'inherit',
  });

  const forwardSignal = (signal) => {
    if (!child.killed) {
      child.kill(signal);
    }
  };

  process.on('SIGINT', () => forwardSignal('SIGINT'));
  process.on('SIGTERM', () => forwardSignal('SIGTERM'));

  child.on('exit', (code, signal) => {
    if (signal) {
      process.exit(0);
    }
    process.exit(code ?? 0);
  });
}

main();
