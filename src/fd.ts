/* eslint @typescript-eslint/no-unused-vars:0 */
import * as wasi from "./wasi_defs.js";

function now(): bigint {
  return BigInt(Date.now()) * 1_000_000n;
}

export abstract class Fd {
  fd_allocate(offset: bigint, len: bigint): number {
    return wasi.ERRNO_NOTSUP;
  }
  fd_close(): number {
    return 0;
  }
  fd_fdstat_get(): { ret: number; fdstat: wasi.Fdstat | null } {
    return { ret: wasi.ERRNO_NOTSUP, fdstat: null };
  }
  fd_fdstat_set_flags(flags: number): number {
    return wasi.ERRNO_NOTSUP;
  }
  fd_fdstat_set_rights(
    fs_rights_base: bigint,
    fs_rights_inheriting: bigint,
  ): number {
    return wasi.ERRNO_NOTSUP;
  }
  fd_filestat_get(): { ret: number; filestat: wasi.Filestat | null } {
    return { ret: wasi.ERRNO_NOTSUP, filestat: null };
  }
  fd_filestat_set_size(size: bigint): number {
    return wasi.ERRNO_NOTSUP;
  }
  fd_filestat_set_times(atim: bigint, mtim: bigint, fst_flags: number): number {
    return wasi.ERRNO_NOTSUP;
  }
  fd_pread(size: number, offset: bigint): { ret: number; data: Uint8Array } {
    return { ret: wasi.ERRNO_NOTSUP, data: new Uint8Array() };
  }
  fd_prestat_get(): { ret: number; prestat: wasi.Prestat | null } {
    return { ret: wasi.ERRNO_NOTSUP, prestat: null };
  }
  fd_pwrite(
    data: Uint8Array,
    offset: bigint,
  ): { ret: number; nwritten: number } {
    return { ret: wasi.ERRNO_NOTSUP, nwritten: 0 };
  }
  fd_read(size: number): { ret: number; data: Uint8Array } {
    return { ret: wasi.ERRNO_NOTSUP, data: new Uint8Array() };
  }
  fd_readdir_single(cookie: bigint): {
    ret: number;
    dirent: wasi.Dirent | null;
  } {
    return { ret: wasi.ERRNO_NOTSUP, dirent: null };
  }
  fd_seek(offset: bigint, whence: number): { ret: number; offset: bigint } {
    return { ret: wasi.ERRNO_NOTSUP, offset: 0n };
  }
  fd_sync(): number {
    return 0;
  }
  fd_tell(): { ret: number; offset: bigint } {
    return { ret: wasi.ERRNO_NOTSUP, offset: 0n };
  }
  fd_write(data: Uint8Array): { ret: number; nwritten: number } {
    return { ret: wasi.ERRNO_NOTSUP, nwritten: 0 };
  }
  path_create_directory(path: string): number {
    return wasi.ERRNO_NOTSUP;
  }
  path_filestat_get(
    flags: number,
    path: string,
  ): { ret: number; filestat: wasi.Filestat | null } {
    return { ret: wasi.ERRNO_NOTSUP, filestat: null };
  }
  path_filestat_set_times(
    flags: number,
    path: string,
    atim: bigint,
    mtim: bigint,
    fst_flags: number,
  ): number {
    return wasi.ERRNO_NOTSUP;
  }
  path_link(path: string, inode: Inode, allow_dir: boolean): number {
    return wasi.ERRNO_NOTSUP;
  }
  path_unlink(path: string): { ret: number; inode_obj: Inode | null } {
    return { ret: wasi.ERRNO_NOTSUP, inode_obj: null };
  }
  path_lookup(
    path: string,
    dirflags: number,
  ): { ret: number; inode_obj: Inode | null } {
    return { ret: wasi.ERRNO_NOTSUP, inode_obj: null };
  }
  path_open(
    dirflags: number,
    path: string,
    oflags: number,
    fs_rights_base: bigint,
    fs_rights_inheriting: bigint,
    fd_flags: number,
  ): { ret: number; fd_obj: Fd | null } {
    return { ret: wasi.ERRNO_NOTDIR, fd_obj: null };
  }
  path_readlink(path: string): { ret: number; data: string | null } {
    return { ret: wasi.ERRNO_NOTSUP, data: null };
  }
  path_remove_directory(path: string): number {
    return wasi.ERRNO_NOTSUP;
  }
  path_symlink(old_path: string, new_path: string): number {
    return wasi.ERRNO_NOTSUP;
  }
  path_rename(old_path: string, new_fd: number, new_path: string): number {
    return wasi.ERRNO_NOTSUP;
  }
  path_unlink_file(path: string): number {
    return wasi.ERRNO_NOTSUP;
  }
}

export abstract class Inode {
  ino: bigint;
  protected atim: bigint;
  protected mtim: bigint;
  protected ctim: bigint;

  constructor() {
    this.ino = Inode.issue_ino();
    const time = now();
    this.atim = time;
    this.mtim = time;
    this.ctim = time;
  }

  // NOTE: ino 0 is reserved for the root directory
  private static next_ino: bigint = 1n;
  static issue_ino(): bigint {
    return Inode.next_ino++;
  }
  static root_ino(): bigint {
    return 0n;
  }

  abstract path_open(
    oflags: number,
    fs_rights_base: bigint,
    fd_flags: number,
  ): { ret: number; fd_obj: Fd | null };

  abstract stat(): wasi.Filestat;

  readlink(): { ret: number; target: string | null } {
    return { ret: wasi.ERRNO_INVAL, target: null };
  }

  protected build_filestat(
    filetype: number,
    size: bigint,
  ): wasi.Filestat {
    const stat = new wasi.Filestat(this.ino, filetype, size);
    stat.nlink = 1n;
    stat.atim = this.atim;
    stat.mtim = this.mtim;
    stat.ctim = this.ctim;
    return stat;
  }

  protected markAccessed(): void {
    this.atim = now();
  }

  protected markModified(): void {
    const time = now();
    this.mtim = time;
    this.ctim = time;
  }

  set_times(atim: bigint, mtim: bigint, fst_flags: number): number {
    const atim_set = (fst_flags & wasi.FSTFLAGS_ATIM) == wasi.FSTFLAGS_ATIM;
    const atim_now =
      (fst_flags & wasi.FSTFLAGS_ATIM_NOW) == wasi.FSTFLAGS_ATIM_NOW;
    const mtim_set = (fst_flags & wasi.FSTFLAGS_MTIM) == wasi.FSTFLAGS_MTIM;
    const mtim_now =
      (fst_flags & wasi.FSTFLAGS_MTIM_NOW) == wasi.FSTFLAGS_MTIM_NOW;

    if ((atim_set && atim_now) || (mtim_set && mtim_now)) {
      return wasi.ERRNO_INVAL;
    }

    const time_now = now();
    let changed = false;

    if (atim_now) {
      this.atim = time_now;
      changed = true;
    } else if (atim_set) {
      this.atim = atim;
      changed = true;
    }

    if (mtim_now) {
      this.mtim = time_now;
      changed = true;
    } else if (mtim_set) {
      this.mtim = mtim;
      changed = true;
    }

    if (changed) {
      this.ctim = time_now;
    }

    return wasi.ERRNO_SUCCESS;
  }
}
