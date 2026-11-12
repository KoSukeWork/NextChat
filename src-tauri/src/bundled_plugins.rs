//! Release layout shared with the packager. Only the compiled-in catalog is
//! trusted; dropping a manifest or executable into plugins/ cannot register it.
use serde::Deserialize;
use std::path::{Path, PathBuf};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Catalog {
    schema_version: u32,
    bundles: Vec<Bundle>,
}

#[derive(Deserialize)]
struct Bundle {
    id: String,
    executable: String,
}

pub fn executable_path(id: &str) -> PathBuf {
    let catalog: Catalog = serde_json::from_str(include_str!("../../plugins/desktop-bundles.json"))
        .expect("Invalid built-in desktop bundle catalog");
    assert_eq!(catalog.schema_version, 1);
    let bundle = catalog
        .bundles
        .into_iter()
        .find(|bundle| bundle.id == id)
        .expect("Desktop plugin is not registered");
    PathBuf::from("plugins")
        .join(bundle.id)
        .join(bundle.executable)
}

pub fn resolve_executable(id: &str, resources: &Path, executable_dir: Option<&Path>) -> PathBuf {
    let relative = executable_path(id);
    let installed = resources.join(&relative);
    if installed.is_file() {
        return installed;
    }
    if let Some(directory) = executable_dir {
        let portable = directory.join(&relative);
        if portable.is_file() {
            return portable;
        }
    }
    installed
}

#[tauri::command]
pub fn bundled_licenses() -> &'static str {
    concat!(
        "NextChat\n========\n\n",
        include_str!("../../LICENSE"),
        "\n\nBun 1.4.4 (38afee6c84fcf48c0edb2466aa4b27d287a59c30)\n",
        "Source: https://github.com/oven-sh/bun/blob/38afee6c84fcf48c0edb2466aa4b27d287a59c30/LICENSE.md\n\n",
        include_str!("../../licenses/Bun-1.4.4.md")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_matches_the_plugin_namespace_and_contains_no_extra_payloads() {
        let catalog: serde_json::Value =
            serde_json::from_str(include_str!("../../plugins/desktop-bundles.json")).unwrap();
        let mut ids = std::collections::BTreeSet::new();
        for bundle in catalog["bundles"].as_array().unwrap() {
            let id = bundle["id"].as_str().unwrap();
            assert!(ids.insert(id));
            let manifest: serde_json::Value = serde_json::from_slice(
                &std::fs::read(
                    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                        .join("..")
                        .join(bundle["manifest"].as_str().unwrap()),
                )
                .unwrap(),
            )
            .unwrap();
            assert_eq!(manifest["id"], id);
            let relative = executable_path(id);
            assert!(!relative.is_absolute());
            assert_eq!(relative.components().count(), 3);
            assert!(relative.starts_with(PathBuf::from("plugins").join(id)));
        }
        assert!(bundled_licenses().contains("Copyright (c) 2023-2025 NextChat"));
        assert!(bundled_licenses().contains(include_str!("../../licenses/Bun-1.4.4.md")));
    }

    #[test]
    fn installed_and_portable_helpers_resolve_only_inside_their_plugin_directory() {
        let directory = tempfile::tempdir().unwrap();
        let resources = directory.path().join("installed");
        let portable = directory.path().join("portable");
        let id = "nextchat.claude-code";
        let relative = executable_path(id);
        let installed_helper = resources.join(&relative);
        let portable_helper = portable.join(&relative);
        std::fs::create_dir_all(installed_helper.parent().unwrap()).unwrap();
        std::fs::create_dir_all(portable_helper.parent().unwrap()).unwrap();
        // A same-named executable in another plugin must never be picked up.
        let unrelated = portable.join("plugins/another-plugin/nextchat-wire-relay.exe");
        std::fs::create_dir_all(unrelated.parent().unwrap()).unwrap();
        std::fs::write(unrelated, b"unrelated").unwrap();
        assert_eq!(
            resolve_executable(id, &resources, Some(&portable)),
            installed_helper
        );
        std::fs::write(&portable_helper, b"portable").unwrap();
        assert_eq!(
            resolve_executable(id, &resources, Some(&portable)),
            portable_helper
        );
        std::fs::write(&installed_helper, b"installed").unwrap();
        assert_eq!(
            resolve_executable(id, &resources, Some(&portable)),
            installed_helper
        );
    }
}
