const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const extensionRoot = path.resolve(__dirname, '..');
const repositoryRoot = path.resolve(extensionRoot, '..');
const submodulePath = 'neko-floating-webui/vendor/browser-skill';
const submoduleRoot = path.join(extensionRoot, 'vendor', 'browser-skill');
const SUBMODULE_UPDATE_TIMEOUT_MS = 120_000;
const browserSkillPackage = path.join(
  submoduleRoot,
  'apps',
  'extension',
  'package.json'
);

function readCommit(args) {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    return null;
  }
  return result.stdout.match(/[0-9a-f]{40}/i)?.[0]?.toLowerCase() || null;
}

function expectedSubmoduleCommit() {
  return readCommit([
    '-C',
    repositoryRoot,
    'ls-files',
    '--stage',
    '--',
    submodulePath
  ]);
}

function actualSubmoduleCommit() {
  if (!fs.existsSync(browserSkillPackage)) {
    return null;
  }
  return readCommit(['-C', submoduleRoot, 'rev-parse', 'HEAD']);
}

function updateSubmodule() {
  const result = spawnSync(
    'git',
    [
      '-C',
      repositoryRoot,
      'submodule',
      'update',
      '--init',
      '--recursive',
      '--',
      submodulePath
    ],
    {
      stdio: 'inherit',
      timeout: SUBMODULE_UPDATE_TIMEOUT_MS,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0'
      }
    }
  );

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error('Unable to initialize the Tencent BrowserSkill submodule.');
  }
}

const hasRepositoryMetadata = fs.existsSync(path.join(repositoryRoot, '.git'));
const expectedCommit = expectedSubmoduleCommit();
if (!expectedCommit) {
  if (hasRepositoryMetadata || !fs.existsSync(browserSkillPackage)) {
    throw new Error('Unable to resolve the BrowserSkill gitlink from the parent repository.');
  }
} else if (
  !fs.existsSync(browserSkillPackage)
  || actualSubmoduleCommit() !== expectedCommit
) {
  updateSubmodule();
  if (
    !fs.existsSync(browserSkillPackage)
    || actualSubmoduleCommit() !== expectedCommit
  ) {
    throw new Error(`BrowserSkill submodule is not checked out at ${expectedCommit}.`);
  }
}
