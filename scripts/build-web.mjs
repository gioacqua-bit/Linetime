// Linetime — builds the single-file browser version (dist/web/Linetime.html).
// Copyright (C) 2026 The Linetime authors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The browser version needs no installation: open the file in Chrome, Edge
// or another Chromium browser, which can read and write project folders.
// In other browsers, projects are kept in the browser's own storage.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const src = new URL("../src/", import.meta.url);
const out = new URL("../dist/web/", import.meta.url);
const read = p => readFile(new URL(p, src), "utf8");

let fonts = await read("css/fonts.css");
for (const m of [...fonts.matchAll(/url\(\.\.\/fonts\/([^)]+)\)/g)]) {
  const b64 = (await readFile(new URL("fonts/" + m[1], src))).toString("base64");
  fonts = fonts.replace(m[0], `url(data:font/woff2;base64,${b64})`);
}
const favicon = "data:image/svg+xml," + encodeURIComponent(await read("favicon.svg"));
const inlineScript = s => `<script>\n${s.replace(/<\/script/gi, "<\\/script")}\n</script>`;

let html = await read("index.html");
html = html
  .replace('<script src="js/theme-init.js"></script>', inlineScript(await read("js/theme-init.js")))
  .replace('<link rel="icon" href="favicon.svg" type="image/svg+xml">', `<link rel="icon" href="${favicon}">`)
  .replace('<link rel="stylesheet" href="css/fonts.css">', `<style>\n${fonts}</style>`)
  .replace('<link rel="stylesheet" href="css/app.css">', `<style>\n${await read("css/app.css")}</style>`)
  .replace('<script src="js/desktop.js"></script>\n', "")
  .replace('<script src="js/smoke.js"></script>\n', "")
  .replace('<script src="js/app.js"></script>', inlineScript(await read("js/app.js")));

if (/(src|href)="(js|css)\//.test(html)) throw new Error("An asset was not inlined; check scripts/build-web.mjs");
await mkdir(out, { recursive: true });
await writeFile(new URL("Linetime.html", out), html);
console.log(`dist/web/Linetime.html (${Math.round(html.length / 1024)} KB)`);
