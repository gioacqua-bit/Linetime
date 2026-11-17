# Linetime

Linetime shows a collection of stories, or a text divided into chapters, as a timeline. Each piece is a node on the line. You can open it in a sidebar, edit its Markdown, and arrange the pieces by dragging them. The pieces are plain Markdown files in a folder on your computer, so they stay readable and editable with any other tool.

Linetime runs as a desktop app on macOS, Windows and Linux, built with [Tauri](https://tauri.app). It also runs as a single HTML file in a Chromium browser.

## Features

- Timeline of pieces, with a type for each piece (shape and colour) and a status (idea, draft, revision, final)
- Pop-up summaries; sidebar editor with Markdown preview, undo and redo, word counts and focus mode
- Adding pieces at any position, reordering by drag and drop, deleting from the timeline
- Story bible: a Markdown file in the project folder, opened in its own sidebar
- Preview of the whole work as one formatted text, with word counts for each piece and type
- Search across all pieces
- Export to Markdown, to LaTeX (`main.tex` plus one file per piece), or as a zip of the project
- Light and dark modes

## Installation

Download the installer for your system from the [Releases](../../releases) page.

| System | File |
|---|---|
| macOS 11 or later (Apple silicon and Intel) | `Linetime_<version>_universal.dmg` |
| Windows 10 or later | `Linetime_<version>_x64-setup.exe` |
| Linux | `.deb`, `.rpm` or `.AppImage` |

### Opening an unsigned app on macOS

Unless the release was built with an Apple Developer certificate (see [Code signing](#code-signing)), macOS blocks the app the first time you open it.

- **macOS 15 (Sequoia) and later:** open Linetime once, close the warning, then go to **System Settings → Privacy & Security** and click **Open Anyway**.
- **macOS 14 and earlier:** right-click `Linetime.app` in Applications, choose **Open**, then confirm.

Alternatively, run `xattr -dr com.apple.quarantine /Applications/Linetime.app` in Terminal once.

On Windows, SmartScreen may show "Windows protected your PC" for an unsigned installer. Click **More info**, then **Run anyway**.

### Browser version

`npm run build:web` produces `dist/web/Linetime.html`, a single file that needs no installation. Open it in Chrome, Edge or another Chromium browser, which can read and write project folders. Other browsers keep projects in their own storage instead.

## Project folders

A project is a folder with this layout:

```
My collection/
  linetime.json        order of the pieces, types, title, export options
  story-bible.md       story bible (the file name can be changed in the project settings)
  pieces/
    first-piece.md     one Markdown file per piece
    second-piece.md
```

Each piece file starts with a short header, followed by the text:

```markdown
---
title: "The lighthouse"
type: "chapter"
status: revision
summary: "Shown in the pop-up on the timeline."
notes: "Open items."
---

The text of the piece, in Markdown. A line with three dashes is a scene break.
```

Markdown files that you add to `pieces/` with another program appear as new pieces. Files that you edit elsewhere are reloaded when you return to Linetime, unless the same piece has unsaved changes in Linetime.

The desktop app can only read and write inside folders that you chose in its folder dialog. It keeps the list of those folders, the recent projects and the theme in its configuration folder:

- macOS: `~/Library/Application Support/io.linetime.desktop/`
- Windows: `%APPDATA%\io.linetime.desktop\`
- Linux: `~/.config/io.linetime.desktop/`

## Development

Requirements:

- [Node.js](https://nodejs.org) 20 or later
- [Rust](https://rustup.rs), stable toolchain
- The system libraries that Tauri needs, listed in [Tauri's prerequisites](https://tauri.app/start/prerequisites/). On macOS, that means the Xcode Command Line Tools.

```sh
npm install
npm run dev          # start the app with the interface loaded from src/
npm run build        # build the installers for this system into src-tauri/target/release/bundle/
npm run build:web    # build the single-file browser version into dist/web/
```

### Layout

| Path | Contents |
|---|---|
| `src/` | The interface: `index.html`, `css/`, `js/app.js`, and the bundled fonts |
| `src/js/desktop.js` | Bridge to the native layer; inactive in a browser |
| `src/js/smoke.js` | In-app smoke test; inactive unless started by `scripts/smoke.mjs` |
| `src-tauri/` | The native layer in Rust: folder access, dialogs, settings, and the close guard |
| `tests/` | End-to-end tests and the fixture project |
| `scripts/` | Static server, browser build and smoke-test runner |

## Tests

There are three layers of tests:

1. **Rust unit tests** (`npm run test:rust`) cover file access. They check that paths outside the opened folders are refused, including through `..` and symbolic links, that writes are atomic, and that settings persist.
2. **Interface tests** (`npm run test:e2e`) run the interface in Chromium and WebKit with Playwright, against a test double of the native layer (`tests/e2e/mock-tauri.js`). WebKit is the engine behind the macOS system webview, so these tests catch Safari-specific problems without building the app. Install the browsers once with `npx playwright install chromium webkit`.
3. **Smoke test of the built app** (`npm run smoke`, after a build) starts the real app on a copy of the fixture project. Inside the system webview, it opens the project, edits and saves a piece, adds, moves and deletes pieces, saves the story bible, builds the exports, switches themes, and checks the close request. On Linux without a display, it uses `xvfb-run`.

GitHub Actions (`.github/workflows/ci.yml`) runs all three on macOS, Linux and Windows for every push and pull request. Each run also uploads the built installers as artifacts.

## Releases

1. Update the version in `package.json` and in `src-tauri/Cargo.toml`.
2. Commit, then tag and push: `git tag v1.0.1 && git push origin v1.0.1`.
3. The release workflow builds the installers and attaches them to a draft release on GitHub. Review the draft, then publish it.

### Code signing

The release workflow builds unsigned installers by default. To sign and notarize the macOS app, you need an Apple Developer account. Add these repository secrets, then uncomment the matching lines in `.github/workflows/release.yml`:

`APPLE_CERTIFICATE` (the .p12 certificate, base64-encoded), `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD` (an app-specific password) and `APPLE_TEAM_ID`.

Tauri's guide to [macOS code signing](https://tauri.app/distribute/sign/macos/) describes how to obtain each value.

## Licence

Copyright (C) 2026 The Linetime authors.

Linetime is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. It is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See [LICENSE](LICENSE) for details.

The bundled fonts, Literata and Jost, are distributed under the SIL Open Font License 1.1. See [src/fonts/README.md](src/fonts/README.md).
