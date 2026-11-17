// Linetime — small persistent stores in the app's configuration folder.
// Copyright (C) 2026 The Linetime authors
// SPDX-License-Identifier: GPL-3.0-or-later

use crate::fsops;
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// The folders the user has chosen in a folder dialog. Only paths inside
/// these folders can be read or written.
pub struct Roots {
    file: PathBuf,
    list: Mutex<Vec<PathBuf>>,
}

impl Roots {
    pub fn load(file: PathBuf) -> Self {
        let list: Vec<PathBuf> = std::fs::read_to_string(&file)
            .ok()
            .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
            .unwrap_or_default()
            .into_iter()
            .filter_map(|p| dunce::canonicalize(p).ok())
            .collect();
        Roots {
            file,
            list: Mutex::new(list),
        }
    }

    /// Adds a canonical folder. With `persist`, it is remembered across sessions.
    pub fn add(&self, path: PathBuf, persist: bool) -> Result<(), String> {
        let mut list = self.list.lock().map_err(|e| e.to_string())?;
        if !list.contains(&path) {
            list.push(path);
        }
        if persist {
            let json: Vec<String> = list
                .iter()
                .map(|p| p.to_string_lossy().into_owned())
                .collect();
            let text = serde_json::to_string_pretty(&json).map_err(|e| e.to_string())?;
            fsops::write_atomic(&self.file, text.as_bytes())?;
        }
        Ok(())
    }

    pub fn resolve(&self, raw: &str) -> Result<PathBuf, String> {
        let list = self.list.lock().map_err(|e| e.to_string())?;
        fsops::resolve(&list, raw)
    }
}

/// Key-value settings: recent projects and interface preferences.
pub struct Store {
    file: PathBuf,
    data: Mutex<Map<String, Value>>,
}

impl Store {
    pub fn load(file: PathBuf) -> Self {
        let data = read_map(&file);
        Store {
            file,
            data: Mutex::new(data),
        }
    }

    pub fn get(&self, key: &str) -> Value {
        self.data
            .lock()
            .ok()
            .and_then(|d| d.get(key).cloned())
            .unwrap_or(Value::Null)
    }

    /// Stores a value; `Null` removes the key.
    pub fn set(&self, key: &str, value: Value) -> Result<(), String> {
        let mut data = self.data.lock().map_err(|e| e.to_string())?;
        if value.is_null() {
            data.remove(key);
        } else {
            data.insert(key.to_string(), value);
        }
        let text = serde_json::to_string_pretty(&*data).map_err(|e| e.to_string())?;
        fsops::write_atomic(&self.file, text.as_bytes())
    }
}

fn read_map(file: &Path) -> Map<String, Value> {
    std::fs::read_to_string(file)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn store_round_trip_survives_reload() {
        let t = tempfile::tempdir().unwrap();
        let f = t.path().join("settings.json");
        let s = Store::load(f.clone());
        assert_eq!(s.get("recents"), Value::Null);
        s.set("recents", json!([{"path": "/x", "title": "My novel"}]))
            .unwrap();
        s.set("theme", json!("light")).unwrap();
        s.set("theme", Value::Null).unwrap();
        let again = Store::load(f);
        assert_eq!(again.get("recents")[0]["title"], "My novel");
        assert_eq!(again.get("theme"), Value::Null);
    }

    #[test]
    fn roots_persist_only_when_asked() {
        let t = tempfile::tempdir().unwrap();
        let f = t.path().join("folders.json");
        let a = dunce::canonicalize(t.path()).unwrap().join("a");
        let b = dunce::canonicalize(t.path()).unwrap().join("b");
        std::fs::create_dir(&a).unwrap();
        std::fs::create_dir(&b).unwrap();
        let r = Roots::load(f.clone());
        r.add(a.clone(), true).unwrap();
        r.add(b.clone(), false).unwrap();
        assert!(r.resolve(&b.join("x.md").to_string_lossy()).is_ok());
        let again = Roots::load(f);
        assert!(again.resolve(&a.join("x.md").to_string_lossy()).is_ok());
        assert!(again.resolve(&b.join("x.md").to_string_lossy()).is_err());
    }

    #[test]
    fn corrupt_files_start_empty() {
        let t = tempfile::tempdir().unwrap();
        let f = t.path().join("settings.json");
        std::fs::write(&f, "{not json").unwrap();
        assert_eq!(Store::load(f).get("anything"), Value::Null);
    }
}
