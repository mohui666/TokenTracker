//! The capability file grants the local shell page (src/index.html) its baseline
//! permissions, and the bundle configs decide what the release ships. These
//! tests pin the parts of those contracts that are easy to regress by editing
//! JSON.

use std::path::PathBuf;

use tauri_utils::acl::capability::{Capability, PermissionEntry};

fn src_tauri_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn load_capability(name: &str) -> Capability {
    let path = src_tauri_dir().join("capabilities").join(name);
    let raw = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("failed to read {}: {error}", path.display()));
    // Deserializing through Tauri's own type means an unknown or misspelled
    // field fails here rather than at bundle time.
    serde_json::from_str(&raw)
        .unwrap_or_else(|error| panic!("failed to parse {}: {error}", path.display()))
}

fn permission_identifiers(capability: &Capability) -> Vec<String> {
    capability
        .permissions
        .iter()
        .map(|entry| match entry {
            PermissionEntry::PermissionRef(identifier) => identifier.get().to_string(),
            PermissionEntry::ExtendedPermission { identifier, .. } => identifier.get().to_string(),
        })
        .collect()
}

#[test]
fn capability_files_exist_and_parse() {
    let capability = load_capability("default.json");
    assert!(
        !capability.identifier.is_empty(),
        "default.json must declare an identifier"
    );
    assert!(
        capability.windows.iter().any(|window| window == "main"),
        "default.json must apply to the \"main\" window"
    );
}

#[test]
fn local_capability_grants_only_the_core_default_set() {
    let capability = load_capability("default.json");

    assert!(
        capability.local,
        "default.json must keep the local execution context"
    );
    assert_eq!(
        permission_identifiers(&capability),
        vec!["core:default".to_string()],
        "the local shell page needs the core default permission set, nothing more"
    );
}

#[test]
fn bundle_produces_exactly_one_appimage_and_no_other_target() {
    let raw = std::fs::read_to_string(src_tauri_dir().join("tauri.conf.json"))
        .expect("tauri.conf.json should be readable");
    let config: serde_json::Value = serde_json::from_str(&raw).expect("tauri.conf.json is JSON");
    let bundle = &config["bundle"];

    assert_eq!(
        bundle["active"], true,
        "bundling must be enabled or the release produces no artifact at all"
    );
    assert_eq!(
        bundle["targets"],
        serde_json::json!(["appimage"]),
        "Linux ships a single AppImage; adding targets here multiplies release assets"
    );

    // The embedded runtime is layered in via tauri.bundle.conf.json instead,
    // because tauri-build rejects a missing resource path and EmbeddedServer is
    // generated on demand -- declaring it here breaks plain `cargo test`.
    assert!(
        bundle.get("resources").is_none(),
        "resources must stay in tauri.bundle.conf.json"
    );
}

#[test]
fn bundle_overlay_ships_the_embedded_runtime() {
    let raw = std::fs::read_to_string(src_tauri_dir().join("tauri.bundle.conf.json"))
        .expect("tauri.bundle.conf.json should be readable");
    let config: serde_json::Value = serde_json::from_str(&raw).expect("overlay is JSON");

    let resources = &config["bundle"]["resources"];
    assert_eq!(
        resources["../EmbeddedServer"], "EmbeddedServer",
        "the AppImage must carry the bundled Node runtime, mapped where paths.rs looks for it"
    );
}
