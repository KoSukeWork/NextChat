use bzip2::read::BzDecoder;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
use tokio::io::AsyncWriteExt;
use tokio_util::sync::CancellationToken;

pub const NAME: &str = "vits-melo-tts-zh_en";
pub const URL: &str = "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-melo-tts-zh_en.tar.bz2";
pub const SHA256: &str = "e58351ed7149f290a54534538badd4077cdbe6fddc964b24d0bee870415d1514";
pub const DOWNLOAD_BYTES: u64 = 167_006_755;
const MAX_EXTRACTED_BYTES: u64 = 512 * 1024 * 1024;
const REQUIRED: &[&str] = &[
    "model.onnx",
    "tokens.txt",
    "lexicon.txt",
    "phone.fst",
    "date.fst",
    "number.fst",
];
pub type Result<T> = std::result::Result<T, String>;

pub fn cancelled(token: &CancellationToken) -> Result<()> {
    if token.is_cancelled() {
        Err("CANCELLED".into())
    } else {
        Ok(())
    }
}

fn io(error: impl std::fmt::Display) -> String {
    format!("MODEL_IO: {error}")
}

pub fn reject_link(path: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(path).map_err(io)?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err("INVALID_MODEL_PATH".into());
        }
    }
    if metadata.file_type().is_symlink() {
        return Err("INVALID_MODEL_PATH".into());
    }
    Ok(())
}

pub fn directory_size(path: &Path) -> Result<u64> {
    fn walk(path: &Path, depth: usize, count: &mut usize) -> Result<u64> {
        reject_link(path)?;
        *count += 1;
        if depth > 16 || *count > 4096 {
            return Err("INVALID_MODEL_PATH".into());
        }
        if path.is_file() {
            return Ok(fs::metadata(path).map_err(io)?.len());
        }
        let mut size = 0;
        for entry in fs::read_dir(path).map_err(io)? {
            size += walk(&entry.map_err(io)?.path(), depth + 1, count)?;
        }
        Ok(size)
    }
    walk(path, 0, &mut 0)
}

#[derive(Serialize, Deserialize)]
struct Installed {
    sha256: String,
    bytes: u64,
}

pub fn ready_size(directory: &Path) -> Result<Option<u64>> {
    if !directory.exists() {
        return Ok(None);
    }
    reject_link(directory)?;
    let manifest = directory.join("installed.json");
    if !manifest.is_file() {
        return Err("MODEL_FILES_MISSING".into());
    }
    reject_link(&manifest)?;
    let installed: Installed =
        serde_json::from_slice(&fs::read(manifest).map_err(io)?).map_err(io)?;
    if installed.sha256 != SHA256 {
        return Err("MODEL_HASH_MISMATCH".into());
    }
    for file in REQUIRED {
        let path = directory.join(file);
        if !path.is_file() {
            return Err("MODEL_FILES_MISSING".into());
        }
        reject_link(&path)?;
        if fs::metadata(path).map_err(io)?.len() == 0 {
            return Err("MODEL_FILES_MISSING".into());
        }
    }
    Ok(Some(installed.bytes))
}

pub fn verify_hash(path: &Path, expected: &str, token: &CancellationToken) -> Result<()> {
    let mut input = File::open(path).map_err(io)?;
    let mut hash = Sha256::new();
    let mut buffer = [0; 64 * 1024];
    loop {
        cancelled(token)?;
        let n = input.read(&mut buffer).map_err(io)?;
        if n == 0 {
            break;
        }
        hash.update(&buffer[..n]);
    }
    if format!("{:x}", hash.finalize()) != expected {
        return Err("MODEL_HASH_MISMATCH".into());
    }
    Ok(())
}

// Check the original spelling, before Path normalizes away '.' or '..'. Apply
// Windows rules on every OS so archives cannot become unsafe when moved later.
fn safe_archive_path(raw: &[u8]) -> Result<PathBuf> {
    let value = std::str::from_utf8(raw).map_err(|_| "INVALID_ARCHIVE")?;
    if value.starts_with('/')
        || value.starts_with('\\')
        || value.contains('\\')
        || value.contains(':')
        || value.contains('\0')
    {
        return Err("INVALID_ARCHIVE".into());
    }
    let mut parts = value.trim_end_matches('/').split('/');
    if parts.next() != Some(NAME) {
        return Err("INVALID_ARCHIVE".into());
    }
    let mut output = PathBuf::from(NAME);
    for part in parts {
        if part.is_empty()
            || part == "."
            || part == ".."
            || part.ends_with('.')
            || part.ends_with(' ')
        {
            return Err("INVALID_ARCHIVE".into());
        }
        let base = part.split('.').next().unwrap_or("").to_ascii_uppercase();
        if matches!(base.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || (base.len() == 4
                && (base.starts_with("COM") || base.starts_with("LPT"))
                && matches!(base.as_bytes()[3], b'1'..=b'9'))
        {
            return Err("INVALID_ARCHIVE".into());
        }
        output.push(part);
    }
    Ok(output)
}

pub fn extract(archive: &Path, stage: &Path, token: &CancellationToken) -> Result<PathBuf> {
    let reader = BzDecoder::new(File::open(archive).map_err(io)?);
    let mut tar = tar::Archive::new(reader);
    let mut total = 0u64;
    let mut count = 0;
    for item in tar.entries().map_err(|e| format!("INVALID_ARCHIVE: {e}"))? {
        cancelled(token)?;
        count += 1;
        if count > 4096 {
            return Err("INVALID_ARCHIVE".into());
        }
        let mut entry = item.map_err(|e| format!("INVALID_ARCHIVE: {e}"))?;
        let kind = entry.header().entry_type();
        // Reject links, devices, FIFOs and every special entry; never unpack them.
        if !kind.is_file() && !kind.is_dir() {
            return Err("INVALID_ARCHIVE".into());
        }
        let relative = safe_archive_path(&entry.path_bytes())?;
        let target = stage.join(relative);
        if kind.is_dir() {
            fs::create_dir_all(target).map_err(io)?;
            continue;
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(io)?;
        }
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(target)
            .map_err(io)?;
        let mut buffer = [0; 64 * 1024];
        loop {
            cancelled(token)?;
            let n = entry.read(&mut buffer).map_err(io)?;
            if n == 0 {
                break;
            }
            total += n as u64;
            if total > MAX_EXTRACTED_BYTES {
                return Err("INVALID_ARCHIVE".into());
            }
            output.write_all(&buffer[..n]).map_err(io)?;
        }
    }
    let directory = stage.join(NAME);
    for file in REQUIRED {
        let path = directory.join(file);
        if !path.is_file() || fs::metadata(path).map_err(io)?.len() == 0 {
            return Err("MODEL_FILES_MISSING".into());
        }
    }
    Ok(directory)
}

pub fn publish(
    archive: &Path,
    stage: &Path,
    destination: &Path,
    token: &CancellationToken,
) -> Result<u64> {
    verify_hash(archive, SHA256, token)?;
    let directory = extract(archive, stage, token)?;
    let bytes = directory_size(&directory)?;
    fs::write(
        directory.join("installed.json"),
        serde_json::to_vec(&Installed {
            sha256: SHA256.into(),
            bytes,
        })
        .map_err(io)?,
    )
    .map_err(io)?;
    cancelled(token)?;
    // A complete installation is published in one rename on the same volume.
    if destination.exists() {
        return Err("MODEL_ALREADY_EXISTS".into());
    }
    fs::rename(directory, destination).map_err(io)?;
    Ok(bytes)
}

pub fn copy_import(source: &Path, destination: &Path, token: &CancellationToken) -> Result<()> {
    let mut input = File::open(source).map_err(io)?;
    if input.metadata().map_err(io)?.len() != DOWNLOAD_BYTES {
        return Err("MODEL_SIZE_MISMATCH".into());
    }
    let mut output = File::create(destination).map_err(io)?;
    let mut buffer = [0; 64 * 1024];
    let mut count = 0;
    loop {
        cancelled(token)?;
        let n = input.read(&mut buffer).map_err(io)?;
        if n == 0 {
            break;
        }
        count += n as u64;
        if count > DOWNLOAD_BYTES {
            return Err("MODEL_SIZE_MISMATCH".into());
        }
        output.write_all(&buffer[..n]).map_err(io)?;
    }
    if count != DOWNLOAD_BYTES {
        return Err("MODEL_SIZE_MISMATCH".into());
    }
    Ok(())
}

// URL/size are parameters only for internal tests. The IPC command supplies the
// constants above and never accepts URLs, hashes or destination paths from JS.
pub async fn download(
    url: &str,
    destination: &Path,
    expected_size: u64,
    token: &CancellationToken,
    progress: impl Fn(u64),
) -> Result<()> {
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(1800))
        .build()
        .map_err(|e| format!("DOWNLOAD_FAILED: {e}"))?;
    let response = tokio::select! {
        _=token.cancelled()=>return Err("CANCELLED".into()),
        result=client.get(url).send()=>result.map_err(|e| format!("DOWNLOAD_FAILED: {e}"))?.error_for_status().map_err(|e| format!("DOWNLOAD_FAILED: {e}"))?,
    };
    if response
        .content_length()
        .is_some_and(|size| size != expected_size)
    {
        return Err("MODEL_SIZE_MISMATCH".into());
    }
    let mut output = tokio::fs::File::create(destination).await.map_err(io)?;
    let result = async {
        let mut stream = response.bytes_stream();
        let mut bytes = 0u64;
        let mut last = Instant::now();
        loop {
            let chunk = tokio::select! {
                _=token.cancelled()=>return Err("CANCELLED".into()),
                next=stream.next()=>next,
            };
            let Some(chunk) = chunk else {
                break;
            };
            let chunk = chunk.map_err(|e| format!("DOWNLOAD_FAILED: {e}"))?;
            bytes += chunk.len() as u64;
            if bytes > expected_size {
                return Err("MODEL_SIZE_MISMATCH".into());
            }
            output.write_all(&chunk).await.map_err(io)?;
            if last.elapsed() >= Duration::from_millis(100) || bytes == expected_size {
                progress(bytes);
                last = Instant::now();
            }
        }
        cancelled(token)?;
        if bytes != expected_size {
            return Err("MODEL_SIZE_MISMATCH".into());
        }
        Ok(())
    }
    .await;
    // Complete pending OS writes before TempDir can remove the staging directory.
    let flushed = output.flush().await.map_err(io);
    drop(output);
    result.and(flushed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use bzip2::{write::BzEncoder, Compression};
    use std::{net::TcpListener, thread};

    #[test]
    fn rejects_cross_platform_traversal_and_device_paths() {
        for name in [
            "/tmp/evil",
            "../evil",
            "C:/evil",
            "\\\\server\\share",
            "vits-melo-tts-zh_en/../evil",
            "vits-melo-tts-zh_en/a/../../evil",
            "vits-melo-tts-zh_en/a\\..\\evil",
            "vits-melo-tts-zh_en/a:stream",
            "vits-melo-tts-zh_en/CON",
            "vits-melo-tts-zh_en/a. ",
        ] {
            assert!(safe_archive_path(name.as_bytes()).is_err(), "{name}");
        }
        assert_eq!(
            safe_archive_path(b"vits-melo-tts-zh_en/dict/a.txt").unwrap(),
            PathBuf::from(NAME).join("dict/a.txt")
        );
    }

    #[test]
    fn extractor_rejects_symlinks_and_hard_links() {
        for kind in [tar::EntryType::Symlink, tar::EntryType::Link] {
            let temp = tempfile::tempdir().unwrap();
            let file = temp.path().join("model.tar.bz2");
            let encoder = BzEncoder::new(File::create(&file).unwrap(), Compression::fast());
            let mut archive = tar::Builder::new(encoder);
            let mut header = tar::Header::new_gnu();
            header.set_entry_type(kind);
            header.set_size(0);
            header.set_mode(0o644);
            header.set_cksum();
            archive
                .append_link(&mut header, format!("{NAME}/escape"), "../../outside")
                .unwrap();
            archive.into_inner().unwrap().finish().unwrap();
            assert_eq!(
                extract(&file, temp.path(), &CancellationToken::new()).unwrap_err(),
                "INVALID_ARCHIVE"
            );
            assert!(!temp.path().join(NAME).join("escape").exists());
        }
    }

    #[test]
    fn hash_mismatch_never_publishes_a_model() {
        let temp = tempfile::tempdir().unwrap();
        let archive = temp.path().join("wrong");
        fs::write(&archive, b"wrong archive").unwrap();
        let destination = temp.path().join("installed");
        assert_eq!(
            publish(
                &archive,
                temp.path(),
                &destination,
                &CancellationToken::new()
            )
            .unwrap_err(),
            "MODEL_HASH_MISMATCH"
        );
        assert!(!destination.exists());
    }

    #[tokio::test]
    async fn stalled_download_can_be_cancelled_and_staging_removed() {
        let server = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = server.local_addr().unwrap();
        let worker = thread::spawn(move || {
            let (mut stream, _) = server.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut buffer = [0; 4096];
            let _ = stream.read(&mut buffer);
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 1000\r\n\r\nx")
                .unwrap();
            thread::sleep(Duration::from_millis(300));
        });
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().to_owned();
        let token = CancellationToken::new();
        let cancel = token.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(80)).await;
            cancel.cancel();
        });
        let start = Instant::now();
        let result = download(
            &format!("http://{address}"),
            &temp.path().join("partial"),
            1000,
            &token,
            |_| {},
        )
        .await;
        assert_eq!(result.unwrap_err(), "CANCELLED");
        assert!(start.elapsed() < Duration::from_secs(2));
        temp.close().unwrap();
        assert!(!directory.exists());
        worker.join().unwrap();
    }

    #[tokio::test]
    async fn local_http_download_is_verified_before_use() {
        let body = b"test model archive";
        let server = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = server.local_addr().unwrap();
        let worker = thread::spawn(move || {
            let (mut stream, _) = server.accept().unwrap();
            let mut buffer = [0; 4096];
            let _ = stream.read(&mut buffer);
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n",
                body.len()
            )
            .unwrap();
            stream.write_all(body).unwrap();
        });
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("download");
        let token = CancellationToken::new();
        download(
            &format!("http://{address}"),
            &file,
            body.len() as u64,
            &token,
            |_| {},
        )
        .await
        .unwrap();
        verify_hash(&file, &format!("{:x}", Sha256::digest(body)), &token).unwrap();
        assert_eq!(
            verify_hash(&file, SHA256, &token).unwrap_err(),
            "MODEL_HASH_MISMATCH"
        );
        worker.join().unwrap();
    }
}
