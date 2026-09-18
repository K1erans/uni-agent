import * as fs from 'node:fs';
import * as path from 'node:path';

export interface FindExecutableOptions {
  /** A user-configured path; when set, PATH is not searched at all. */
  override?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  isExecutable?: (file: string) => boolean;
}

/**
 * Resolves an agent CLI by name, like `which`: the configured override if any, else the first
 * executable match on PATH (honouring PATHEXT on Windows). Returns undefined when not found.
 */
export function findExecutable(name: string, options: FindExecutableOptions = {}): string | undefined {
  const { override, env = process.env, platform = process.platform, isExecutable = isExecutableFile } = options;
  if (override) {
    return isExecutable(override) ? override : undefined;
  }

  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const dirs = (env.PATH ?? env.Path ?? '').split(pathApi.delimiter).filter(Boolean);
  const extensions =
    platform === 'win32' ? ['', ...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)] : [''];

  for (const dir of dirs) {
    for (const ext of extensions) {
      const candidate = pathApi.join(dir, name + ext);
      if (isExecutable(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

function isExecutableFile(file: string): boolean {
  try {
    if (!fs.statSync(file).isFile()) {
      return false;
    }
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
