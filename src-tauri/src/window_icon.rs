use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::HiDpi::{GetDpiForWindow, GetSystemMetricsForDpi};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    DestroyIcon, GetSystemMetrics, LoadImageW, SendMessageW, ICON_BIG, ICON_SMALL, IMAGE_ICON,
    SM_CXICON, SM_CXSMICON, SM_CYICON, SM_CYSMICON, WM_SETICON,
};

// tauri-build embeds the application GROUP_ICON with this resource ID.
const APP_ICON_RESOURCE: usize = 32512;

// WM_SETICON does not take ownership. Keep each unshared image alive until the
// application exits, then release it. LR_SHARED can return the wrong size.
pub struct WindowIcons(Vec<isize>);

impl Drop for WindowIcons {
    fn drop(&mut self) {
        for icon in self.0.drain(..) {
            unsafe { DestroyIcon(icon) };
        }
    }
}

pub fn set_window_icons<'a>(windows: impl Iterator<Item = &'a tauri::Window>) -> WindowIcons {
    let mut owned = WindowIcons(Vec::new());
    unsafe {
        let module = GetModuleHandleW(std::ptr::null());
        if module == 0 {
            eprintln!("Could not load application icon resources: {}", std::io::Error::last_os_error());
            return owned;
        }
        for window in windows {
            let hwnd = match window.hwnd() {
                Ok(hwnd) => hwnd.0 as isize,
                Err(error) => {
                    eprintln!("Could not get window handle for application icon: {error}");
                    continue;
                }
            };
            let dpi = GetDpiForWindow(hwnd);
            for (kind, width, height) in [
                (ICON_BIG, SM_CXICON, SM_CYICON),
                (ICON_SMALL, SM_CXSMICON, SM_CYSMICON),
            ] {
                let metric = |index| {
                    if dpi == 0 { GetSystemMetrics(index) } else { GetSystemMetricsForDpi(index, dpi) }
                };
                let icon = LoadImageW(
                    module,
                    APP_ICON_RESOURCE as *const u16,
                    IMAGE_ICON,
                    metric(width),
                    metric(height),
                    0,
                );
                if icon == 0 {
                    eprintln!("Could not load application icon ({kind}): {}", std::io::Error::last_os_error());
                    continue;
                }
                SendMessageW(hwnd, WM_SETICON, kind as usize, icon);
                owned.0.push(icon);
            }
        }
    }
    owned
}
