import { Inode } from "./fd.js";
import * as wasi from "./wasi_defs.js";

export const SYMLOOP_MAX = 40;

export class Symlink extends Inode {
  readonly target: string;

  constructor(target: string) {
    super();
    this.target = target;
  }

  path_open() {
    return { ret: wasi.ERRNO_LOOP, fd_obj: null };
  }

  stat(): wasi.Filestat {
    const size = BigInt(new TextEncoder().encode(this.target).length);
    return this.build_filestat(wasi.FILETYPE_SYMBOLIC_LINK, size);
  }

  readlink(): { ret: number; target: string | null } {
    return { ret: wasi.ERRNO_SUCCESS, target: this.target };
  }
}
