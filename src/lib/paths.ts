import fs from "node:fs";
import path from "node:path";

// One place that decides where household files live. Every reader and writer
// goes through these helpers so Docker (DATA_DIR=/data, PHOTO_DIR=/photos)
// and a local checkout (./data) behave the same way.

/** Absolute folder for the database, secrets, covers and avatars. */
export function dataDir(): string {
  return path.resolve(process.env.DATA_DIR || path.join(/* turbopackIgnore: true */ process.cwd(), "data"));
}

/** Absolute folder of screensaver photos. Docker mounts ./photos at PHOTO_DIR. */
export function photoDir(): string {
  return process.env.PHOTO_DIR ? path.resolve(process.env.PHOTO_DIR) : path.join(dataDir(), "photos");
}

export function coversDir(): string {
  return path.join(dataDir(), "covers");
}

export function avatarsDir(): string {
  return path.join(dataDir(), "avatars");
}

/**
 * Read `name` from `base`, but only if the file's real path sits directly in
 * the real `base` folder. A symlink that points elsewhere is refused. The file
 * is then opened with O_NOFOLLOW and read from that descriptor, so a file
 * swapped for a symlink between the check and the read is refused too.
 * Callers validate `name` against a strict pattern first.
 *
 * Out of scope: a local process that can write to the data folder itself
 * (for example one that swaps a parent folder for a symlink mid-read). Such
 * a process can already change the household's files directly.
 */
export function readContained(base: string, name: string): Buffer | null {
  let fd: number | null = null;
  try {
    const realBase = fs.realpathSync(base);
    const real = fs.realpathSync(path.join(base, name));
    if (path.dirname(real) !== realBase) return null;
    fd = fs.openSync(real, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    if (!fs.fstatSync(fd).isFile()) return null;
    return fs.readFileSync(/* turbopackIgnore: true */ fd);
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}
