// Linetime — desktop entry point.
// Copyright (C) 2026 The Linetime authors
// SPDX-License-Identifier: GPL-3.0-or-later

// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    linetime_lib::run()
}
