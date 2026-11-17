/*
 * Linetime — in-app smoke test.
 * Copyright (C) 2026 The Linetime authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Inert in normal use. When the desktop app is started with the environment
 * variable LINETIME_SMOKE_DIR pointing to a fixture project, this script
 * drives the real app inside the real system webview (WebKit on macOS and
 * Linux, WebView2 on Windows) against real files, then reports the result to
 * the native layer, which prints it and exits. See scripts/smoke.mjs.
 */
(function () {
  "use strict";
  if (!window.LinetimeDesktop) return;
  const D = window.LinetimeDesktop;

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  async function until(cond, what, ms = 8000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { try { if (await cond()) return; } catch (e) { /* retry */ } await sleep(50); }
    throw new Error("Timed out waiting for " + what);
  }

  async function run(dir) {
    const log = [];
    const check = (ok, label) => { log.push((ok ? "ok   " : "FAIL ") + label); if (!ok) throw new Error(label); };
    const read = rel => D.invoke("fs_read", { path: dir + "/" + rel });
    try {
      await until(() => document.readyState === "complete", "page load");
      await document.fonts.ready;
      check(typeof FS !== "undefined" && FS === true && DESKTOP === true, "desktop bridge active");
      const faces = [];
      for (const f of ["16px Literata", "italic 16px Literata", "500 16px Literata", "16px Jost"]) faces.push(...(await document.fonts.load(f, "Aé")));
      check(faces.length >= 4 && faces.every(f => f.status === "loaded"), "bundled fonts load");
      check(getComputedStyle(document.body).fontFamily.includes("Jost"), "stylesheet applied");
      check(words("Café naïve well-known, 2,000 — ok") === 5, "Unicode word count");

      await openEntry({ key: "smoke", source: "folder", handle: new D.DirHandle(dir) });
      await until(() => cur && pieces.length === 3, "project to open");
      check(document.querySelectorAll("#inner .node").length === 3, "timeline shows three pieces");
      const dot = document.querySelector('#inner .node[data-id="beta.md"] .dot');
      const bg = dot && getComputedStyle(dot).backgroundColor;
      check(!!bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent", "inline styles allowed by the content security policy");

      await openSide("alpha.md");
      $("f-text").value += "\n\nSmoke edit with ümlaut.";
      onEdit();
      check(dirty(), "edit marks the piece as unsaved");
      check(await save(), "save succeeds");
      check((await read("pieces/alpha.md")).includes("Smoke edit with ümlaut."), "saved text reaches the file");
      await closeSide();

      await movePiece("gamma.md", 0);
      check(JSON.parse(await read("linetime.json")).order[0] === "gamma.md", "new order written to linetime.json");

      await addPieceAt(1);
      await until(() => pieces.length === 4 && draft, "new piece");
      check(pieces[1].id === draft.id, "new piece inserted at the chosen position");
      const newId = draft.id;
      await closeSide();

      const p = deletePiece(newId);
      await until(() => document.querySelector(".modal .btn.danger"), "delete confirmation");
      document.querySelector(".modal .btn.danger").click();
      await p;
      check(pieces.length === 3, "piece deleted");
      let gone = false; try { await read("pieces/" + newId); } catch (e) { gone = e.name === "NotFoundError"; }
      check(gone, "deleted piece's file removed");

      await openBible();
      check(bibleOpen && draft.text.includes("Theme:"), "story bible read from the project folder");
      $("f-text").value += "\n\n| a | b |\n|---|---|\n| 1 | 2 |";
      onEdit();
      check(await save(), "story bible saved");
      check((await read("story-bible.md")).includes("| 1 | 2 |"), "story bible written to the main folder");
      setMode("preview");
      check(!!document.querySelector("#preview table"), "Markdown table rendered");
      setMode("edit");
      await closeSide();

      openBook();
      check(document.querySelectorAll(".bk-art").length >= 2, "whole-work preview renders");
      closeBook();

      const zip = await projectZip();
      const head = new Uint8Array(await zip.slice(0, 2).arrayBuffer());
      check(zip.size > 200 && head[0] === 0x50 && head[1] === 0x4b, "project export builds a zip");
      const tex = buildLatex(cur.meta, pieces, cur.meta.latex);
      check(tex.size > 200, "LaTeX export builds a zip");

      const bodyBg = () => getComputedStyle(document.body).backgroundColor;
      setTheme("light");
      await until(() => bodyBg() === "rgb(245, 241, 232)", "light theme", 3000).catch(() => {});
      check(bodyBg() === "rgb(245, 241, 232)", "light theme (" + bodyBg() + ")");
      setTheme("dark");
      await until(() => bodyBg() === "rgb(0, 0, 0)", "dark theme", 3000).catch(() => {});
      check(bodyBg() === "rgb(0, 0, 0)", "dark theme (" + bodyBg() + ")");

      const original = window.__linetimeCloseRequested;
      let received = null;
      window.__linetimeCloseRequested = seq => { received = seq; D.invoke("close_ack", { seq }); };
      await D.invoke("smoke_request_close");
      await until(() => received !== null, "close request from the native layer", 3000);
      window.__linetimeCloseRequested = original;
      await sleep(2500);
      check(received >= 1, "close request reaches the interface; acknowledged requests keep the app open");

      return { ok: true, log };
    } catch (e) {
      log.push("error " + ((e && e.stack) || e));
      return { ok: false, log };
    }
  }

  window.addEventListener("load", async () => {
    let dir = null;
    try { dir = await D.invoke("smoke_info"); } catch (e) { return; }
    if (!dir) return;
    await sleep(300);
    const result = await run(dir);
    result.userAgent = navigator.userAgent;
    await D.invoke("smoke_report", { ok: result.ok, report: JSON.stringify(result) });
  });
})();
