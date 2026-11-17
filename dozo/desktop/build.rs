fn main() {
    // Naming the app's commands puts them under the ACL: a page can call one only when a
    // capability grants it, and capabilities/local.json grants them to the app's own screens.
    let commands =
        tauri_build::AppManifest::new().commands(&["current_server", "set_server", "connect"]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(commands))
        .expect("tauri-build failed");
}
