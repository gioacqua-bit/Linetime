// Linetime — end-to-end tests of the interface with a mocked native layer.
// Copyright (C) 2026 The Linetime authors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Run in Chromium and in WebKit, the engine of the macOS system webview.

import { test, expect } from "@playwright/test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURE = fileURLToPath(new URL("../fixtures/project", import.meta.url));
const MOCK = readFileSync(fileURLToPath(new URL("./mock-tauri.js", import.meta.url)), "utf8");
const ROOT = "/Users/test/Test collection";

function seed() {
  const files = {}, dirs = ["/Users", "/Users/test", ROOT];
  const walk = d => {
    for (const name of readdirSync(d)) {
      const p = join(d, name), rel = relative(FIXTURE, p).split("\\").join("/");
      if (statSync(p).isDirectory()) { dirs.push(`${ROOT}/${rel}`); walk(p); }
      else files[`${ROOT}/${rel}`] = readFileSync(p, "utf8");
    }
  };
  walk(FIXTURE);
  return { files, dirs, roots: [], picks: [ROOT] };
}

const mock = page => page.evaluate(() => window.__linetimeMock.state());
const file = async (page, rel) => (await mock(page)).files[`${ROOT}/${rel}`];

async function openProject(page) {
  await page.getByRole("button", { name: "Open project folder" }).click();
  await expect(page.locator("#ptitle")).toHaveText("Test collection");
  await expect(page.locator("#inner .node")).toHaveCount(3);
}
async function openPiece(page, id) {
  await page.locator(`#inner .node[data-id="${id}"] .hitbox`).click();
  await page.locator(".popup [data-pa=open]").click();
  await expect(page.locator("body")).toHaveClass(/side-open/);
}

test.describe("desktop build", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(`window.__LINETIME_MOCK_SEED__ = ${JSON.stringify(seed())};`);
    await page.addInitScript(MOCK);
    await page.goto("/");
  });

  test("opens a project folder and shows its timeline", async ({ page }) => {
    await expect(page.locator("html")).toHaveClass(/desktop/);
    await openProject(page);
    await expect(page.locator("#inner .ntitle")).toHaveText(["Alpha", "Beta", "Gamma"]);
    await expect(page.locator("#storeNote")).toContainText("Test collection");
    await expect(page.locator(".legend")).toContainText("Interlude");
  });

  test("saves edits to the piece's file", async ({ page }) => {
    await openProject(page);
    await openPiece(page, "alpha.md");
    await page.locator("#f-text").press("End");
    await page.locator("#f-text").pressSequentially(" Added words here.");
    await expect(page.locator("#dirty")).toHaveText("Unsaved changes");
    await expect(page.locator("#wc .delta")).toHaveText("+3");
    await page.locator("#b-save").click();
    await expect(page.locator("#dirty")).toHaveText("Saved");
    expect(await file(page, "pieces/alpha.md")).toContain("Added words here.");
    expect(await file(page, "pieces/alpha.md")).toMatch(/^---\ntitle: "Alpha"/);
  });

  test("warns about unsaved changes before opening the story bible, which lives in the main folder", async ({ page }) => {
    await openProject(page);
    await openPiece(page, "beta.md");
    await page.locator("#f-text").fill("Changed.");
    await page.locator("#b-bible").click();
    await expect(page.locator(".modal p")).toContainText("Your changes to “Beta” aren’t saved yet");
    await page.getByRole("dialog").getByRole("button", { name: "Save first" }).click();
    await expect(page.locator("body")).toHaveClass(/bible/);
    expect(await file(page, "pieces/beta.md")).toContain("Changed.");
    await page.locator("#f-text").press("End");
    await page.locator("#f-text").pressSequentially("\n\nNew rule.");
    await page.keyboard.press(process.platform === "darwin" ? "Meta+s" : "Control+s");
    await expect(page.locator("#dirty")).toHaveText("Saved");
    expect(await file(page, "story-bible.md")).toContain("New rule.");
    expect(await file(page, "pieces/story-bible.md")).toBeUndefined();
    await page.locator("#m-prev").click();
    await expect(page.locator("#preview table th")).toHaveText(["Name", "Chapter"]);
  });

  test("adds a piece between two pieces, moves it and deletes it", async ({ page }) => {
    await openProject(page);
    await page.locator("#b-add").click();
    await page.locator('.gap[data-at="1"]').click();
    await page.locator("#f-title").fill("Inserted");
    await page.locator("#b-save").click();
    await page.locator("#b-close").click();
    await expect(page.locator("#inner .ntitle")).toHaveText(["Alpha", "Inserted", "Beta", "Gamma"]);
    expect(JSON.parse(await file(page, "linetime.json")).order).toEqual(["alpha.md", "inserted.md", "beta.md", "gamma.md"]);

    await page.locator('#inner .node[data-id="inserted.md"] .hitbox').click();
    await page.locator(".popup [data-pa=right]").click();
    await expect(page.locator("#inner .ntitle")).toHaveText(["Alpha", "Beta", "Inserted", "Gamma"]);

    await page.locator(".popup [data-pa=del]").click();
    await expect(page.locator(".modal p")).toContainText("pieces/inserted.md will be deleted");
    await page.getByRole("dialog").getByRole("button", { name: "Delete piece" }).click();
    await expect(page.locator("#inner .ntitle")).toHaveText(["Alpha", "Beta", "Gamma"]);
    expect(await file(page, "pieces/inserted.md")).toBeUndefined();
  });

  test("reorders pieces by dragging", async ({ page }) => {
    await openProject(page);
    const from = await page.locator('#inner .node[data-id="gamma.md"] .hitbox').boundingBox();
    const to = await page.locator('#inner .node[data-id="alpha.md"] .hitbox').boundingBox();
    const y = from.y + from.height - 24;
    await page.mouse.move(from.x + from.width / 2, y);
    await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2 - 40, y, { steps: 4 });
    await page.mouse.move(to.x + 10, y, { steps: 12 });
    await page.mouse.up();
    await expect(page.locator("#inner .ntitle")).toHaveText(["Gamma", "Alpha", "Beta"]);
    expect(JSON.parse(await file(page, "linetime.json")).order).toEqual(["gamma.md", "alpha.md", "beta.md"]);
  });

  test("sends LaTeX and project exports to the native save dialog", async ({ page }) => {
    await openProject(page);
    await page.locator("#b-export").click();
    await page.locator('input[name=fmt][value=latex]').check();
    await page.locator("[data-x=go]").click();
    await expect(page.locator("#toast")).toContainText("Exported to test-collection-latex.zip");
    await page.locator("#b-export").click();
    await page.locator('input[name=fmt][value=project]').check();
    await page.locator("[data-x=go]").click();
    await expect.poll(async () => (await mock(page)).saved.length).toBe(2);
    const [latex, project] = (await mock(page)).saved;
    const zip = Buffer.from(latex.data, "base64");
    expect(zip.subarray(0, 2).toString()).toBe("PK");
    expect(zip.toString("latin1")).toContain("test-collection/main.tex");
    expect(zip.toString("latin1")).toContain("chapters/01-alpha.tex");
    const pz = Buffer.from(project.data, "base64").toString("utf8");
    expect(pz).toContain("test-collection/story-bible.md");
    expect(pz).toContain("test-collection/pieces/gamma.md");
  });

  test("asks before quitting with unsaved changes", async ({ page }) => {
    await openProject(page);
    await page.evaluate(() => window.__linetimeCloseRequested(1));
    await expect.poll(async () => (await mock(page)).closed).toBe(1);

    await openPiece(page, "gamma.md");
    await page.locator("#f-text").fill("Unsaved.");
    await page.evaluate(() => { window.__linetimeCloseRequested(2); });
    await expect(page.locator(".modal p")).toContainText("Quit Linetime?");
    await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
    expect((await mock(page)).closed).toBe(1);
    expect((await mock(page)).acks).toEqual([1, 2]);

    await page.evaluate(() => { window.__linetimeCloseRequested(3); });
    await page.getByRole("dialog").getByRole("button", { name: "Discard changes" }).click();
    await expect.poll(async () => (await mock(page)).closed).toBe(2);
    expect(await file(page, "pieces/gamma.md")).not.toContain("Unsaved.");
  });

  test("opens links in the system browser", async ({ page }) => {
    await openProject(page);
    await openPiece(page, "gamma.md");
    await page.locator("#m-prev").click();
    await page.locator("#preview a").click();
    await expect.poll(async () => (await mock(page)).opened).toEqual(["https://example.org/source"]);
    expect(page.url()).toMatch(/127\.0\.0\.1/);
  });

  test("remembers the theme and reopens the last project", async ({ page }) => {
    await openProject(page);
    await page.locator("#b-theme").click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", /light|dark/);
    const theme = await page.locator("html").getAttribute("data-theme");
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expect(page.locator("#ptitle")).toHaveText("Test collection");
    await expect(page.locator("#inner .node")).toHaveCount(3);
  });

  test("creates a new project folder inside the chosen location", async ({ page }) => {
    await page.evaluate(() => window.__linetimeMock.setNextPick("/Users/test"));
    await page.locator("[data-act=newproj]").click();
    await expect(page.locator('.modal input[value=browser]')).toBeHidden();
    await page.locator("#np-title").fill("Novel");
    await page.locator("[data-x=go]").click();
    await expect(page.locator("#ptitle")).toHaveText("Novel");
    const st = await mock(page);
    expect(st.dirs).toContain("/Users/test/Novel/pieces");
    expect(JSON.parse(st.files["/Users/test/Novel/linetime.json"]).title).toBe("Novel");
  });

  test("shows the whole-work preview with word counts", async ({ page }) => {
    await openProject(page);
    await page.locator("#b-book").click();
    await expect(page.locator(".bk-art h1")).toHaveText(["Alpha", "Beta", "Gamma"]);
    await expect(page.locator(".bk-total")).toContainText("words in 3 pieces");
    await expect(page.locator(".bk-art").nth(1).locator("strong")).toHaveText("glass");
  });
});

test.describe("browser build", () => {
  test("loads without the desktop layer and without errors", async ({ page }) => {
    const errors = [];
    page.on("pageerror", e => errors.push(e.message));
    await page.goto("/");
    await expect(page.locator("html")).not.toHaveClass(/desktop/);
    await expect(page.locator(".empty")).toContainText(/project/i);
    expect(errors).toEqual([]);
  });
});
