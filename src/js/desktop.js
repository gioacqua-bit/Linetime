/*
 * Linetime — desktop bridge.
 * Copyright (C) 2026 The Linetime authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * When Linetime runs inside the Tauri desktop shell, this file exposes the
 * native layer to the app through the same interface the browser build uses:
 * folder handles that follow the File System Access API (getFileHandle,
 * getDirectoryHandle, entries, removeEntry, createWritable, getFile), plus a
 * key-value store, a native "Save as" dialog, external links and a guard for
 * closing the window with unsaved changes.
 *
 * In a plain browser this file does nothing, and app.js falls back to the
 * browser's own APIs.
 */
(function () {
  "use strict";
  const core = window.__TAURI__ && window.__TAURI__.core;
  if (!core || typeof core.invoke !== "function") return;

  /* Rust errors arrive as "KindError: message"; turn them into DOMExceptions
     so that the app can treat them like browser file-system errors. */
  async function call(cmd, args) {
    try {
      return await core.invoke(cmd, args || {});
    } catch (e) {
      const s = String(e && e.message !== undefined ? e.message : e);
      const m = s.match(/^([A-Za-z]+Error): ([\s\S]*)$/);
      throw new DOMException(m ? m[2] : s, m ? m[1] : "UnknownError");
    }
  }

  /* Forward slashes work as separators on every system, Windows included. */
  const join = (dir, name) => (dir.endsWith("/") || dir.endsWith("\\") ? dir + name : dir + "/" + name);
  const baseName = p => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;

  class FileHandle {
    constructor(path, name) { this.kind = "file"; this.path = path; this.name = name || baseName(path); }
    async getFile() {
      const text = await call("fs_read", { path: this.path });
      const name = this.name;
      return { name, size: text.length, text: async () => text };
    }
    async createWritable() {
      const parts = [];
      const path = this.path;
      return {
        async write(data) {
          if (typeof data === "string") parts.push(data);
          else if (data && typeof data.text === "function") parts.push(await data.text());
          else throw new DOMException("Only text can be written", "TypeMismatchError");
        },
        async close() { await call("fs_write", { path, text: parts.join("") }); },
        async abort() { parts.length = 0; }
      };
    }
    async isSameEntry(other) { return !!other && other.kind === "file" && other.path === this.path; }
  }

  class DirHandle {
    constructor(path, name) { this.kind = "directory"; this.path = path; this.name = name || baseName(path); }
    async getFileHandle(name, opts) {
      const path = join(this.path, name);
      const st = await call("fs_stat", { path });
      if (st.exists && st.dir) throw new DOMException(name + " is a folder", "TypeMismatchError");
      if (!st.exists && !(opts && opts.create)) throw new DOMException(name + " was not found", "NotFoundError");
      return new FileHandle(path, name);
    }
    async getDirectoryHandle(name, opts) {
      const path = join(this.path, name);
      const st = await call("fs_stat", { path });
      if (st.exists && !st.dir) throw new DOMException(name + " is a file", "TypeMismatchError");
      if (!st.exists) {
        if (!(opts && opts.create)) throw new DOMException(name + " was not found", "NotFoundError");
        await call("fs_mkdir", { path });
      }
      return new DirHandle(path, name);
    }
    async *entries() {
      const list = await call("fs_list", { path: this.path });
      for (const e of list) {
        const path = join(this.path, e.name);
        yield [e.name, e.dir ? new DirHandle(path, e.name) : new FileHandle(path, e.name)];
      }
    }
    async removeEntry(name) { await call("fs_remove", { path: join(this.path, name) }); }
    async isSameEntry(other) { return !!other && other.kind === "directory" && other.path === this.path; }
    async queryPermission() { return "granted"; }
    async requestPermission() { return "granted"; }
  }

  /* Folder picker with the same contract as window.showDirectoryPicker. */
  window.showDirectoryPicker = async function (opts) {
    const purpose = opts && opts.id === "linetime-parent" ? "parent" : "project";
    const picked = await call("pick_folder", { purpose });
    if (!picked) throw new DOMException("No folder was chosen", "AbortError");
    return new DirHandle(picked.path, picked.name);
  };

  function bytesToBase64(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  async function saveFile(name, data) {
    const blob = data instanceof Blob ? data : new Blob([data], { type: "text/plain;charset=utf-8" });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return call("save_file", { name, data: bytesToBase64(bytes) });
  }

  /* Links in previews open in the system browser, not inside the app. */
  document.addEventListener("click", e => {
    const a = e.target && e.target.closest && e.target.closest("a[href]");
    if (!a) return;
    const href = a.getAttribute("href") || "";
    if (/^(https?:|mailto:)/i.test(href)) {
      e.preventDefault();
      call("open_external", { url: href }).catch(() => {});
    } else if (!href.startsWith("#")) {
      e.preventDefault();
    }
  }, true);

  /* The native layer calls this when the window is about to close. */
  window.__linetimeCloseRequested = async function (seq) {
    call("close_ack", { seq: seq || 0 }).catch(() => {});
    try {
      if (typeof window.linetimeConfirmQuit === "function" && !(await window.linetimeConfirmQuit())) return;
    } catch (e) { /* if the check fails, closing still has to work */ }
    call("close_window").catch(() => {});
  };

  window.LinetimeDesktop = {
    invoke: call,
    DirHandle,
    FileHandle,
    baseName,
    saveFile,
    kv: {
      ok: true,
      get: key => call("kv_get", { key }).then(v => (v === null ? undefined : v)),
      set: (key, value) => call("kv_set", { key, value: value === undefined ? null : value }),
      del: key => call("kv_del", { key })
    }
  };
  document.documentElement.classList.add("desktop");
})();
