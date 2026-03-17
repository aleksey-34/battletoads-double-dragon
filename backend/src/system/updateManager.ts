import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 4 * 1024 * 1024;
const UPDATE_UNIT_NAME = 'btdd-git-update';

const stripAnsi = (value: string): string => {
  return String(value || '').replace(/\x1b\[[0-9;]*m/g, '');
};

export type UpdateCommit = {
  hash: string;
  shortHash: string;
  date: string;
  subject: string;
};

export type GitUpdateStatus = {
  configured: boolean;
  updateEnabled: boolean;
  repoDir: string;
  appDir: string;
  branch: string;
  originUrl: string;
  localHash: string;
  remoteHash: string;
  ahead: number;
  behind: number;
  dirtyCount: number;
  updateAvailable: boolean;
  latestCommit: UpdateCommit | null;
  pendingCommits: UpdateCommit[];
  message?: string;
};

export type GitUpdateJobStatus = {
  unit: string;
  exists: boolean;
  loadState: string;
  activeState: string;
  subState: string;
  result: string;
  execMainStatus: string;
  startedAt: string;
  exitedAt: string;
  logs: string;
};

const command = async (cmd: string, args: string[], cwd?: string): Promise<{ stdout: string; stderr: string }> => {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: MAX_BUFFER,
    });

    return {
      stdout: stripAnsi(String(stdout || '')).trim(),
      stderr: stripAnsi(String(stderr || '')).trim(),
    };
  } catch (error: any) {
    const stderr = stripAnsi(String(error?.stderr || '')).trim();
    const stdout = stripAnsi(String(error?.stdout || '')).trim();
    const message = stderr || stdout || String(error?.message || 'Unknown command error');
    throw new Error(`${cmd} ${args.join(' ')} failed: ${message}`);
  }
};

const ignoreCommandError = async (cmd: string, args: string[], cwd?: string): Promise<void> => {
  try {
    await command(cmd, args, cwd);
  } catch {
    // Best-effort cleanup only.
  }
};

const parseCommitLine = (line: string): UpdateCommit | null => {
  const parts = String(line || '').split('|');
  if (parts.length < 4) {
    return null;
  }

  const [hash, shortHash, date, ...subjectParts] = parts;
  return {
    hash: String(hash || '').trim(),
    shortHash: String(shortHash || '').trim(),
    date: String(date || '').trim(),
    subject: subjectParts.join('|').trim(),
  };
};

const parseShowOutput = (text: string): Record<string, string> => {
  const lines = String(text || '').split('\n');
  const out: Record<string, string> = {};

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      continue;
    }

    const idx = line.indexOf('=');
    if (idx <= 0) {
      continue;
    }

    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    out[key] = value;
  }

  return out;
};

const shellQuote = (value: string): string => {
  return `'${String(value || '').replace(/'/g, `'"'"'`)}'`;
};

const resolveAppDir = (): string => {
  if (process.env.APP_DIR && process.env.APP_DIR.trim()) {
    return process.env.APP_DIR.trim();
  }

  // backend service usually runs with WorkingDirectory=<appDir>/backend
  const fromCwd = path.resolve(process.cwd(), '..');
  return fromCwd;
};

const resolveRepoDir = (): string => {
  const candidates = [
    resolveAppDir(),
    process.cwd(),
    path.resolve(process.cwd(), '..'),
    path.resolve(process.cwd(), '../..'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    if (fs.existsSync(path.join(candidate, '.git'))) {
      return candidate;
    }
  }

  return '';
};

export const getGitUpdateStatus = async (refreshRemote: boolean = true): Promise<GitUpdateStatus> => {
  const appDir = resolveAppDir();
  const repoDir = resolveRepoDir();
  const updateEnabled = process.env.ENABLE_GIT_UPDATE === '1';

  if (!repoDir) {
    return {
      configured: false,
      updateEnabled,
      repoDir: '',
      appDir,
      branch: '',
      originUrl: '',
      localHash: '',
      remoteHash: '',
      ahead: 0,
      behind: 0,
      dirtyCount: 0,
      updateAvailable: false,
      latestCommit: null,
      pendingCommits: [],
      message: 'Git repository not found. Configure deployment from Git first.',
    };
  }

  const branchRaw = process.env.GIT_BRANCH || (await command('git', ['rev-parse', '--abbrev-ref', 'HEAD'], repoDir)).stdout;
  const branch = branchRaw.trim();

  let originUrl = '';
  try {
    originUrl = (await command('git', ['remote', 'get-url', 'origin'], repoDir)).stdout;
  } catch {
    originUrl = '';
  }

  if (refreshRemote && originUrl && branch) {
    try {
      await command('git', ['fetch', '--prune', 'origin', branch], repoDir);
    } catch {
      // Keep local status even if fetch failed.
    }
  }

  const localHash = (await command('git', ['rev-parse', 'HEAD'], repoDir)).stdout;

  let remoteHash = '';
  let ahead = 0;
  let behind = 0;

  if (originUrl && branch) {
    try {
      remoteHash = (await command('git', ['rev-parse', `origin/${branch}`], repoDir)).stdout;
      const counts = (await command('git', ['rev-list', '--left-right', '--count', `HEAD...origin/${branch}`], repoDir)).stdout;
      const parts = counts.split(/\s+/);
      ahead = Number.parseInt(parts[0] || '0', 10) || 0;
      behind = Number.parseInt(parts[1] || '0', 10) || 0;
    } catch {
      remoteHash = '';
      ahead = 0;
      behind = 0;
    }
  }

  const dirtyRaw = (await command('git', ['status', '--porcelain'], repoDir)).stdout;
  const dirtyCount = dirtyRaw ? dirtyRaw.split('\n').filter(Boolean).length : 0;

  const latestLine = (await command('git', ['log', '-1', '--pretty=format:%H|%h|%ad|%s', '--date=iso'], repoDir)).stdout;
  const latestCommit = parseCommitLine(latestLine);

  let pendingCommits: UpdateCommit[] = [];
  if (behind > 0 && originUrl && branch) {
    const raw = (await command(
      'git',
      ['log', '--pretty=format:%H|%h|%ad|%s', '--date=iso', `HEAD..origin/${branch}`, '-n', '20'],
      repoDir
    )).stdout;

    pendingCommits = raw
      .split('\n')
      .map((line) => parseCommitLine(line))
      .filter((item): item is UpdateCommit => !!item);
  }

  return {
    configured: true,
    updateEnabled,
    repoDir,
    appDir,
    branch,
    originUrl,
    localHash,
    remoteHash,
    ahead,
    behind,
    dirtyCount,
    updateAvailable: behind > 0,
    latestCommit,
    pendingCommits,
  };
};

export const triggerGitUpdate = async (): Promise<{ started: boolean; unit: string; commandOutput: string; message?: string }> => {
  if (process.env.ENABLE_GIT_UPDATE !== '1') {
    throw new Error('Git update is disabled. Set ENABLE_GIT_UPDATE=1 in backend env.');
  }

  const status = await getGitUpdateStatus(false);
  if (!status.configured || !status.repoDir) {
    throw new Error('Git repository is not configured on server.');
  }

  if (!status.originUrl) {
    throw new Error('Git origin URL is not configured.');
  }

  if (status.behind <= 0 && status.ahead <= 0 && status.dirtyCount <= 0) {
    return {
      started: false,
      unit: UPDATE_UNIT_NAME,
      commandOutput: '',
      message: 'Already up to date. No deploy job started.',
    };
  }

  const scriptPath = process.env.UPDATE_SCRIPT || path.join(status.appDir, 'scripts', 'update_vps_from_git.sh');
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`Update script not found: ${scriptPath}`);
  }

  await command('which', ['systemd-run']);

  const currentJob = await getGitUpdateJobStatus();
  const activeState = String(currentJob.activeState || '').toLowerCase();
  if (activeState === 'active' || activeState === 'activating') {
    throw new Error(`Git update job is already running (${UPDATE_UNIT_NAME}: ${currentJob.activeState}/${currentJob.subState}).`);
  }

  await ignoreCommandError('systemctl', ['stop', UPDATE_UNIT_NAME]);
  await ignoreCommandError('systemctl', ['reset-failed', UPDATE_UNIT_NAME]);

  const branch = status.branch || 'main';
  const remoteCmd = `APP_DIR=${shellQuote(status.appDir)} BRANCH=${shellQuote(branch)} bash ${shellQuote(scriptPath)}`;

  let runResult: { stdout: string; stderr: string };
  try {
    runResult = await command('systemd-run', [
      '--unit',
      UPDATE_UNIT_NAME,
      '--collect',
      '--property',
      'Type=oneshot',
      '/bin/bash',
      '-lc',
      remoteCmd,
    ]);
  } catch (error: any) {
    const baseError = String(error?.message || 'Failed to start git update job.').trim();

    try {
      const job = await getGitUpdateJobStatus();
      const logLines = String(job.logs || '')
        .split('\n')
        .map((line) => stripAnsi(line).trim())
        .filter(Boolean);
      const tail = logLines.slice(-6).join(' | ');

      if (tail) {
        throw new Error(`${baseError} | Job tail: ${tail}`);
      }
    } catch {
      // Fallback to original error if job status cannot be read.
    }

    throw new Error(baseError);
  }

  const output = [runResult.stdout, runResult.stderr].filter(Boolean).join('\n').trim();
  return {
    started: true,
    unit: UPDATE_UNIT_NAME,
    commandOutput: output,
    message: 'Git update job started.',
  };
};

export const getGitUpdateJobStatus = async (): Promise<GitUpdateJobStatus> => {
  try {
    const show = await command('systemctl', [
      'show',
      UPDATE_UNIT_NAME,
      '--property',
      'LoadState,ActiveState,SubState,Result,ExecMainStatus,ExecMainStartTimestamp,ExecMainExitTimestamp',
    ]);

    const parsed = parseShowOutput(show.stdout);
    const logs = await command('journalctl', ['-u', UPDATE_UNIT_NAME, '-n', '120', '--no-pager']);

    return {
      unit: UPDATE_UNIT_NAME,
      exists: parsed.LoadState !== 'not-found',
      loadState: parsed.LoadState || 'unknown',
      activeState: parsed.ActiveState || 'unknown',
      subState: parsed.SubState || 'unknown',
      result: parsed.Result || 'unknown',
      execMainStatus: parsed.ExecMainStatus || '',
      startedAt: parsed.ExecMainStartTimestamp || '',
      exitedAt: parsed.ExecMainExitTimestamp || '',
      logs: logs.stdout || '',
    };
  } catch (error: any) {
    return {
      unit: UPDATE_UNIT_NAME,
      exists: false,
      loadState: 'unknown',
      activeState: 'unknown',
      subState: 'unknown',
      result: 'unknown',
      execMainStatus: '',
      startedAt: '',
      exitedAt: '',
      logs: String(error?.message || 'Unable to read update job status'),
    };
  }
};
