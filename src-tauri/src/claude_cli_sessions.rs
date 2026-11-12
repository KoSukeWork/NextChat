//! Per-process CLI conversation state. Only directories created here (and
//! expired legacy 64-character hash directories) are eligible for cleanup.
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};
use tempfile::{Builder, TempDir};

const RETENTION: Duration = Duration::from_secs(7 * 24 * 60 * 60);
const MAX_SESSIONS: usize = 100;

fn legacy_name(name: &str) -> bool {
    name.len() == 64
        && name
            .bytes()
            .all(|ch| ch.is_ascii_digit() || (b'a'..=b'f').contains(&ch))
}

// Refuse to traverse links or remove a tree with any recently changed entry.
fn stale_tree(path: &Path, cutoff: SystemTime) -> bool {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return false;
    };
    if metadata.file_type().is_symlink() || metadata.modified().map_or(true, |time| time >= cutoff)
    {
        return false;
    }
    if metadata.is_dir() {
        let Ok(entries) = fs::read_dir(path) else {
            return false;
        };
        return entries
            .into_iter()
            .all(|entry| entry.map_or(false, |entry| stale_tree(&entry.path(), cutoff)));
    }
    metadata.is_file()
}

fn clean_legacy(root: &Path, retention: Duration) {
    let Some(cutoff) = SystemTime::now().checked_sub(retention) else {
        return;
    };
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if !legacy_name(&name) {
            continue;
        }
        let path = entry.path();
        if stale_tree(&path, cutoff) {
            let _ = fs::remove_dir_all(path);
        }
    }
}

#[cfg(windows)]
fn process_alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_INVALID_PARAMETER};
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle == 0 {
            return GetLastError() != ERROR_INVALID_PARAMETER;
        }
        let mut code = 0;
        let alive = GetExitCodeProcess(handle, &mut code) == 0 || code == 259;
        CloseHandle(handle);
        alive
    }
}
#[cfg(not(windows))]
fn process_alive(_pid: u32) -> bool {
    true
}

fn clean_old_runs(root: &Path) {
    let Some(cutoff) = SystemTime::now().checked_sub(RETENTION) else {
        return;
    };
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if !name.starts_with("run-") || !name[4..].bytes().all(|ch| ch.is_ascii_alphanumeric()) {
            continue;
        }
        let path = entry.path();
        if !stale_tree(&path, cutoff) {
            continue;
        }
        let owner = fs::read(path.join("owner.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok());
        let Some(pid) = owner
            .as_ref()
            .and_then(|value| value["pid"].as_u64())
            .and_then(|value| u32::try_from(value).ok())
        else {
            continue;
        };
        if pid > 0 && !process_alive(pid) {
            let _ = fs::remove_dir_all(path);
        }
    }
}

pub struct Session {
    pub directory: TempDir,
    pub id: String,
    pub scope: String,
    pub history: String,
    used: SystemTime,
}

#[derive(Default)]
struct Inner {
    sessions: HashMap<String, Session>,
    active: HashSet<String>,
}

pub struct SessionStore {
    root: TempDir,
    inner: Mutex<Inner>,
}

impl SessionStore {
    pub fn new(root: &Path) -> Result<Arc<Self>, String> {
        fs::create_dir_all(root).map_err(|_| "Cannot prepare CLI session directory")?;
        let metadata =
            fs::symlink_metadata(root).map_err(|_| "Cannot inspect CLI session directory")?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err("CLI session directory must not be a link".into());
        }
        clean_legacy(root, RETENTION);
        let managed = root.join("managed-rust");
        fs::create_dir_all(&managed).map_err(|_| "Cannot prepare CLI session directory")?;
        let metadata =
            fs::symlink_metadata(&managed).map_err(|_| "Cannot inspect CLI session directory")?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err("CLI session directory must not be a link".into());
        }
        clean_old_runs(&managed);
        let old_managed = root.join("managed-v2");
        if fs::symlink_metadata(&old_managed).map_or(false, |metadata| {
            metadata.is_dir() && !metadata.file_type().is_symlink()
        }) {
            clean_old_runs(&old_managed);
        }
        let instance = Builder::new()
            .prefix("run-")
            .tempdir_in(managed)
            .map_err(|_| "Cannot prepare CLI session directory")?;
        fs::write(
            instance.path().join("owner.json"),
            serde_json::to_vec(&serde_json::json!({"pid":std::process::id()})).unwrap(),
        )
        .map_err(|_| "Cannot prepare CLI session directory")?;
        let store = Arc::new(Self {
            root: instance,
            inner: Mutex::new(Inner::default()),
        });
        let weak = Arc::downgrade(&store);
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_secs(3600));
            let Some(store) = weak.upgrade() else {
                break;
            };
            if let Ok(mut inner) = store.inner.lock() {
                Self::sweep(&mut inner);
            };
        });
        Ok(store)
    }

    fn sweep(inner: &mut Inner) {
        let now = SystemTime::now();
        inner.sessions.retain(|_, session| {
            now.duration_since(session.used)
                .map_or(true, |age| age <= RETENTION)
        });
        while inner.sessions.len() > MAX_SESSIONS {
            let oldest = inner
                .sessions
                .iter()
                .min_by_key(|(_, session)| session.used)
                .map(|(key, _)| key.clone());
            if let Some(key) = oldest {
                inner.sessions.remove(&key);
            } else {
                break;
            }
        }
    }

    pub fn begin(
        self: &Arc<Self>,
        key: &str,
        scope: &str,
        history: &str,
        new_id: String,
    ) -> Result<SessionLease, String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "CLI session state unavailable")?;
        if !inner.active.insert(key.into()) {
            return Err("This CLI conversation is already generating a response".into());
        }
        Self::sweep(&mut inner);
        let old = inner.sessions.remove(key);
        let resume = old.as_ref().map_or(false, |session| {
            session.scope == scope && session.history == history
        });
        let session = if resume {
            old.unwrap()
        } else {
            drop(old);
            let directory = match Builder::new()
                .prefix("session-")
                .tempdir_in(self.root.path())
            {
                Ok(value) => value,
                Err(_) => {
                    inner.active.remove(key);
                    return Err("Cannot prepare CLI conversation".into());
                }
            };
            Session {
                directory,
                id: new_id,
                scope: scope.into(),
                history: String::new(),
                used: SystemTime::now(),
            }
        };
        Ok(SessionLease {
            store: self.clone(),
            key: key.into(),
            session: Some(session),
            resume,
        })
    }
}

pub struct SessionLease {
    store: Arc<SessionStore>,
    key: String,
    pub session: Option<Session>,
    pub resume: bool,
}

impl SessionLease {
    pub fn path(&self) -> &Path {
        self.session.as_ref().unwrap().directory.path()
    }
    pub fn id(&self) -> &str {
        &self.session.as_ref().unwrap().id
    }
    pub fn commit(mut self, history: String) {
        if let Ok(mut inner) = self.store.inner.lock() {
            let mut session = self.session.take().unwrap();
            session.history = history;
            session.used = SystemTime::now();
            inner.active.remove(&self.key);
            inner.sessions.insert(self.key.clone(), session);
            SessionStore::sweep(&mut inner);
        }
    }
}
impl Drop for SessionLease {
    fn drop(&mut self) {
        if let Ok(mut inner) = self.store.inner.lock() {
            inner.active.remove(&self.key);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn resumes_only_matching_history_and_cleans_superseded_sessions() {
        let temp = tempfile::tempdir().unwrap();
        let store = SessionStore::new(temp.path()).unwrap();
        let first = store.begin("chat", "scope", "", "id-1".into()).unwrap();
        assert!(!first.resume);
        let old = first.path().to_path_buf();
        assert!(store.begin("chat", "scope", "", "other".into()).is_err());
        first.commit("history".into());
        let again = store
            .begin("chat", "scope", "history", "id-2".into())
            .unwrap();
        assert!(again.resume);
        assert_eq!(again.id(), "id-1");
        again.commit("history".into());
        let changed = store
            .begin("chat", "changed", "history", "id-3".into())
            .unwrap();
        assert!(!changed.resume);
        assert!(!old.exists());
    }
    #[test]
    fn cancelled_lease_releases_the_conversation_and_removes_its_directory() {
        let temp = tempfile::tempdir().unwrap();
        let store = SessionStore::new(temp.path()).unwrap();
        let lease = store.begin("chat", "scope", "", "id".into()).unwrap();
        let path = lease.path().to_path_buf();
        drop(lease);
        assert!(!path.exists());
        assert!(store.begin("chat", "scope", "", "next".into()).is_ok());
    }
    #[test]
    fn bounds_idle_sessions_and_removes_expired_or_legacy_data() {
        let temp = tempfile::tempdir().unwrap();
        let legacy = temp.path().join("a".repeat(64));
        let unrelated = temp.path().join("user-data");
        fs::create_dir(&legacy).unwrap();
        fs::write(legacy.join("history"), "old").unwrap();
        fs::create_dir(&unrelated).unwrap();
        std::thread::sleep(Duration::from_millis(30));
        clean_legacy(temp.path(), Duration::ZERO);
        assert!(!legacy.exists());
        assert!(unrelated.exists());
        let store = SessionStore::new(temp.path()).unwrap();
        let first = store.begin("first", "scope", "", "id".into()).unwrap();
        let first_path = first.path().to_path_buf();
        first.commit("history".into());
        store
            .inner
            .lock()
            .unwrap()
            .sessions
            .get_mut("first")
            .unwrap()
            .used = SystemTime::UNIX_EPOCH;
        {
            let mut inner = store.inner.lock().unwrap();
            SessionStore::sweep(&mut inner);
        }
        assert!(!first_path.exists());
        for index in 0..=MAX_SESSIONS {
            store
                .begin(&format!("chat-{index}"), "scope", "", format!("id-{index}"))
                .unwrap()
                .commit("history".into());
        }
        assert_eq!(store.inner.lock().unwrap().sessions.len(), MAX_SESSIONS);
    }
}
