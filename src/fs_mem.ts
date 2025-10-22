import { debug } from "./debug.js";
import * as wasi from "./wasi_defs.js";
import { Fd, Inode } from "./fd.js";
import { Symlink, SYMLOOP_MAX } from "./symlink.js";

function dataResize(data: Uint8Array, newDataSize: number): Uint8Array {
  // reuse same data if not actually resizing
  if (data.byteLength === newDataSize) {
    return data;
  }

  // prefer using
  // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/ArrayBuffer/resize
  // when applicable; can be used to shrink/grow
  if (
    data.buffer instanceof ArrayBuffer &&
    data.buffer.resizable &&
    newDataSize <= data.buffer.maxByteLength
  ) {
    data.buffer.resize(newDataSize);
    return data;
  }

  // shrinking: create a new resizable ArrayBuffer and copy a subset
  // of old data onto it
  if (data.byteLength > newDataSize) {
    const newBuffer = new ArrayBuffer(newDataSize, {
        maxByteLength: newDataSize,
      }),
      newData = new Uint8Array(newBuffer);
    newData.set(new Uint8Array(data.buffer, 0, newDataSize));
    return newData;
  }

  // growing: create a new resizable ArrayBuffer with exponential
  // growth of maxByteLength, to avoid O(n^2) overhead of repeatedly
  // concatenating buffers when doing a lot of small writes at the end
  const newBuffer = new ArrayBuffer(newDataSize, {
      maxByteLength: Math.max(newDataSize, data.buffer.maxByteLength * 2),
    }),
    newData = new Uint8Array(newBuffer);
  newData.set(data);
  return newData;
}

export class OpenFile extends Fd {
  file: File;
  file_pos: bigint = 0n;

  constructor(file: File) {
    super();
    this.file = file;
  }

  fd_allocate(offset: bigint, len: bigint): number {
    if (this.file.size >= offset + len) {
      // already big enough
    } else {
      // extend
      this.file.data = dataResize(this.file.data, Number(offset + len));
    }
    return wasi.ERRNO_SUCCESS;
  }

  fd_fdstat_get(): { ret: number; fdstat: wasi.Fdstat | null } {
    return { ret: 0, fdstat: new wasi.Fdstat(wasi.FILETYPE_REGULAR_FILE, 0) };
  }

  fd_filestat_set_size(size: bigint): number {
    this.file.data = dataResize(this.file.data, Number(size));
    return wasi.ERRNO_SUCCESS;
  }

  fd_read(size: number): { ret: number; data: Uint8Array } {
    const slice = this.file.data.slice(
      Number(this.file_pos),
      Number(this.file_pos + BigInt(size)),
    );
    this.file_pos += BigInt(slice.length);
    return { ret: 0, data: slice };
  }

  fd_pread(size: number, offset: bigint): { ret: number; data: Uint8Array } {
    const slice = this.file.data.slice(
      Number(offset),
      Number(offset + BigInt(size)),
    );
    return { ret: 0, data: slice };
  }

  fd_seek(offset: bigint, whence: number): { ret: number; offset: bigint } {
    let calculated_offset: bigint;
    switch (whence) {
      case wasi.WHENCE_SET:
        calculated_offset = offset;
        break;
      case wasi.WHENCE_CUR:
        calculated_offset = this.file_pos + offset;
        break;
      case wasi.WHENCE_END:
        calculated_offset = BigInt(this.file.data.byteLength) + offset;
        break;
      default:
        return { ret: wasi.ERRNO_INVAL, offset: 0n };
    }

    if (calculated_offset < 0) {
      return { ret: wasi.ERRNO_INVAL, offset: 0n };
    }

    this.file_pos = calculated_offset;
    return { ret: 0, offset: this.file_pos };
  }

  fd_tell(): { ret: number; offset: bigint } {
    return { ret: 0, offset: this.file_pos };
  }

  fd_write(data: Uint8Array): { ret: number; nwritten: number } {
    if (this.file.readonly) return { ret: wasi.ERRNO_BADF, nwritten: 0 };

    if (this.file_pos + BigInt(data.byteLength) > this.file.size) {
      this.file.data = dataResize(
        this.file.data,
        Number(this.file_pos + BigInt(data.byteLength)),
      );
    }

    this.file.data.set(data, Number(this.file_pos));
    this.file_pos += BigInt(data.byteLength);
    return { ret: 0, nwritten: data.byteLength };
  }

  fd_pwrite(data: Uint8Array, offset: bigint) {
    if (this.file.readonly) return { ret: wasi.ERRNO_BADF, nwritten: 0 };

    if (offset + BigInt(data.byteLength) > this.file.size) {
      this.file.data = dataResize(
        this.file.data,
        Number(offset + BigInt(data.byteLength)),
      );
    }

    this.file.data.set(data, Number(offset));
    return { ret: 0, nwritten: data.byteLength };
  }

  fd_filestat_get(): { ret: number; filestat: wasi.Filestat } {
    return { ret: 0, filestat: this.file.stat() };
  }
}

export class OpenDirectory extends Fd {
  dir: Directory;

  constructor(dir: Directory) {
    super();
    this.dir = dir;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  fd_seek(offset: bigint, whence: number): { ret: number; offset: bigint } {
    return { ret: wasi.ERRNO_BADF, offset: 0n };
  }

  fd_tell(): { ret: number; offset: bigint } {
    return { ret: wasi.ERRNO_BADF, offset: 0n };
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  fd_allocate(offset: bigint, len: bigint): number {
    return wasi.ERRNO_BADF;
  }

  fd_fdstat_get(): { ret: number; fdstat: wasi.Fdstat | null } {
    const fdstat = new wasi.Fdstat(wasi.FILETYPE_DIRECTORY, 0);
    const base_rights =
      wasi.RIGHTS_FD_READDIR |
      wasi.RIGHTS_FD_FILESTAT_GET |
      wasi.RIGHTS_PATH_CREATE_DIRECTORY |
      wasi.RIGHTS_PATH_CREATE_FILE |
      wasi.RIGHTS_PATH_LINK_SOURCE |
      wasi.RIGHTS_PATH_LINK_TARGET |
      wasi.RIGHTS_PATH_OPEN |
      wasi.RIGHTS_PATH_READLINK |
      wasi.RIGHTS_PATH_RENAME_SOURCE |
      wasi.RIGHTS_PATH_RENAME_TARGET |
      wasi.RIGHTS_PATH_FILESTAT_GET |
      wasi.RIGHTS_PATH_SYMLINK |
      wasi.RIGHTS_PATH_REMOVE_DIRECTORY |
      wasi.RIGHTS_PATH_UNLINK_FILE;
    fdstat.fs_rights_base = BigInt(base_rights);
    const inheriting_rights =
      wasi.RIGHTS_FD_DATASYNC |
      wasi.RIGHTS_FD_READ |
      wasi.RIGHTS_FD_SEEK |
      wasi.RIGHTS_FD_TELL |
      wasi.RIGHTS_FD_WRITE |
      wasi.RIGHTS_FD_FILESTAT_GET |
      wasi.RIGHTS_FD_FILESTAT_SET_SIZE |
      wasi.RIGHTS_FD_FILESTAT_SET_TIMES |
      wasi.RIGHTS_FD_SYNC |
      wasi.RIGHTS_FD_ADVISE |
      wasi.RIGHTS_FD_ALLOCATE |
      wasi.RIGHTS_PATH_FILESTAT_GET |
      wasi.RIGHTS_PATH_READLINK;
    fdstat.fs_rights_inherited = BigInt(inheriting_rights);
    return { ret: 0, fdstat };
  }

  fd_readdir_single(cookie: bigint): {
    ret: number;
    dirent: wasi.Dirent | null;
  } {
    if (debug.enabled) {
      debug.log("readdir_single", cookie);
      debug.log(cookie, this.dir.contents.keys());
    }

    if (cookie == 0n) {
      return {
        ret: wasi.ERRNO_SUCCESS,
        dirent: new wasi.Dirent(1n, this.dir.ino, ".", wasi.FILETYPE_DIRECTORY),
      };
    } else if (cookie == 1n) {
      return {
        ret: wasi.ERRNO_SUCCESS,
        dirent: new wasi.Dirent(
          2n,
          this.dir.parent_ino(),
          "..",
          wasi.FILETYPE_DIRECTORY,
        ),
      };
    }

    if (cookie >= BigInt(this.dir.contents.size) + 2n) {
      return { ret: 0, dirent: null };
    }

    const [name, entry] = Array.from(this.dir.contents.entries())[
      Number(cookie - 2n)
    ];

    return {
      ret: 0,
      dirent: new wasi.Dirent(
        cookie + 1n,
        entry.ino,
        name,
        entry.stat().filetype,
      ),
    };
  }

  path_filestat_get(
    flags: number,
    path_str: string,
  ): { ret: number; filestat: wasi.Filestat | null } {
    const { ret: path_err, path } = Path.from(path_str);
    if (path == null) {
      return { ret: path_err, filestat: null };
    }

    const follow =
      (flags & wasi.LOOKUPFLAGS_SYMLINK_FOLLOW) ==
      wasi.LOOKUPFLAGS_SYMLINK_FOLLOW;

    const { ret, entry } = this.dir.get_entry_for_path(path, follow);
    if (entry == null) {
      return { ret, filestat: null };
    }

    return { ret: wasi.ERRNO_SUCCESS, filestat: entry.stat() };
  }

  path_filestat_set_times(
    flags: number,
    path_str: string,
    atim: bigint,
    mtim: bigint,
    fst_flags: number,
  ): number {
    const { ret: path_err, path } = Path.from(path_str);
    if (path == null) {
      return path_err;
    }

    const follow =
      path.is_dir ||
      (flags & wasi.LOOKUPFLAGS_SYMLINK_FOLLOW) ==
        wasi.LOOKUPFLAGS_SYMLINK_FOLLOW;

    const { ret, entry } = this.dir.get_entry_for_path(path, follow);
    if (entry == null) {
      return ret;
    }

    return entry.set_times(atim, mtim, fst_flags);
  }

  path_lookup(
    path_str: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    dirflags: number,
  ): { ret: number; inode_obj: Inode | null } {
    if (
      (dirflags & wasi.LOOKUPFLAGS_SYMLINK_FOLLOW) ==
      wasi.LOOKUPFLAGS_SYMLINK_FOLLOW
    ) {
      return { ret: wasi.ERRNO_INVAL, inode_obj: null };
    }
    const { ret: path_ret, path } = Path.from(path_str);
    if (path == null) {
      return { ret: path_ret, inode_obj: null };
    }

    const { ret, entry } = this.dir.get_entry_for_path(path, false);
    if (entry == null) {
      return { ret, inode_obj: null };
    }

    return { ret: wasi.ERRNO_SUCCESS, inode_obj: entry };
  }

  path_open(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    dirflags: number,
    path_str: string,
    oflags: number,
    fs_rights_base: bigint,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    fs_rights_inheriting: bigint,
    fd_flags: number,
  ): { ret: number; fd_obj: Fd | null } {
    const { ret: path_ret, path } = Path.from(path_str);
    if (path == null) {
      return { ret: path_ret, fd_obj: null };
    }

    const followFinal =
      path.is_dir ||
      ((dirflags & wasi.LOOKUPFLAGS_SYMLINK_FOLLOW) ==
        wasi.LOOKUPFLAGS_SYMLINK_FOLLOW);

    // eslint-disable-next-line prefer-const
    let { ret, entry } = this.dir.get_entry_for_path(path, followFinal);
    if (entry == null) {
      if (ret != wasi.ERRNO_NOENT) {
        return { ret, fd_obj: null };
      }
      if ((oflags & wasi.OFLAGS_CREAT) == wasi.OFLAGS_CREAT) {
        // doesn't exist, but shall be created
        const { ret, entry: new_entry } = this.dir.create_entry_for_path(
          path_str,
          (oflags & wasi.OFLAGS_DIRECTORY) == wasi.OFLAGS_DIRECTORY,
        );
        if (new_entry == null) {
          return { ret, fd_obj: null };
        }
        entry = new_entry;
      } else {
        // doesn't exist, no such file
        return { ret: wasi.ERRNO_NOENT, fd_obj: null };
      }
    } else if ((oflags & wasi.OFLAGS_EXCL) == wasi.OFLAGS_EXCL) {
      // was supposed to be created exclusively, but exists already
      return { ret: wasi.ERRNO_EXIST, fd_obj: null };
    }

    if (entry instanceof Symlink) {
      return { ret: wasi.ERRNO_LOOP, fd_obj: null };
    }

    if (
      (oflags & wasi.OFLAGS_DIRECTORY) == wasi.OFLAGS_DIRECTORY &&
      entry.stat().filetype !== wasi.FILETYPE_DIRECTORY
    ) {
      // expected a directory but the file is not a directory
      return { ret: wasi.ERRNO_NOTDIR, fd_obj: null };
    }
    return entry.path_open(oflags, fs_rights_base, fd_flags);
  }

  path_create_directory(path: string): number {
    return this.path_open(
      0,
      path,
      wasi.OFLAGS_CREAT | wasi.OFLAGS_DIRECTORY,
      0n,
      0n,
      0,
    ).ret;
  }

  path_link(path_str: string, inode: Inode, allow_dir: boolean): number {
    const { ret: path_ret, path } = Path.from(path_str);
    if (path == null) {
      return path_ret;
    }

    if (path.is_dir) {
      return wasi.ERRNO_NOENT;
    }

    const {
      ret: parent_ret,
      parent_entry,
      filename,
      entry,
    } = this.dir.get_parent_dir_and_entry_for_path(path, true);
    if (parent_entry == null || filename == null) {
      return parent_ret;
    }

    if (entry != null) {
      const source_is_dir = inode.stat().filetype == wasi.FILETYPE_DIRECTORY;
      const target_is_dir = entry.stat().filetype == wasi.FILETYPE_DIRECTORY;
      if (source_is_dir && target_is_dir) {
        if (allow_dir && entry instanceof Directory) {
          if (entry.contents.size == 0) {
            // Allow overwriting empty directories
          } else {
            return wasi.ERRNO_NOTEMPTY;
          }
        } else {
          return wasi.ERRNO_EXIST;
        }
      } else if (source_is_dir && !target_is_dir) {
        return wasi.ERRNO_NOTDIR;
      } else if (!source_is_dir && target_is_dir) {
        return wasi.ERRNO_ISDIR;
      } else if (
        inode.stat().filetype == wasi.FILETYPE_REGULAR_FILE &&
        entry.stat().filetype == wasi.FILETYPE_REGULAR_FILE
      ) {
        // Overwriting regular files is fine
      } else {
        return wasi.ERRNO_EXIST;
      }
    }

    if (!allow_dir && inode.stat().filetype == wasi.FILETYPE_DIRECTORY) {
      return wasi.ERRNO_PERM;
    }

    if (inode instanceof Directory) {
      inode.set_parent(parent_entry);
    }
    parent_entry.contents.set(filename, inode);

    return wasi.ERRNO_SUCCESS;
  }

  path_readlink(path_str: string): { ret: number; data: string | null } {
    const { ret: path_ret, path } = Path.from(path_str);
    if (path == null) {
      return { ret: path_ret, data: null };
    }

    const { ret, entry } = this.dir.get_entry_for_path(path, false);
    if (entry == null) {
      return { ret, data: null };
    }

    if (!(entry instanceof Symlink)) {
      return { ret: wasi.ERRNO_INVAL, data: null };
    }

    return { ret: wasi.ERRNO_SUCCESS, data: entry.target };
  }

  path_unlink(path_str: string): { ret: number; inode_obj: Inode | null } {
    const { ret: path_ret, path } = Path.from(path_str);
    if (path == null) {
      return { ret: path_ret, inode_obj: null };
    }

    const {
      ret: parent_ret,
      parent_entry,
      filename,
      entry,
    } = this.dir.get_parent_dir_and_entry_for_path(path, true);
    if (parent_entry == null || filename == null) {
      return { ret: parent_ret, inode_obj: null };
    }

    if (entry == null) {
      return { ret: wasi.ERRNO_NOENT, inode_obj: null };
    }

    parent_entry.contents.delete(filename);

    return { ret: wasi.ERRNO_SUCCESS, inode_obj: entry };
  }

  path_unlink_file(path_str: string): number {
    const { ret: path_ret, path } = Path.from(path_str);
    if (path == null) {
      return path_ret;
    }
    const expect_dir = path.is_dir;

    const {
      ret: parent_ret,
      parent_entry,
      filename,
      entry,
    } = this.dir.get_parent_dir_and_entry_for_path(path, false);
    if (parent_entry == null || filename == null || entry == null) {
      return parent_ret;
    }
    if (entry.stat().filetype === wasi.FILETYPE_DIRECTORY) {
      return wasi.ERRNO_ISDIR;
    }
    if (expect_dir) {
      return wasi.ERRNO_NOTDIR;
    }
    parent_entry.contents.delete(filename);
    return wasi.ERRNO_SUCCESS;
  }

  path_remove_directory(path_str: string): number {
    const { ret: path_ret, path } = Path.from(path_str);
    if (path == null) {
      return path_ret;
    }

    const {
      ret: parent_ret,
      parent_entry,
      filename,
      entry,
    } = this.dir.get_parent_dir_and_entry_for_path(path, false);
    if (parent_entry == null || filename == null || entry == null) {
      return parent_ret;
    }

    if (
      !(entry instanceof Directory) ||
      entry.stat().filetype !== wasi.FILETYPE_DIRECTORY
    ) {
      return wasi.ERRNO_NOTDIR;
    }
    if (entry.contents.size !== 0) {
      return wasi.ERRNO_NOTEMPTY;
    }
    if (!parent_entry.contents.delete(filename)) {
      return wasi.ERRNO_NOENT;
    }
    return wasi.ERRNO_SUCCESS;
  }

  path_symlink(old_path: string, new_path: string): number {
    const { ret, entry } = this.dir.create_symlink_for_path(
      new_path,
      old_path,
    );
    if (entry == null) {
      return ret;
    }
    return wasi.ERRNO_SUCCESS;
  }

  fd_filestat_get(): { ret: number; filestat: wasi.Filestat } {
    return { ret: 0, filestat: this.dir.stat() };
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  fd_filestat_set_size(size: bigint): number {
    return wasi.ERRNO_BADF;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  fd_read(size: number): { ret: number; data: Uint8Array } {
    return { ret: wasi.ERRNO_BADF, data: new Uint8Array() };
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  fd_pread(size: number, offset: bigint): { ret: number; data: Uint8Array } {
    return { ret: wasi.ERRNO_BADF, data: new Uint8Array() };
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  fd_write(data: Uint8Array): { ret: number; nwritten: number } {
    return { ret: wasi.ERRNO_BADF, nwritten: 0 };
  }

  fd_pwrite(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    data: Uint8Array,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    offset: bigint,
  ): { ret: number; nwritten: number } {
    return { ret: wasi.ERRNO_BADF, nwritten: 0 };
  }
}

export class PreopenDirectory extends OpenDirectory {
  prestat_name: string;

  constructor(name: string, contents: Map<string, Inode>) {
    super(new Directory(contents));
    this.prestat_name = name;
  }

  fd_prestat_get(): { ret: number; prestat: wasi.Prestat | null } {
    return {
      ret: 0,
      prestat: wasi.Prestat.dir(this.prestat_name),
    };
  }
}

export class File extends Inode {
  data: Uint8Array;
  readonly: boolean;

  constructor(
    data: ArrayBufferLike | ArrayLike<number>,
    options?: Partial<{
      readonly: boolean;
    }>,
  ) {
    super();
    this.data = new Uint8Array(data as ArrayLike<number>);
    this.readonly = !!options?.readonly;
  }

  path_open(oflags: number, fs_rights_base: bigint, fd_flags: number) {
    if (
      this.readonly &&
      (fs_rights_base & BigInt(wasi.RIGHTS_FD_WRITE)) ==
        BigInt(wasi.RIGHTS_FD_WRITE)
    ) {
      // no write permission to file
      return { ret: wasi.ERRNO_PERM, fd_obj: null };
    }

    if ((oflags & wasi.OFLAGS_TRUNC) == wasi.OFLAGS_TRUNC) {
      if (this.readonly) return { ret: wasi.ERRNO_PERM, fd_obj: null };
      this.data = new Uint8Array([]);
    }

    const file = new OpenFile(this);
    if (fd_flags & wasi.FDFLAGS_APPEND) file.fd_seek(0n, wasi.WHENCE_END);
    return { ret: wasi.ERRNO_SUCCESS, fd_obj: file };
  }

  get size(): bigint {
    return BigInt(this.data.byteLength);
  }

  stat(): wasi.Filestat {
    return this.build_filestat(wasi.FILETYPE_REGULAR_FILE, this.size);
  }
}

class Path {
  parts: string[] = [];
  is_dir: boolean = false;

  static from(path: string): { ret: number; path: Path | null } {
    const self = new Path();
    self.is_dir = path.endsWith("/");

    if (path.startsWith("/")) {
      return { ret: wasi.ERRNO_NOTCAPABLE, path: null };
    }
    if (path.includes("\0")) {
      return { ret: wasi.ERRNO_INVAL, path: null };
    }

    for (const component of path.split("/")) {
      if (component === "" || component === ".") {
        continue;
      }
      if (component === "..") {
        if (self.parts.pop() == undefined) {
          return { ret: wasi.ERRNO_NOTCAPABLE, path: null };
        }
        continue;
      }
      self.parts.push(component);
    }

    return { ret: wasi.ERRNO_SUCCESS, path: self };
  }

  to_path_string(): string {
    let s = this.parts.join("/");
    if (this.is_dir) {
      s += "/";
    }
    return s;
  }
}

export class Directory extends Inode {
  contents: Map<string, Inode>;
  private parent: Directory | null = null;

  constructor(contents: Map<string, Inode> | [string, Inode][]) {
    super();
    if (contents instanceof Array) {
      this.contents = new Map(contents);
    } else {
      this.contents = contents;
    }

    for (const entry of this.contents.values()) {
      if (entry instanceof Directory) {
        entry.set_parent(this);
      }
    }
  }

  set_parent(parent: Directory | null) {
    this.parent = parent;
  }

  parent_ino(): bigint {
    if (this.parent == null) {
      return Inode.root_ino();
    }
    return this.parent.ino;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  path_open(oflags: number, fs_rights_base: bigint, fd_flags: number) {
    return { ret: wasi.ERRNO_SUCCESS, fd_obj: new OpenDirectory(this) };
  }

  stat(): wasi.Filestat {
    return this.build_filestat(wasi.FILETYPE_DIRECTORY, 0n);
  }

  private resolve_path(
    path: Path,
    followFinal: boolean,
  ): { ret: number; entry: Inode | null } {
    return this.resolve_path_from(
      this,
      path.parts,
      path.is_dir,
      followFinal,
      0,
    );
  }

  private resolve_path_from(
    current: Directory,
    parts: string[],
    isDir: boolean,
    followFinal: boolean,
    depth: number,
  ): { ret: number; entry: Inode | null } {
    if (parts.length === 0) {
      if (isDir && current.stat().filetype !== wasi.FILETYPE_DIRECTORY) {
        return { ret: wasi.ERRNO_NOTDIR, entry: null };
      }
      return { ret: wasi.ERRNO_SUCCESS, entry: current };
    }

    const [component, ...rest] = parts;
    const child = current.contents.get(component);
    if (child === undefined) {
      debug.log(component);
      return { ret: wasi.ERRNO_NOENT, entry: null };
    }

    const hasRest = rest.length > 0;
    const restStr = Directory.partsToPathString(rest, isDir);

    if (child instanceof Symlink) {
      const shouldFollow = hasRest ? true : followFinal || isDir;
      if (!shouldFollow) {
        if (hasRest || isDir) {
          return { ret: wasi.ERRNO_NOTDIR, entry: null };
        }
        return { ret: wasi.ERRNO_SUCCESS, entry: child };
      }

      if (depth >= SYMLOOP_MAX) {
        return { ret: wasi.ERRNO_LOOP, entry: null };
      }

      let targetPath = child.target;
      if (restStr.length > 0) {
        targetPath = Directory.joinPaths(targetPath, restStr);
      } else if (isDir && !targetPath.endsWith("/")) {
        targetPath += "/";
      }

      const { ret: targetRet, path: targetResolved } = Path.from(targetPath);
      if (targetResolved == null) {
        return { ret: targetRet, entry: null };
      }

      return this.resolve_path_from(
        current,
        targetResolved.parts,
        targetResolved.is_dir,
        followFinal,
        depth + 1,
      );
    }

    if (!hasRest) {
      if (isDir && child.stat().filetype !== wasi.FILETYPE_DIRECTORY) {
        return { ret: wasi.ERRNO_NOTDIR, entry: null };
      }
      return { ret: wasi.ERRNO_SUCCESS, entry: child };
    }

    if (!(child instanceof Directory)) {
      return { ret: wasi.ERRNO_NOTDIR, entry: null };
    }

    return this.resolve_path_from(child, rest, isDir, followFinal, depth);
  }

  private static partsToPathString(parts: string[], isDir: boolean): string {
    if (parts.length === 0) {
      return "";
    }
    let s = parts.join("/");
    if (isDir) {
      s += "/";
    }
    return s;
  }

  private static joinPaths(base: string, addition: string): string {
    if (base.length === 0) {
      return addition;
    }
    if (addition.length === 0) {
      return base;
    }
    if (base.endsWith("/")) {
      return base + addition;
    }
    return `${base}/${addition}`;
  }

  get_entry_for_path(
    path: Path,
    followFinal: boolean = true,
  ): { ret: number; entry: Inode | null } {
    return this.resolve_path(path, followFinal);
  }

  get_parent_dir_and_entry_for_path(
    path: Path,
    allow_undefined: boolean,
  ): {
    ret: number;
    parent_entry: Directory | null;
    filename: string | null;
    entry: Inode | null;
  } {
    const filename = path.parts.pop();

    if (filename === undefined) {
      return {
        ret: wasi.ERRNO_INVAL,
        parent_entry: null,
        filename: null,
        entry: null,
      };
    }

    const { ret: parent_ret, entry: parent_entry } = this.resolve_path_from(
      this,
      path.parts,
      true,
      true,
      0,
    );
    if (parent_entry == null) {
      return {
        ret: parent_ret,
        parent_entry: null,
        filename: null,
        entry: null,
      };
    }
    if (!(parent_entry instanceof Directory)) {
      return {
        ret: wasi.ERRNO_NOTDIR,
        parent_entry: null,
        filename: null,
        entry: null,
      };
    }
    const entry = parent_entry.contents.get(filename);
    if (entry === undefined) {
      if (!allow_undefined) {
        return {
          ret: wasi.ERRNO_NOENT,
          parent_entry: null,
          filename: null,
          entry: null,
        };
      }
      return {
        ret: wasi.ERRNO_SUCCESS,
        parent_entry,
        filename,
        entry: null,
      };
    }

    return { ret: wasi.ERRNO_SUCCESS, parent_entry, filename, entry };
  }

  create_entry_for_path(
    path_str: string,
    is_dir: boolean,
  ): { ret: number; entry: Inode | null } {
    const { ret: path_ret, path } = Path.from(path_str);
    if (path == null) {
      return { ret: path_ret, entry: null };
    }

    const {
      ret: parent_ret,
      parent_entry,
      filename,
      entry,
    } = this.get_parent_dir_and_entry_for_path(path, true);
    if (parent_entry == null || filename == null) {
      return { ret: parent_ret, entry: null };
    }

    if (entry != null) {
      return { ret: wasi.ERRNO_EXIST, entry: null };
    }

    let new_child: Inode;
    if (is_dir) {
      const child_dir = new Directory(new Map());
      child_dir.set_parent(parent_entry);
      new_child = child_dir;
    } else {
      new_child = new File(new ArrayBuffer(0));
    }
    parent_entry.contents.set(filename, new_child);

    return { ret: wasi.ERRNO_SUCCESS, entry: new_child };
  }

  create_symlink_for_path(
    path_str: string,
    target: string,
  ): { ret: number; entry: Inode | null } {
    if (target.includes("\0") || target.startsWith("/")) {
      return { ret: wasi.ERRNO_INVAL, entry: null };
    }

    const { ret: path_ret, path } = Path.from(path_str);
    if (path == null) {
      return { ret: path_ret, entry: null };
    }

    const {
      ret: parent_ret,
      parent_entry,
      filename,
      entry,
    } = this.get_parent_dir_and_entry_for_path(path, true);
    if (parent_entry == null || filename == null) {
      return { ret: parent_ret, entry: null };
    }

    if (path.is_dir) {
      if (entry == null) {
        return { ret: wasi.ERRNO_NOENT, entry: null };
      }
      if (entry.stat().filetype === wasi.FILETYPE_DIRECTORY) {
        return { ret: wasi.ERRNO_EXIST, entry: null };
      }
      return { ret: wasi.ERRNO_NOTDIR, entry: null };
    }

    if (entry != null) {
      return { ret: wasi.ERRNO_EXIST, entry: null };
    }

    const symlink = new Symlink(target);
    parent_entry.contents.set(filename, symlink);
    return { ret: wasi.ERRNO_SUCCESS, entry: symlink };
  }
}

export class ConsoleStdout extends Fd {
  private ino: bigint;
  write: (buffer: Uint8Array) => void;

  constructor(write: (buffer: Uint8Array) => void) {
    super();
    this.ino = Inode.issue_ino();
    this.write = write;
  }

  fd_filestat_get(): { ret: number; filestat: wasi.Filestat } {
    const filestat = new wasi.Filestat(
      this.ino,
      wasi.FILETYPE_CHARACTER_DEVICE,
      BigInt(0),
    );
    return { ret: 0, filestat };
  }

  fd_fdstat_get(): { ret: number; fdstat: wasi.Fdstat | null } {
    const fdstat = new wasi.Fdstat(wasi.FILETYPE_CHARACTER_DEVICE, 0);
    fdstat.fs_rights_base = BigInt(wasi.RIGHTS_FD_WRITE);
    return { ret: 0, fdstat };
  }

  fd_write(data: Uint8Array): { ret: number; nwritten: number } {
    this.write(data);
    return { ret: 0, nwritten: data.byteLength };
  }

  static lineBuffered(write: (line: string) => void): ConsoleStdout {
    const dec = new TextDecoder("utf-8", { fatal: false });
    let line_buf = "";
    return new ConsoleStdout((buffer) => {
      line_buf += dec.decode(buffer, { stream: true });
      const lines = line_buf.split("\n");
      for (const [i, line] of lines.entries()) {
        if (i < lines.length - 1) {
          write(line);
        } else {
          line_buf = line;
        }
      }
    });
  }
}
