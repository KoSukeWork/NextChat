#[tauri::command]
pub fn bundled_licenses() -> &'static str {
    include_str!("../../LICENSE")
}
