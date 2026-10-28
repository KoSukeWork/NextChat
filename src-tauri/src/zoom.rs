#[tauri::command]
pub async fn set_zoom(window: tauri::Window, factor: f64) -> Result<bool, String> {
    if !factor.is_finite() {
        return Err("Zoom factor must be finite".into());
    }
    let factor = factor.clamp(0.5, 2.0);

    #[cfg(windows)]
    {
        // with_webview schedules on the UI thread. Wait on a blocking worker,
        // and report the actual COM result rather than just successful scheduling.
        tauri::async_runtime::spawn_blocking(move || {
            let (sender, receiver) = std::sync::mpsc::channel();
            window
                .with_webview(move |webview| {
                    let result = unsafe { webview.controller().SetZoomFactor(factor) }
                        .map(|_| true)
                        .map_err(|error| error.to_string());
                    let _ = sender.send(result);
                })
                .map_err(|error| error.to_string())?;
            receiver
                .recv_timeout(std::time::Duration::from_secs(5))
                .map_err(|error| error.to_string())?
        })
        .await
        .map_err(|error| error.to_string())?
    }

    #[cfg(not(windows))]
    {
        // Other platform APIs are intentionally not implemented or advertised.
        let _ = (window, factor);
        Ok(false)
    }
}
