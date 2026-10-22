// A file as of a Git revision: through the built-in Git extension when it is there, else
// by running git itself. Never in Restricted Mode, where no repository code may run.
import { execFile } from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';
import { decode } from './decode';

interface GitApi {
  state: string;
  getRepository(uri: vscode.Uri): Repo | null;
  repositories: Repo[];
}
interface Repo {
  rootUri: vscode.Uri;
  show(ref: string, path: string): Promise<string>;
  log(options?: { maxEntries?: number; path?: string }): Promise<{ hash: string; message: string; authorDate?: Date; authorName?: string }[]>;
  state: { HEAD?: { name?: string; commit?: string } };
}

export interface Commit {
  hash: string;
  message: string;
  when?: string;
  author?: string;
}

function assertTrusted(what: string) {
  if (!vscode.workspace.isTrusted) throw new Error(`${what} needs a trusted workspace: Git doesn't run in Restricted Mode.`);
}

async function gitApi(): Promise<GitApi | undefined> {
  const git = vscode.extensions.getExtension('vscode.git');
  if (!git) return undefined;
  try {
    const exports = git.isActive ? git.exports : await git.activate();
    return exports?.getAPI?.(1);
  } catch {
    return undefined;
  }
}

async function repositoryOf(api: GitApi, target: vscode.Uri, patient: boolean): Promise<Repo | null> {
  let repo = api.getRepository(target);
  // Right after a window reload Git is still discovering repositories: give it a moment.
  for (let waited = 0; !repo && api.state !== 'initialized' && waited < 10_000; waited += 250) {
    await new Promise((r) => setTimeout(r, 250));
    repo = api.getRepository(target);
  }
  for (let waited = 0; patient && !repo && waited < 3_000; waited += 250) {
    await new Promise((r) => setTimeout(r, 250));
    repo = api.getRepository(target);
  }
  return repo;
}

function runBytes(args: string[], cwd: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: 512 * 1024 * 1024, encoding: 'buffer' }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.toString('utf8').trim() || err.message));
      else resolve(stdout);
    });
  });
}

const run = async (args: string[], cwd: string) => (await runBytes(args, cwd)).toString('utf8');

/** The content of `target` at `ref` (`HEAD`, a branch, a tag, a commit). */
export async function readRevision(target: vscode.Uri, ref: string, label: string, patient = false): Promise<string> {
  assertTrusted('Comparing with a Git revision');
  if (target.scheme !== 'file') throw new Error(`${label} is not a file on disk.`);
  const api = await gitApi();
  const repo = api ? await repositoryOf(api, target, patient) : null;
  if (repo) {
    try {
      return await repo.show(ref, target.fsPath);
    } catch {
      throw new Error(`${label} is not in ${ref === 'HEAD' ? 'HEAD yet (new file?)' : ref}.`);
    }
  }
  // The Git extension is disabled, or hasn't opened this repository (a parent folder it
  // asked about, a repository that was closed): run git directly.
  const dir = path.dirname(target.fsPath);
  let top: string;
  try {
    top = (await run(['rev-parse', '--show-toplevel'], dir)).trim();
  } catch {
    throw new Error(`${label} is not in a Git repository.`);
  }
  const rel = path.relative(top, target.fsPath).split(path.sep).join('/');
  let bytes: Buffer;
  try {
    bytes = await runBytes(['show', `${ref}:${rel}`], top);
  } catch {
    throw new Error(`${label} is not in ${ref === 'HEAD' ? 'HEAD yet (new file?)' : ref}.`);
  }
  // Decoded as the working file is: its byte order mark, else files.encoding.
  return decode(bytes, vscode.workspace.getConfiguration('files', target).get<string>('encoding'));
}

/** Recent commits that touched `target`, newest first. */
export async function recentCommits(target: vscode.Uri, max = 30): Promise<Commit[]> {
  assertTrusted('Comparing with a Git revision');
  const api = await gitApi();
  const repo = api ? await repositoryOf(api, target, false) : null;
  if (repo) {
    try {
      const log = await repo.log({ maxEntries: max, path: target.fsPath });
      return log.map((c) => ({ hash: c.hash, message: c.message.split('\n')[0], when: c.authorDate ? ago(c.authorDate) : undefined, author: c.authorName }));
    } catch {
      return [];
    }
  }
  try {
    const out = await run(['log', `-n${max}`, '--format=%H%x1f%s%x1f%ar%x1f%an', '--', target.fsPath], path.dirname(target.fsPath));
    return out
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [hash, message, when, author] = l.split('\x1f');
        return { hash, message, when, author };
      });
  } catch {
    return [];
  }
}

function ago(d: Date): string {
  const s = Math.round((Date.now() - d.getTime()) / 1000);
  if (s < 90) return 'just now';
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} h ago`;
  const days = Math.round(h / 24);
  if (days < 45) return `${days} d ago`;
  return d.toISOString().slice(0, 10);
}

/** `23e29a0971e9…` → `23e29a09`, as VS Code's own diff tabs show commits. */
export const shortRef = (r: string) => (r === '~' || r === '' ? 'Index' : /^[0-9a-f]{40}$/.test(r) ? r.slice(0, 8) : r);
