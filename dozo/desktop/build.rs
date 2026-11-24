fn main() {
    // Naming the app's commands puts them under the ACL: a page can call one only when a
    // capability grants it, and capabilities/local.json grants them to the app's own screens.
    let commands = tauri_build::AppManifest::new().commands(&[
        "current_server",
        "set_server",
        "connect",
        "use_this_computer",
        "local_progress",
        "phone_code",
        "phones",
        "remove_phone",
        "phone_wait",
        "approve_phone",
        "back_up",
        "restore_pick",
        "restore",
        "reset_password",
        "prefs_list",
        "prefs_pick",
        "logins_candidates",
        "logins_link",
        "logins_remove",
        "fill_question",
        "fill_answer",
        // The bridge of a server's page (page_bridge.rs): granted while the app runs, to the
        // chosen server's origin only. And the question it may ask (capabilities/confirm.json).
        "desktop_settings",
        "desktop_set",
        "desktop_open",
        "confirm_question",
        "confirm_answer",
    ]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(commands))
        .expect("tauri-build failed");
}
