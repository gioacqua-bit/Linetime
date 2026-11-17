// Linetime — test double for the native layer.
// Copyright (C) 2026 The Linetime authors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Injected before the page loads. It defines window.__TAURI__.core.invoke with
// the same commands and error format as src-tauri/src/lib.rs, backed by an
// in-memory file system, so that the interface can be tested in Chromium and
// WebKit (the engine of macOS's system webview) without building the app.
// State survives reloads through sessionStorage.

(function () {
  const KEY = "__linetimeMock";
  const seed = window.__LINETIME_MOCK_SEED__ || { files: {}, roots: [], picks: [] };
  let st;
  try { st = JSON.parse(sessionStorage.getItem(KEY)); } catch (e) { st = null; }
  if (!st) st = { files: seed.files, dirs: seed.dirs || [], roots: seed.roots, picks: seed.picks, kv: {}, calls: [], saved: [], opened: [], closed: 0, acks: [] };
  const persist = () => sessionStorage.setItem(KEY, JSON.stringify(st));
  persist();

  const norm = p => p.replace(/\/+$/, "");
  const parent = p => p.slice(0, p.lastIndexOf("/")) || "/";
  const fail = (kind, msg) => Promise.reject(`${kind}: ${msg}`);
  const isDir = p => st.dirs.includes(p);
  const isFile = p => Object.prototype.hasOwnProperty.call(st.files, p);
  function check(p) {
    p = norm(p);
    if (!p.startsWith("/")) throw `SecurityError: the path must be absolute`;
    if (p.split("/").includes("..")) throw `SecurityError: the path may not contain ..`;
    if (!st.roots.some(r => p === r || p.startsWith(r + "/"))) throw `NotAllowedError: ${p} is outside the folders opened in Linetime`;
    return p;
  }

  const handlers = {
    pick_folder() {
      const p = st.picks.shift();
      if (!p) return null;
      if (!st.roots.includes(p)) st.roots.push(p);
      return { path: p, name: p.split("/").pop() };
    },
    fs_stat({ path }) { const p = check(path); return { exists: isDir(p) || isFile(p), dir: isDir(p) }; },
    fs_list({ path }) {
      const p = check(path);
      if (!isDir(p)) throw `NotFoundError: ${p}`;
      const kids = [...st.dirs.filter(d => parent(d) === p).map(d => ({ name: d.split("/").pop(), dir: true })),
                    ...Object.keys(st.files).filter(f => parent(f) === p).map(f => ({ name: f.split("/").pop(), dir: false }))];
      return kids.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    },
    fs_read({ path }) { const p = check(path); if (!isFile(p)) throw `NotFoundError: ${p} was not found`; return st.files[p]; },
    fs_write({ path, text }) {
      const p = check(path);
      if (isDir(p)) throw `TypeMismatchError: ${p} is a folder`;
      if (!isDir(parent(p))) throw `NotFoundError: ${parent(p)}`;
      st.files[p] = text;
    },
    fs_mkdir({ path }) { const p = check(path); if (isFile(p)) throw `InvalidModificationError: ${p}`; if (!isDir(p)) st.dirs.push(p); },
    fs_remove({ path }) {
      const p = check(path);
      if (isDir(p)) throw `TypeMismatchError: ${p} is a folder; Linetime only deletes files`;
      if (!isFile(p)) throw `NotFoundError: ${p}`;
      delete st.files[p];
    },
    save_file({ name, data }) { st.saved.push({ name, data }); return name; },
    open_external({ url }) { st.opened.push(url); },
    kv_get({ key }) { return Object.prototype.hasOwnProperty.call(st.kv, key) ? st.kv[key] : null; },
    kv_set({ key, value }) { if (value === null) delete st.kv[key]; else st.kv[key] = value; },
    kv_del({ key }) { delete st.kv[key]; },
    close_ack({ seq }) { st.acks.push(seq); },
    close_window() { st.closed += 1; },
    smoke_info() { return null; },
    smoke_report() {}
  };

  window.__TAURI__ = {
    core: {
      invoke(cmd, args) {
        st.calls.push(cmd);
        const h = handlers[cmd];
        if (!h) return fail("UnknownError", "unknown command " + cmd);
        try {
          const r = h(args || {});
          persist();
          return Promise.resolve(r === undefined ? null : r);
        } catch (e) {
          persist();
          return Promise.reject(String(e));
        }
      }
    }
  };
  window.__linetimeMock = {
    state: () => st,
    setNextPick: p => { st.picks = [p]; persist(); }
  };
})();
