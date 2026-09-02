#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync, execSync } = require('child_process');

const PROGRAM = 'codex-profile';
const VERSION = '0.9.1';

// Cross-platform directories
const HOME = os.homedir();
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

const CODEX_PROFILE_CONFIG_HOME = process.env.CODEX_PROFILE_CONFIG_HOME ||
  (IS_WIN
    ? path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), 'codex-profile')
    : (process.env.XDG_CONFIG_HOME ? path.join(process.env.XDG_CONFIG_HOME, 'codex-profile') : path.join(HOME, '.config', 'codex-profile')));

const CODEX_PROFILE_LAUNCHER_ROOT = process.env.CODEX_PROFILE_LAUNCHER_ROOT ||
  (IS_WIN
    ? path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'codex-profile')
    : (IS_MAC ? path.join(HOME, 'Applications') : path.join(HOME, '.local', 'share', 'applications')));

const WORKSPACE_REGISTRY = path.join(CODEX_PROFILE_CONFIG_HOME, 'workspaces.tsv');
const WORKSPACE_GUARD_FILE = path.join(CODEX_PROFILE_CONFIG_HOME, 'guard-mode');
const LAUNCHER_STATE_DIR = path.join(CODEX_PROFILE_CONFIG_HOME, 'launchers');

function die(msg) {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

function note(msg) {
  console.log(msg);
}

function warn(msg) {
  console.error(`Warning: ${msg}`);
}

function isValidProfileName(profile) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(profile);
}

function validateProfile(profile) {
  if (!profile || !isValidProfileName(profile)) {
    die(`Invalid profile '${profile}'. Use letters, numbers, dots, dashes, or underscores.`);
  }
}

function codexHomeForProfile(profile) {
  validateProfile(profile);
  if (profile === 'default') {
    return path.join(HOME, '.codex');
  }
  return path.join(HOME, `.codex-${profile}`);
}

function ensureDir(dirPath) {
  try {
    if (fs.existsSync(dirPath)) {
      const stat = fs.lstatSync(dirPath);
      if (stat.isSymbolicLink()) {
        die(`Refusing symlinked managed directory: ${dirPath}`);
      }
      return;
    }
    fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  } catch (err) {
    die(`Cannot create directory: ${dirPath} (${err.message})`);
  }
}

function ensureHome(codexHome) {
  ensureDir(codexHome);
}

function discoverProfiles(includeDefault = true) {
  const profiles = [];
  if (includeDefault && fs.existsSync(path.join(HOME, '.codex'))) {
    profiles.push('default');
  }
  try {
    const files = fs.readdirSync(HOME);
    for (const file of files) {
      if (file.startsWith('.codex-')) {
        const profile = file.substring('.codex-'.length);
        if (isValidProfileName(profile)) {
          const fullPath = path.join(HOME, file);
          try {
            const stat = fs.lstatSync(fullPath);
            if (stat.isDirectory() && !stat.isSymbolicLink()) {
              profiles.push(profile);
            }
          } catch (e) {}
        }
      }
    }
  } catch (e) {}
  return profiles;
}

function profileIsInitialized(profile) {
  try {
    const p = codexHomeForProfile(profile);
    return fs.existsSync(p) && fs.lstatSync(p).isDirectory() && !fs.lstatSync(p).isSymbolicLink();
  } catch (e) {
    return false;
  }
}

// Workspace bindings logic
function workspaceAssertStatePathsSafe() {
  try {
    if (fs.existsSync(CODEX_PROFILE_CONFIG_HOME) && fs.lstatSync(CODEX_PROFILE_CONFIG_HOME).isSymbolicLink()) {
      die(`Refusing symlinked workspace config directory: ${CODEX_PROFILE_CONFIG_HOME}`);
    }
    if (fs.existsSync(WORKSPACE_REGISTRY) && fs.lstatSync(WORKSPACE_REGISTRY).isSymbolicLink()) {
      die(`Refusing symlinked workspace registry: ${WORKSPACE_REGISTRY}`);
    }
    if (fs.existsSync(WORKSPACE_GUARD_FILE) && fs.lstatSync(WORKSPACE_GUARD_FILE).isSymbolicLink()) {
      die(`Refusing symlinked workspace guard file: ${WORKSPACE_GUARD_FILE}`);
    }
  } catch (e) {}
}

function ensureWorkspaceConfigHome() {
  workspaceAssertStatePathsSafe();
  ensureDir(CODEX_PROFILE_CONFIG_HOME);
}

function canonicalDirectory(inputPath) {
  if (/[\t\r\n]/.test(inputPath)) {
    die('Workspace paths cannot contain tab, carriage-return, or newline control characters.');
  }
  if (!fs.existsSync(inputPath)) {
    die(`Workspace directory does not exist: ${inputPath}`);
  }
  try {
    const canonical = fs.realpathSync.native ? fs.realpathSync.native(inputPath) : fs.realpathSync(inputPath);
    if (/[\t\r\n]/.test(canonical)) {
      die('Workspace paths cannot contain tab, carriage-return, or newline control characters.');
    }
    return canonical;
  } catch (err) {
    die(`Cannot resolve workspace directory: ${inputPath}`);
  }
}

function workspaceGuardMode() {
  workspaceAssertStatePathsSafe();
  if (!fs.existsSync(WORKSPACE_GUARD_FILE)) {
    return 'warn';
  }
  try {
    const mode = fs.readFileSync(WORKSPACE_GUARD_FILE, 'utf8').trim();
    if (['off', 'warn', 'strict'].includes(mode)) {
      return mode;
    }
    die(`Invalid workspace guard state in ${WORKSPACE_GUARD_FILE}. Use off, warn, or strict.`);
  } catch (err) {
    return 'warn';
  }
}

function loadWorkspaceBindings() {
  workspaceAssertStatePathsSafe();
  if (!fs.existsSync(WORKSPACE_REGISTRY)) {
    return [];
  }
  const content = fs.readFileSync(WORKSPACE_REGISTRY, 'utf8');
  const lines = content.split(/\r?\n/);
  const bindings = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const parts = line.split('\t');
    if (parts.length < 2 || !parts[0] || !parts[1] || !isValidProfileName(parts[1])) {
      die(`Malformed workspace registry line ${i + 1}: expected one absolute <path><tab><profile> row.`);
    }
    bindings.push({ path: parts[0], profile: parts[1] });
  }
  return bindings;
}

function saveWorkspaceBindings(bindings) {
  ensureWorkspaceConfigHome();
  const content = bindings.map(b => `${b.path}\t${b.profile}`).join(IS_WIN ? '\r\n' : '\n') + (IS_WIN ? '\r\n' : '\n');
  const tempFile = path.join(CODEX_PROFILE_CONFIG_HOME, `.workspaces.tmp.${Date.now()}`);
  fs.writeFileSync(tempFile, content, { mode: 0o600 });
  fs.renameSync(tempFile, WORKSPACE_REGISTRY);
}

function workspaceResolve(targetPath) {
  let canonical;
  try {
    canonical = canonicalDirectory(targetPath);
  } catch (e) {
    return null;
  }
  const bindings = loadWorkspaceBindings();
  let matched = null;
  const canonicalNorm = path.normalize(canonical).toLowerCase();

  for (const b of bindings) {
    const bNorm = path.normalize(b.path).toLowerCase();
    if (canonicalNorm === bNorm || canonicalNorm.startsWith(bNorm + path.sep)) {
      if (!matched || b.path.length > matched.path.length) {
        matched = b;
      }
    }
  }
  return matched ? { canonicalPath: canonical, binding: matched.path, profile: matched.profile } : { canonicalPath: canonical, binding: null, profile: null };
}

function workspaceGuardProfile(selectedProfile, checkPath) {
  const mode = workspaceGuardMode();
  if (mode === 'off') return;
  const res = workspaceResolve(checkPath);
  if (!res || !res.profile) return;
  if (res.profile !== selectedProfile) {
    if (mode === 'strict') {
      die(`Workspace '${res.binding}' is bound to profile '${res.profile}'; refusing selected profile '${selectedProfile}'.`);
    }
    warn(`workspace '${res.binding}' is bound to profile '${res.profile}'; selected profile is '${selectedProfile}'.`);
  }
}

// CLI discovery
function tryFindCodexCli() {
  if (process.env.CODEX_CLI) {
    try {
      const res = spawnSync(process.env.CODEX_CLI, ['--version'], { stdio: 'pipe' });
      if (res.status === 0) return process.env.CODEX_CLI;
    } catch (e) {}
    return null;
  }

  // Look in PATH
  const names = IS_WIN ? ['codex.exe', 'codex.cmd', 'codex.bat', 'codex'] : ['codex'];
  const pathDirs = (process.env.PATH || '').split(path.delimiter);
  for (const dir of pathDirs) {
    for (const name of names) {
      const full = path.join(dir, name);
      try {
        if (fs.existsSync(full)) {
          const res = spawnSync(full, ['--version'], { stdio: 'pipe' });
          if (res.status === 0) return full;
        }
      } catch (e) {}
    }
  }

  // Look in typical install spots
  if (IS_WIN) {
    const bunBin = path.join(HOME, '.bun', 'bin', 'codex.exe');
    if (fs.existsSync(bunBin)) return bunBin;
    const npmBin = path.join(process.env.APPDATA || '', 'npm', 'codex.cmd');
    if (fs.existsSync(npmBin)) return npmBin;
  }

  return null;
}

function findCodexCli() {
  const cli = tryFindCodexCli();
  if (!cli) {
    die('No healthy Codex CLI found. Install Codex, repair PATH, or set CODEX_CLI=/path/to/codex.');
  }
  return cli;
}

// Desktop App discovery (macOS / Windows / Linux)
function tryFindDesktopApp() {
  if (process.env.CHATGPT_APP && fs.existsSync(process.env.CHATGPT_APP)) {
    return process.env.CHATGPT_APP;
  }
  if (process.env.CODEX_APP && fs.existsSync(process.env.CODEX_APP)) {
    return process.env.CODEX_APP;
  }

  if (IS_MAC) {
    const macPaths = ['/Applications/ChatGPT.app', '/Applications/Codex.app', path.join(HOME, 'Applications', 'ChatGPT.app')];
    for (const p of macPaths) {
      if (fs.existsSync(p)) return p;
    }
  } else if (IS_WIN) {
    // Windows Apps & Standard paths
    const winPaths = [
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'ChatGPT', 'ChatGPT.exe'),
      path.join(process.env.PROGRAMFILES || '', 'ChatGPT', 'ChatGPT.exe'),
      path.join(process.env['ProgramFiles(x86)'] || '', 'ChatGPT', 'ChatGPT.exe'),
    ];
    for (const p of winPaths) {
      if (fs.existsSync(p)) return p;
    }

    // WindowsApps store package
    try {
      const windowsApps = 'C:\\Program Files\\WindowsApps';
      if (fs.existsSync(windowsApps)) {
        const entries = fs.readdirSync(windowsApps);
        for (const entry of entries) {
          if (entry.startsWith('OpenAI.Codex_') || entry.startsWith('OpenAI.ChatGPT_')) {
            const exe1 = path.join(windowsApps, entry, 'app', 'ChatGPT.exe');
            const exe2 = path.join(windowsApps, entry, 'app', 'Codex.exe');
            if (fs.existsSync(exe1)) return exe1;
            if (fs.existsSync(exe2)) return exe2;
          }
        }
      }
    } catch (e) {}
  }
  return null;
}

// Subcommands implementation
function cmdUsage() {
  console.log(`${PROGRAM} - select named Codex homes and ChatGPT windows with separate local state (Windows & Cross-Platform)

Usage:
  ${PROGRAM} app <profile> [--instance] [--rebuild] [workspace]
  ${PROGRAM} cli <profile> [codex-args...]
  ${PROGRAM} login <profile> [codex-login-args...]
  ${PROGRAM} init <profile> [--share-with <source-profile>]
  ${PROGRAM} remove <profile> [--yes]
  ${PROGRAM} launcher create <profile> [--name <display-name>] [--color <color>] [--force]
  ${PROGRAM} launcher list [--json]
  ${PROGRAM} launcher path <profile>
  ${PROGRAM} launcher remove <profile> [--yes]
  ${PROGRAM} workspace bind <path> <profile> [--force]
  ${PROGRAM} workspace unbind <path>
  ${PROGRAM} workspace list [--json]
  ${PROGRAM} workspace status [--json] [path]
  ${PROGRAM} workspace guard [off|warn|strict]
  ${PROGRAM} run [--] [codex-args...]
  ${PROGRAM} run --app [workspace]
  ${PROGRAM} status [profile]
  ${PROGRAM} status --json [profile]
  ${PROGRAM} path <profile>
  ${PROGRAM} env <profile> [--shell <powershell|cmd|bash|zsh|fish>]
  ${PROGRAM} use <profile>
  ${PROGRAM} logs <profile> [--instance] [--path|--tail [lines]]
  ${PROGRAM} clone-config <source-profile> <target-profile> [--force]
  ${PROGRAM} list
  ${PROGRAM} doctor [--json]
  ${PROGRAM} completions <powershell|bash|zsh|fish>
  ${PROGRAM} shell-init <powershell|bash|zsh|fish>
  ${PROGRAM} upgrade [--dry-run]
  ${PROGRAM} version
  ${PROGRAM} help
`);
}

function cmdInit(args) {
  let profile = null;
  let shareWith = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--share-with') {
      shareWith = args[++i];
    } else if (!profile && !args[i].startsWith('-')) {
      profile = args[i];
    } else {
      die(`Usage: ${PROGRAM} init <profile> [--share-with <source-profile>]`);
    }
  }

  if (!profile) die(`Usage: ${PROGRAM} init <profile> [--share-with <source-profile>]`);
  validateProfile(profile);

  const targetHome = codexHomeForProfile(profile);

  if (shareWith) {
    validateProfile(shareWith);
    if (profile === shareWith) die('Source and target profiles must be different.');
    const sourceHome = codexHomeForProfile(shareWith);
    if (!profileIsInitialized(shareWith)) {
      die(`Shared profile source is not initialized: ${shareWith} (${sourceHome})`);
    }
    if (fs.existsSync(targetHome)) {
      die(`Target profile path already exists: ${profile} (${targetHome})`);
    }
    ensureHome(targetHome);

    const shareEntries = ['config.toml', 'AGENTS.md', 'AGENTS.override.md', 'instructions.md', 'custom-instructions.md', 'rules', 'plugins'];
    for (const entry of shareEntries) {
      const srcEntry = path.join(sourceHome, entry);
      const tgtEntry = path.join(targetHome, entry);
      if (fs.existsSync(srcEntry)) {
        try {
          const stat = fs.statSync(srcEntry);
          const linkType = stat.isDirectory() ? (IS_WIN ? 'junction' : 'dir') : 'file';
          fs.symlinkSync(srcEntry, tgtEntry, linkType);
        } catch (err) {
          fs.rmSync(targetHome, { recursive: true, force: true });
          die(`Cannot link shared entry ${entry} into ${targetHome}: ${err.message}`);
        }
      }
    }
    note(`Initialized ${profile} (${targetHome})`);
    note(`Sharing configuration with ${shareWith} (${sourceHome})`);
    return;
  }

  const existed = fs.existsSync(targetHome);
  ensureHome(targetHome);
  if (existed) {
    note(`Already initialized ${profile} (${targetHome})`);
  } else {
    note(`Initialized ${profile} (${targetHome})`);
  }
}

function cmdCli(profile, codexArgs) {
  if (!profile) die(`Usage: ${PROGRAM} cli <profile> [codex-args...]`);
  validateProfile(profile);
  workspaceGuardProfile(profile, process.cwd());

  const codexHome = codexHomeForProfile(profile);
  ensureHome(codexHome);
  const cli = findCodexCli();

  const env = Object.assign({}, process.env, { CODEX_HOME: codexHome, CODEX_PROFILE_NAME: profile });
  const proc = spawn(cli, codexArgs, { stdio: 'inherit', env, shell: IS_WIN });
  proc.on('exit', (code) => {
    process.exit(code || 0);
  });
}

function cmdLogin(profile, loginArgs) {
  if (!profile) die(`Usage: ${PROGRAM} login <profile> [codex-login-args...]`);
  cmdCli(profile, ['login', ...loginArgs]);
}

function cmdApp(profile, workspace) {
  if (!profile) die(`Usage: ${PROGRAM} app <profile> [--instance] [--rebuild] [workspace]`);
  validateProfile(profile);
  if (workspace) {
    workspace = path.resolve(workspace);
    workspaceGuardProfile(profile, workspace);
  }

  if (process.env.CODEX_ACCESS_TOKEN) {
    die('Refusing Desktop launch while CODEX_ACCESS_TOKEN is set; unset it so the selected ChatGPT window controls authentication.');
  }

  const desktopApp = tryFindDesktopApp();
  if (!desktopApp) {
    die('ChatGPT desktop app not found. Install ChatGPT or set CHATGPT_APP=/path/to/ChatGPT.');
  }

  const codexHome = codexHomeForProfile(profile);
  ensureHome(codexHome);

  let userDataDir = '';
  if (profile !== 'default') {
    userDataDir = path.join(codexHome, 'electron-user-data');
    ensureHome(userDataDir);
  }

  const logDir = path.join(codexHome, 'logs');
  ensureHome(logDir);
  const logFile = path.join(logDir, 'desktop.log');

  note(`Launching ChatGPT for profile ${profile}`);
  note(`CODEX_HOME=${codexHome}`);
  note(`App binary: ${desktopApp}`);
  if (profile === 'default') {
    note('Desktop scope: stock ChatGPT session');
  } else {
    note('Desktop scope: separate Electron state for this named ChatGPT window (separate local state across Chat, Work, and Codex)');
    note(`Electron user data: ${userDataDir}`);
  }
  note(`Log: ${logFile}`);

  const env = Object.assign({}, process.env, {
    CODEX_HOME: codexHome,
    CODEX_PROFILE_NAME: profile,
    CODEX_ELECTRON_USER_DATA_PATH: userDataDir
  });

  const appArgs = [];
  if (userDataDir) {
    appArgs.push(`--user-data-dir=${userDataDir}`);
  }
  if (workspace) {
    appArgs.push(workspace);
  }

  const outStream = fs.openSync(logFile, 'a');
  const child = spawn(desktopApp, appArgs, {
    env,
    detached: true,
    stdio: ['ignore', outStream, outStream]
  });
  child.unref();
}

function cmdStatus(profile, isJson) {
  const cli = tryFindCodexCli();
  const profiles = profile ? [profile] : discoverProfiles(true);

  if (isJson) {
    const list = profiles.map((p) => {
      const home = codexHomeForProfile(p);
      if (!fs.existsSync(home)) {
        return { name: p, home, state: 'not_initialized', status: 'Not initialized', exit_code: 0 };
      }
      if (!cli) {
        return { name: p, home, state: 'error', status: 'No healthy Codex CLI found', exit_code: 1 };
      }
      const res = spawnSync(cli, ['login', 'status'], {
        env: Object.assign({}, process.env, { CODEX_HOME: home }),
        encoding: 'utf8'
      });
      const output = (res.stdout || res.stderr || '').trim();
      const lower = output.toLowerCase();
      const isLoggedOut = lower.includes('not logged in') || lower.includes('not authenticated') || lower.includes('no login credentials');
      const state = res.status === 0 ? 'ok' : (isLoggedOut ? 'not_logged_in' : 'error');
      return { name: p, home, state, status: output, exit_code: res.status || 0 };
    });
    console.log(JSON.stringify({ profiles: list }, null, 2));
    return;
  }

  for (const p of profiles) {
    const home = codexHomeForProfile(p);
    if (!fs.existsSync(home)) {
      console.log(`${p} (${home}): Not initialized`);
      continue;
    }
    if (!cli) {
      console.log(`${p} (${home}): Error: Codex CLI not found`);
      continue;
    }
    const res = spawnSync(cli, ['login', 'status'], {
      env: Object.assign({}, process.env, { CODEX_HOME: home }),
      encoding: 'utf8'
    });
    const output = (res.stdout || res.stderr || '').trim();
    console.log(`${p} (${home}): ${output}`);
  }
}

function cmdWorkspace(sub, args) {
  if (!sub) die(`Usage: ${PROGRAM} workspace <bind|unbind|list|status|guard> ...`);
  if (sub === 'bind') {
    const dir = args[0];
    const profile = args[1];
    const force = args.includes('--force');
    if (!dir || !profile) die(`Usage: ${PROGRAM} workspace bind <path> <profile> [--force]`);
    validateProfile(profile);
    if (!profileIsInitialized(profile)) {
      die(`Profile '${profile}' is not initialized; run '${PROGRAM} init ${profile}' first.`);
    }
    const canonical = canonicalDirectory(dir);
    const bindings = loadWorkspaceBindings();
    const existing = bindings.find(b => b.path === canonical);
    if (existing) {
      if (existing.profile === profile) {
        note(`Already bound ${canonical} to profile ${profile}`);
        return;
      }
      if (!force) {
        die(`Workspace ${canonical} is already bound to profile ${existing.profile}; use --force to replace it.`);
      }
      existing.profile = profile;
    } else {
      bindings.push({ path: canonical, profile });
    }
    saveWorkspaceBindings(bindings);
    note(`Bound ${canonical} to profile ${profile}`);
  } else if (sub === 'unbind') {
    const dir = args[0];
    if (!dir) die(`Usage: ${PROGRAM} workspace unbind <path>`);
    const canonical = canonicalDirectory(dir);
    const bindings = loadWorkspaceBindings();
    const idx = bindings.findIndex(b => b.path === canonical);
    if (idx === -1) {
      die(`No exact workspace binding exists for ${canonical}.`);
    }
    bindings.splice(idx, 1);
    saveWorkspaceBindings(bindings);
    note(`Unbound ${canonical}`);
  } else if (sub === 'list') {
    const isJson = args.includes('--json') || args.includes('-j');
    const bindings = loadWorkspaceBindings();
    const mode = workspaceGuardMode();
    if (isJson) {
      const res = bindings.map(b => ({
        path: b.path,
        profile: b.profile,
        path_exists: fs.existsSync(b.path),
        profile_exists: profileIsInitialized(b.profile)
      }));
      console.log(JSON.stringify({ guard_mode: mode, bindings: res }, null, 2));
    } else {
      note(`Workspace guard mode: ${mode}`);
      if (bindings.length === 0) {
        note('No workspace bindings.');
      } else {
        for (const b of bindings) {
          const pathExists = fs.existsSync(b.path);
          const profExists = profileIsInitialized(b.profile);
          const state = (!pathExists ? 'missing-path ' : '') + (!profExists ? 'missing-profile' : '');
          console.log(`${b.path} -> ${b.profile}${state ? ` [${state.trim()}]` : ''}`);
        }
      }
    }
  } else if (sub === 'status') {
    const isJson = args.includes('--json') || args.includes('-j');
    const targetPath = args.find(a => !a.startsWith('-')) || process.cwd();
    const res = workspaceResolve(targetPath);
    const mode = workspaceGuardMode();
    if (isJson) {
      console.log(JSON.stringify({
        path: res.canonicalPath,
        binding_path: res.binding,
        profile: res.profile,
        guard_mode: mode
      }, null, 2));
    } else {
      note(`Workspace: ${res.canonicalPath}`);
      note(`Binding: ${res.binding || 'none'}`);
      note(`Profile: ${res.profile || 'none'}`);
      note(`Guard mode: ${mode}`);
    }
  } else if (sub === 'guard') {
    const mode = args[0];
    if (!mode) {
      console.log(workspaceGuardMode());
      return;
    }
    if (!['off', 'warn', 'strict'].includes(mode)) {
      die(`Invalid workspace guard mode '${mode}'. Use off, warn, or strict.`);
    }
    ensureWorkspaceConfigHome();
    fs.writeFileSync(WORKSPACE_GUARD_FILE, mode, { mode: 0o600 });
    note(`Workspace guard mode: ${mode}`);
  } else {
    die(`Unknown workspace command '${sub}'. Use bind, unbind, list, status, or guard.`);
  }
}

function cmdRun(args) {
  let isApp = false;
  let workspace = null;
  const filtered = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--app') {
      isApp = true;
      if (args[i + 1] && !args[i + 1].startsWith('-')) {
        workspace = args[++i];
      }
    } else if (args[i] === '--') {
      // pass rest
      filtered.push(...args.slice(i + 1));
      break;
    } else {
      filtered.push(args[i]);
    }
  }

  const checkPath = workspace || process.cwd();
  const resolved = workspaceResolve(checkPath);
  if (!resolved || !resolved.profile) {
    die(`No workspace profile is bound to '${checkPath}'. Run '${PROGRAM} workspace bind ${checkPath} <profile>' first.`);
  }

  if (isApp) {
    cmdApp(resolved.profile, resolved.canonicalPath);
  } else {
    cmdCli(resolved.profile, filtered);
  }
}

function cmdEnv(profile, shellType) {
  if (!profile) die(`Usage: ${PROGRAM} env <profile> [--shell <powershell|cmd|bash|zsh|fish>]`);
  validateProfile(profile);
  const home = codexHomeForProfile(profile);
  workspaceGuardProfile(profile, process.cwd());

  if (!fs.existsSync(home)) {
    console.error(`${PROGRAM}: profile '${profile}' is not initialized (${home}); run '${PROGRAM} init ${profile}' or '${PROGRAM} login ${profile}'.`);
  }

  shellType = (shellType || (IS_WIN ? 'powershell' : 'bash')).toLowerCase();

  if (shellType === 'powershell' || shellType === 'pwsh') {
    console.log(`$env:CODEX_HOME = "${home}"`);
    console.log(`$env:CODEX_PROFILE_NAME = "${profile}"`);
  } else if (shellType === 'cmd') {
    console.log(`set CODEX_HOME=${home}`);
    console.log(`set CODEX_PROFILE_NAME=${profile}`);
  } else if (shellType === 'fish') {
    console.log(`set -gx CODEX_HOME '${home}'`);
    console.log(`set -gx CODEX_PROFILE_NAME '${profile}'`);
  } else {
    console.log(`export CODEX_HOME='${home}'`);
    console.log(`export CODEX_PROFILE_NAME='${profile}'`);
  }
}

function cmdDoctor(isJson) {
  const cli = tryFindCodexCli();
  const app = tryFindDesktopApp();
  const bindings = loadWorkspaceBindings();
  const guard = workspaceGuardMode();

  if (isJson) {
    console.log(JSON.stringify({
      platform: process.platform,
      desktop: {
        found: !!app,
        path: app,
        scope: 'default:stock_chatgpt_session;named:separate_local_state'
      },
      cli: {
        found: !!cli,
        path: cli,
        healthy: !!cli
      },
      workspaces: {
        config_home: CODEX_PROFILE_CONFIG_HOME,
        registry_path: WORKSPACE_REGISTRY,
        guard_mode: guard,
        binding_count: bindings.length
      }
    }, null, 2));
    return;
  }

  note('Codex profile doctor');
  note('');
  note(`Platform: ${process.platform} (${os.type()} ${os.release()})`);
  if (app) {
    note(`Desktop app: ${app}`);
  } else {
    note('Desktop: missing (ChatGPT desktop application not found)');
  }
  note('Desktop scope: default uses stock ChatGPT session; named ChatGPT windows use separate local state');
  note(`Workspace registry: ${WORKSPACE_REGISTRY}`);
  note(`Workspace guard mode: ${guard}`);
  note(`Workspace bindings: ${bindings.length}`);
  if (cli) {
    note(`CLI: ${cli}`);
    const v = spawnSync(cli, ['--version'], { encoding: 'utf8' });
    if (v.stdout) note(v.stdout.trim());
  } else {
    note('CLI: missing');
  }
  note('');
  cmdStatus(null, false);
}

function cmdCloneConfig(sourceProfile, targetProfile, force) {
  if (!sourceProfile || !targetProfile) {
    die(`Usage: ${PROGRAM} clone-config <source-profile> <target-profile> [--force]`);
  }
  if (sourceProfile === targetProfile) {
    die('Source and target profiles must be different.');
  }
  validateProfile(sourceProfile);
  validateProfile(targetProfile);

  const srcHome = codexHomeForProfile(sourceProfile);
  const tgtHome = codexHomeForProfile(targetProfile);

  if (!profileIsInitialized(sourceProfile)) {
    die(`Source profile is not initialized: ${sourceProfile} (${srcHome})`);
  }
  ensureHome(tgtHome);

  const safeFiles = ['config.toml', 'AGENTS.md'];
  let copied = 0;

  for (const file of safeFiles) {
    const srcFile = path.join(srcHome, file);
    const tgtFile = path.join(tgtHome, file);
    if (fs.existsSync(srcFile)) {
      if (fs.existsSync(tgtFile) && !force) {
        note(`Refusing to overwrite ${file} in ${tgtHome}. Use --force to overwrite.`);
        continue;
      }
      fs.copyFileSync(srcFile, tgtFile);
      note(`Copied ${file}`);
      copied++;
    }
  }

  if (copied === 0) {
    note(`No safe config files found to clone from ${sourceProfile}.`);
  }
}

function cmdShellInit(shell) {
  shell = (shell || (IS_WIN ? 'powershell' : 'bash')).toLowerCase();
  if (shell === 'powershell' || shell === 'pwsh') {
    console.log(`
function codex-profile {
    param([Parameter(ValueFromRemainingArguments = $true)]$args)
    if ($args.Count -ge 1 -and $args[0] -eq 'use') {
        $prof = if ($args.Count -ge 2) { $args[1] } else { 'default' }
        $env:CODEX_HOME = if ($prof -eq 'default') { "$HOME\\.codex" } else { "$HOME\\.codex-$prof" }
        $env:CODEX_PROFILE_NAME = $prof
        Write-Host "Switched shell CODEX_HOME to $env:CODEX_HOME"
    } else {
        & node "${__filename.replace(/\\/g, '\\\\')}" @args
    }
}
Set-Alias -Name codex-profiles -Value codex-profile -Option AllScope
`);
  } else if (shell === 'bash' || shell === 'zsh') {
    console.log(`
codex-profile() {
  if [ "\${1:-}" = "use" ]; then
    shift
    local __cp_env
    __cp_env="\$(node "${__filename}" env "\$@")" || return \$?
    eval "\$__cp_env"
  else
    node "${__filename}" "\$@"
  fi
}
codex-profiles() { codex-profile "\$@"; }
`);
  } else if (shell === 'fish') {
    console.log(`
function codex-profile
    if test (count $argv) -ge 1; and test "$argv[1]" = use
        set -l __cp_env (node "${__filename}" env --shell fish $argv[2..-1]); or return $status
        printf '%s\\n' $__cp_env | source
    else
        node "${__filename}" $argv
    end
end
function codex-profiles
    codex-profile $argv
end
`);
  }
}

// Main CLI dispatch
function main() {
  const rawArgs = process.argv.slice(2);
  const cmd = rawArgs[0] || 'help';
  const args = rawArgs.slice(1);

  switch (cmd) {
    case 'init':
      cmdInit(args);
      break;
    case 'cli':
      cmdCli(args[0], args.slice(1));
      break;
    case 'login':
      cmdLogin(args[0], args.slice(1));
      break;
    case 'app':
    case 'app-instance': {
      let prof = null;
      let ws = null;
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '--instance' || args[i] === '--rebuild') continue;
        if (!prof) prof = args[i];
        else if (!ws) ws = args[i];
      }
      cmdApp(prof, ws);
      break;
    }
    case 'status': {
      const isJson = args.includes('--json') || args.includes('-j');
      const p = args.find(a => !a.startsWith('-'));
      cmdStatus(p, isJson);
      break;
    }
    case 'workspace':
      cmdWorkspace(args[0], args.slice(1));
      break;
    case 'run':
      cmdRun(args);
      break;
    case 'path':
      if (!args[0]) die(`Usage: ${PROGRAM} path <profile>`);
      console.log(codexHomeForProfile(args[0]));
      break;
    case 'env': {
      let prof = null;
      let sh = null;
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '--shell') sh = args[++i];
        else if (!prof) prof = args[i];
      }
      cmdEnv(prof, sh);
      break;
    }
    case 'use':
      die(`'${PROGRAM} use' changes CODEX_HOME in your current shell.
Run via shell integration:
  PowerShell:  ${PROGRAM} shell-init powershell | Out-String | Invoke-Expression
  Bash/Zsh:    eval "$(${PROGRAM} shell-init bash)"
Then: ${PROGRAM} use <profile>`);
      break;
    case 'logs': {
      const p = args[0];
      if (!p) die(`Usage: ${PROGRAM} logs <profile> [--tail [lines]]`);
      const home = codexHomeForProfile(p);
      const logFile = path.join(home, 'logs', 'desktop.log');
      if (args.includes('--path')) {
        console.log(logFile);
        return;
      }
      if (!fs.existsSync(logFile)) die(`No desktop log for ${p} (${logFile}).`);
      console.log(fs.readFileSync(logFile, 'utf8'));
      break;
    }
    case 'clone-config': {
      const force = args.includes('--force') || args.includes('-f');
      const nonFlags = args.filter(a => !a.startsWith('-'));
      cmdCloneConfig(nonFlags[0], nonFlags[1], force);
      break;
    }
    case 'list': {
      const list = discoverProfiles(true);
      for (const p of list) console.log(p);
      break;
    }
    case 'remove': {
      const p = args[0];
      if (!p) die(`Usage: ${PROGRAM} remove <profile> [--yes]`);
      validateProfile(p);
      const home = codexHomeForProfile(p);
      if (fs.existsSync(home)) {
        fs.rmSync(home, { recursive: true, force: true });
        note(`Removed ${p} (${home})`);
      } else {
        note(`Not initialized ${p} (${home})`);
      }
      break;
    }
    case 'quit':
  case 'kill':
  case 'stop': {
    if (IS_WIN) {
      spawnSync('taskkill', ['/F', '/IM', 'ChatGPT.exe'], { stdio: 'ignore' });
      spawnSync('taskkill', ['/F', '/IM', 'Codex.exe'], { stdio: 'ignore' });
      spawnSync('taskkill', ['/F', '/IM', 'codex.exe'], { stdio: 'ignore' });
      note('Stopped all running ChatGPT and Codex processes.');
    } else {
      spawnSync('pkill', ['-f', 'ChatGPT'], { stdio: 'ignore' });
      spawnSync('pkill', ['-f', 'Codex'], { stdio: 'ignore' });
      note('Stopped all running ChatGPT and Codex processes.');
    }
    break;
  }
  case 'doctor': {
      const isJson = args.includes('--json') || args.includes('-j');
      cmdDoctor(isJson);
      break;
    }
    case 'shell-init':
      cmdShellInit(args[0]);
      break;
    case 'version':
    case '--version':
    case '-v':
      console.log(`${PROGRAM} ${VERSION}`);
      break;
    case 'help':
    case '--help':
    case '-h':
    default:
      cmdUsage();
      break;
  }
}

if (require.main === module) {
  main();
}
