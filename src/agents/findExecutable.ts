import * as fs from 'node:fs';
import * as path from 'node:path';
import { Context, Effect, Layer, Option } from 'effect';

export interface FindExecutableOptions {
  /** A user-configured path; when set, PATH is not searched at all. */
  override?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  isExecutable?: (file: string) => boolean;
}

/** Resolves agent CLIs; adapters depend on this rather than the file system, so tests can fake it. */
export class Executables extends Context.Tag('uni-agent/Executables')<
  Executables,
  { readonly find: (name: string, override: Option.Option<string>) => Effect.Effect<Option.Option<string>> }
>() {
  static readonly live = Layer.succeed(Executables, {
    find: (name, override) => Effect.sync(() => findExecutable(name, { override: Option.getOrUndefined(override) })),
  });
}

/**
 * Resolves an agent CLI by name, like `which`: the configured override if any, else the first
 * executable match on PATH (honouring PATHEXT on Windows).
 */
export function findExecutable(name: string, options: FindExecutableOptions = {}): Option.Option<string> {
  const { override, env = process.env, platform = process.platform, isExecutable = isExecutableFile } = options;
  if (override) {
    return Option.liftPredicate(override, isExecutable);
  }

  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const dirs = (env.PATH ?? env.Path ?? '').split(pathApi.delimiter).filter(Boolean);
  const extensions =
    platform === 'win32' ? ['', ...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)] : [''];

  for (const dir of dirs) {
    for (const ext of extensions) {
      const candidate = pathApi.join(dir, name + ext);
      if (isExecutable(candidate)) {
        return Option.some(candidate);
      }
    }
  }
  return Option.none();
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
