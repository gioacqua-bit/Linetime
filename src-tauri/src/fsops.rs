// Linetime — file operations, limited to the folders the user has opened.
// Copyright (C) 2026 The Linetime authors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Every path that the interface sends is resolved here before it is touched.
// A path is accepted only if, after resolving symbolic links, it lies inside
// one of the folders the user chose in a native folder dialog. Errors are
// returned as "KindError: message" so that the interface can map them to the
// same error names the browser's File System Access API uses.

use serde::Serialize;
use std::fs;
use std::io::{ErrorKind, Write};
use std::path::{Component, Path, PathBuf};

pub fn err(kind: &str, msg: impl std::fmt::Display) -> String {
    format!("{kind}: {msg}")
}

pub fn io_err(e: std::io::Error) -> String {
    match e.kind() {
        ErrorKind::NotFound => err("NotFoundError", e),
        ErrorKind::PermissionDenied => err("NotAllowedError", e),
        ErrorKind::AlreadyExists => err("InvalidModificationError", e),
        _ => err("InvalidStateError", e),
    }
}

/// Resolves `raw` and checks that it lies inside one of `roots`.
/// `roots` must already be canonical. The target itself may not exist yet,
/// but its parent folder must.
pub fn resolve(roots: &[PathBuf], raw: &str) -> Result<PathBuf, String> {
    let p = Path::new(raw);
    if !p.is_absolute() {
        return Err(err("SecurityError", "the path must be absolute"));
    }
    if p.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(err("SecurityError", "the path may not contain .."));
    }
    let resolved = match dunce::canonicalize(p) {
        Ok(c) => c,
        Err(_) => {
            // The target does not exist. Refuse dangling symbolic links, whose
            // target could lie anywhere, then resolve the parent instead.
            if fs::symlink_metadata(p).is_ok() {
                return Err(err("SecurityError", "the path is a broken symbolic link"));
            }
            let parent = p
                .parent()
                .ok_or_else(|| err("SecurityError", "the path has no parent folder"))?;
            let name = p
                .file_name()
                .ok_or_else(|| err("SecurityError", "the path has no file name"))?;
            dunce::canonicalize(parent).map_err(io_err)?.join(name)
        }
    };
    if roots.iter().any(|r| resolved.starts_with(r)) {
        Ok(resolved)
    } else {
        Err(err(
            "NotAllowedError",
            format!(
                "{} is outside the folders opened in Linetime",
                resolved.display()
            ),
        ))
    }
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Stat {
    pub exists: bool,
    pub dir: bool,
}

pub fn stat(p: &Path) -> Stat {
    match fs::metadata(p) {
        Ok(m) => Stat {
            exists: true,
            dir: m.is_dir(),
        },
        Err(_) => Stat {
            exists: false,
            dir: false,
        },
    }
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Entry {
    pub name: String,
    pub dir: bool,
}

/// Lists a folder, sorted by name. Entries whose names are not valid UTF-8
/// are skipped, since the interface could not address them anyway.
pub fn list(p: &Path) -> Result<Vec<Entry>, String> {
    let mut out = Vec::new();
    for item in fs::read_dir(p).map_err(io_err)? {
        let item = item.map_err(io_err)?;
        let Ok(name) = item.file_name().into_string() else {
            continue;
        };
        let dir = fs::metadata(item.path())
            .map(|m| m.is_dir())
            .unwrap_or(false);
        out.push(Entry { name, dir });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

pub fn read_text(p: &Path) -> Result<String, String> {
    let bytes = fs::read(p).map_err(io_err)?;
    String::from_utf8(bytes).map_err(|_| {
        err(
            "EncodingError",
            format!("{} is not UTF-8 text", p.display()),
        )
    })
}

/// Writes atomically: the data goes to a hidden temporary file in the same
/// folder, which then replaces the target. A crash during the write leaves
/// the previous version intact.
pub fn write_atomic(p: &Path, data: &[u8]) -> Result<(), String> {
    let parent = p
        .parent()
        .ok_or_else(|| err("SecurityError", "the path has no parent folder"))?;
    let name = p
        .file_name()
        .ok_or_else(|| err("SecurityError", "the path has no file name"))?;
    if p.is_dir() {
        return Err(err(
            "TypeMismatchError",
            format!("{} is a folder", p.display()),
        ));
    }
    let tmp = parent.join(format!(".{}.linetime-tmp", name.to_string_lossy()));
    let result = (|| {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(data)?;
        f.sync_all()?;
        drop(f);
        fs::rename(&tmp, p)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result.map_err(io_err)
}

pub fn mkdir(p: &Path) -> Result<(), String> {
    match fs::create_dir(p) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == ErrorKind::AlreadyExists && p.is_dir() => Ok(()),
        Err(e) => Err(io_err(e)),
    }
}

/// Removes a file. Folders are never removed.
pub fn remove_file(p: &Path) -> Result<(), String> {
    if p.is_dir() {
        return Err(err(
            "TypeMismatchError",
            format!("{} is a folder; Linetime only deletes files", p.display()),
        ));
    }
    fs::remove_file(p).map_err(io_err)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> (tempfile::TempDir, PathBuf, Vec<PathBuf>) {
        let tmp = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(tmp.path()).unwrap().join("project");
        fs::create_dir(&root).unwrap();
        fs::create_dir(root.join("pieces")).unwrap();
        let roots = vec![root.clone()];
        (tmp, root, roots)
    }
    fn s(p: &Path) -> String {
        p.to_string_lossy().into_owned()
    }

    #[test]
    fn accepts_paths_inside_a_root() {
        let (_t, root, roots) = setup();
        let p = root.join("pieces").join("new.md");
        assert_eq!(resolve(&roots, &s(&p)).unwrap(), p);
        assert_eq!(resolve(&roots, &s(&root)).unwrap(), root);
    }

    #[test]
    fn rejects_paths_outside_roots() {
        let (_t, root, roots) = setup();
        let outside = root.parent().unwrap().join("elsewhere.md");
        assert!(resolve(&roots, &s(&outside))
            .unwrap_err()
            .starts_with("NotAllowedError"));
    }

    #[test]
    fn rejects_parent_components_and_relative_paths() {
        let (_t, root, roots) = setup();
        let sneaky = format!(
            "{}{}..{}x.md",
            s(&root.join("pieces")),
            std::path::MAIN_SEPARATOR,
            std::path::MAIN_SEPARATOR
        );
        assert!(resolve(&roots, &sneaky)
            .unwrap_err()
            .starts_with("SecurityError"));
        assert!(resolve(&roots, "pieces/x.md")
            .unwrap_err()
            .starts_with("SecurityError"));
    }

    #[test]
    fn rejects_a_prefix_that_is_not_a_parent() {
        let (_t, root, roots) = setup();
        let sibling = PathBuf::from(format!("{}-other", s(&root)));
        fs::create_dir(&sibling).unwrap();
        assert!(resolve(&roots, &s(&sibling.join("x.md")))
            .unwrap_err()
            .starts_with("NotAllowedError"));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinks_that_escape_the_root() {
        let (_t, root, roots) = setup();
        let outside = root.parent().unwrap().join("secret");
        fs::create_dir(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();
        assert!(resolve(&roots, &s(&root.join("link").join("x.md"))).is_err());
        std::os::unix::fs::symlink(outside.join("missing.md"), root.join("dangling.md")).unwrap();
        assert!(resolve(&roots, &s(&root.join("dangling.md")))
            .unwrap_err()
            .starts_with("SecurityError"));
    }

    #[test]
    fn writes_atomically_and_reads_back_utf8() {
        let (_t, root, _) = setup();
        let p = root.join("pieces").join("a.md");
        write_atomic(&p, "first ü".as_bytes()).unwrap();
        write_atomic(&p, "second ü".as_bytes()).unwrap();
        assert_eq!(read_text(&p).unwrap(), "second ü");
        let names: Vec<String> = list(&root.join("pieces"))
            .unwrap()
            .into_iter()
            .map(|e| e.name)
            .collect();
        assert_eq!(
            names,
            vec!["a.md".to_string()],
            "no temporary file is left behind"
        );
    }

    #[test]
    fn reports_missing_files_and_bad_encoding() {
        let (_t, root, _) = setup();
        assert!(read_text(&root.join("nope.md"))
            .unwrap_err()
            .starts_with("NotFoundError"));
        fs::write(root.join("bin.md"), [0xff, 0xfe, 0x00]).unwrap();
        assert!(read_text(&root.join("bin.md"))
            .unwrap_err()
            .starts_with("EncodingError"));
    }

    #[test]
    fn stat_list_mkdir_and_remove() {
        let (_t, root, _) = setup();
        assert_eq!(
            stat(&root.join("pieces")),
            Stat {
                exists: true,
                dir: true
            }
        );
        assert_eq!(
            stat(&root.join("x")),
            Stat {
                exists: false,
                dir: false
            }
        );
        mkdir(&root.join("bibles")).unwrap();
        mkdir(&root.join("bibles")).unwrap();
        write_atomic(&root.join("linetime.json"), b"{}").unwrap();
        let l = list(&root).unwrap();
        assert_eq!(
            l,
            vec![
                Entry {
                    name: "bibles".into(),
                    dir: true
                },
                Entry {
                    name: "linetime.json".into(),
                    dir: false
                },
                Entry {
                    name: "pieces".into(),
                    dir: true
                },
            ]
        );
        assert!(remove_file(&root.join("pieces"))
            .unwrap_err()
            .starts_with("TypeMismatchError"));
        remove_file(&root.join("linetime.json")).unwrap();
        assert!(!root.join("linetime.json").exists());
    }
}
