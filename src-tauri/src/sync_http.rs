//! Desktop cloud sync transport. Never routes credentials through a web proxy.
use reqwest::{header, redirect::Policy, Client, Method, Url};
use serde::{Deserialize, Serialize};
use std::{error::Error, time::Duration};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncRequest {
    endpoint: String,
    path: String,
    method: String,
    username: Option<String>,
    password: Option<String>,
    token: Option<String>,
    body: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct SyncError {
    code: &'static str,
}

#[derive(Debug, Serialize)]
pub struct SyncResponse {
    status: u16,
    body: String,
}

fn invalid() -> SyncError {
    SyncError {
        code: "INVALID_ENDPOINT",
    }
}

fn target(request: &SyncRequest) -> Result<Url, SyncError> {
    let mut url = Url::parse(&request.endpoint).map_err(|_| invalid())?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(invalid());
    }
    // Append individual path segments rather than joining a caller-supplied URL.
    // Encoded slashes remain data, and cannot change the authority.
    if request
        .path
        .split('/')
        .any(|s| s.is_empty() || s == "." || s == "..")
    {
        return Err(invalid());
    }
    url.path_segments_mut()
        .map_err(|_| invalid())?
        .pop_if_empty()
        .extend(request.path.split('/'));
    Ok(url)
}

fn network_error(error: reqwest::Error) -> SyncError {
    // Inspect causes for classification but never serialize them: reqwest and
    // proxy errors can contain URLs or credentials supplied by the server.
    let mut causes = String::new();
    let mut source = error.source();
    while let Some(cause) = source {
        causes.push_str(&cause.to_string().to_lowercase());
        source = cause.source();
    }
    let code = if error.is_timeout() {
        "NETWORK_TIMEOUT"
    } else if causes.contains("dns") || causes.contains("resolve") || causes.contains("11001") {
        "NETWORK_DNS"
    } else if causes.contains("certificate") || causes.contains("tls") || causes.contains("ssl") {
        "NETWORK_TLS"
    } else if causes.contains("refused")
        || causes.contains("10061")
        || causes.contains("os error 111")
    {
        "NETWORK_REFUSED"
    } else if error.is_connect() {
        "NETWORK_CONNECT"
    } else {
        "NETWORK_FAILED"
    };
    SyncError { code }
}

async fn perform(request: SyncRequest, timeout: Duration) -> Result<SyncResponse, SyncError> {
    let url = target(&request)?;
    let method = match request.method.as_str() {
        "GET" => Method::GET,
        "PUT" => Method::PUT,
        "POST" => Method::POST,
        "MKCOL" => Method::from_bytes(b"MKCOL").unwrap(),
        _ => {
            return Err(SyncError {
                code: "INVALID_METHOD",
            })
        }
    };
    // Stricter than reqwest's default sensitive-header removal: follow NO
    // redirects, even same-origin. Credentials and PUT bodies cannot be forwarded.
    let client = Client::builder()
        .redirect(Policy::none())
        .timeout(timeout)
        .build()
        .map_err(network_error)?;
    let mut builder = client.request(method, url);
    if let Some(token) = request.token {
        builder = builder.bearer_auth(token);
    } else {
        builder = builder.basic_auth(request.username.unwrap_or_default(), request.password);
    }
    if let Some(body) = request.body {
        builder = builder
            .header(header::CONTENT_TYPE, "application/json")
            .body(body);
    }
    let response = builder.send().await.map_err(network_error)?;
    let status = response.status().as_u16();
    // Error bodies are intentionally not exposed to the UI: a server can echo
    // Authorization, paths, or user data. The HTTP status is sufficient.
    let body = if (200..300).contains(&status) {
        response.text().await.map_err(network_error)?
    } else {
        String::new()
    };
    Ok(SyncResponse { status, body })
}

#[tauri::command]
pub async fn sync_http(request: SyncRequest) -> Result<SyncResponse, SyncError> {
    perform(request, Duration::from_secs(30)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
        sync::{Arc, Mutex},
    };

    fn request(endpoint: String, method: &str, path: &str) -> SyncRequest {
        SyncRequest {
            endpoint,
            path: path.into(),
            method: method.into(),
            username: Some("test-user".into()),
            password: Some("app-password".into()),
            token: None,
            body: None,
        }
    }

    #[test]
    fn endpoint_authority_is_fixed_and_only_http_is_accepted() {
        for endpoint in [
            "file:///C:/secret",
            "ftp://example.test",
            "https://user:password@example.test",
            "https://example.test/?secret=1",
            "https://example.test/#part",
        ] {
            assert_eq!(
                target(&request(endpoint.into(), "GET", "nextchat/backup.json"))
                    .unwrap_err()
                    .code,
                "INVALID_ENDPOINT"
            );
        }
        let valid = target(&request(
            "https://example.test/dav/base/".into(),
            "GET",
            "nextchat/backup.json",
        ))
        .unwrap();
        assert_eq!(
            valid.as_str(),
            "https://example.test/dav/base/nextchat/backup.json"
        );
        assert!(target(&request("https://example.test".into(), "GET", "../secret")).is_err());
        assert!(target(&request(
            "https://example.test".into(),
            "GET",
            "//evil.test"
        ))
        .is_err());
    }

    #[tokio::test]
    async fn local_authenticated_webdav_roundtrip_and_http_errors() {
        let server = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}", server.local_addr().unwrap());
        let observed = Arc::new(Mutex::new(Vec::new()));
        let captured = observed.clone();
        let handle = std::thread::spawn(move || {
            for (status, body) in [
                (201, ""),
                (404, ""),
                (201, ""),
                (405, ""),
                (200, "{\"remote\":true}"),
                (204, ""),
                (401, "secret must not escape"),
                (409, "secret"),
                (429, "secret"),
            ] {
                let (mut socket, _) = server.accept().unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut bytes = Vec::new();
                let mut buf = [0; 4096];
                loop {
                    let n = socket.read(&mut buf).unwrap();
                    if n == 0 {
                        break;
                    }
                    bytes.extend_from_slice(&buf[..n]);
                    if let Some(end) = bytes.windows(4).position(|v| v == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&bytes[..end]).to_lowercase();
                        let length = headers
                            .lines()
                            .find_map(|l| l.strip_prefix("content-length: "))
                            .and_then(|n| n.parse::<usize>().ok())
                            .unwrap_or(0);
                        if bytes.len() >= end + 4 + length {
                            break;
                        }
                    }
                }
                let text = String::from_utf8(bytes).unwrap();
                assert!(text.to_lowercase().contains(
                    "authorization: basic dGVzdC11c2VyOmFwcC1wYXNzd29yZA=="
                        .to_lowercase()
                        .as_str()
                ));
                captured
                    .lock()
                    .unwrap()
                    .push(text.lines().next().unwrap().to_owned());
                write!(socket,"HTTP/1.1 {status} Test\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
            }
        });
        for (method, path, status) in [
            ("MKCOL", "nextchat", 201),
            ("GET", "nextchat/backup.json", 404),
            ("PUT", "nextchat/backup.json", 201),
            ("MKCOL", "nextchat", 405),
            ("GET", "nextchat/backup.json", 200),
            ("PUT", "nextchat/backup.json", 204),
            ("GET", "nextchat/backup.json", 401),
            ("PUT", "nextchat/backup.json", 409),
            ("GET", "nextchat/backup.json", 429),
        ] {
            let mut req = request(endpoint.clone(), method, path);
            if method == "PUT" {
                req.body = Some("{\"local\":true}".into());
            }
            let response = perform(req, Duration::from_secs(5)).await.unwrap();
            assert_eq!(response.status, status);
            if status >= 300 {
                assert!(response.body.is_empty());
            }
            if status == 200 {
                assert_eq!(response.body, "{\"remote\":true}");
            }
        }
        handle.join().unwrap();
        assert_eq!(observed.lock().unwrap().len(), 9);
    }

    #[tokio::test]
    async fn redirects_never_forward_auth_or_uploads() {
        let target = TcpListener::bind("127.0.0.1:0").unwrap();
        target.set_nonblocking(true).unwrap();
        let server = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}", server.local_addr().unwrap());
        let location = format!(
            "http://localhost:{}/capture",
            target.local_addr().unwrap().port()
        );
        let handle = std::thread::spawn(move || {
            let (mut socket, _) = server.accept().unwrap();
            let mut buf = [0; 8192];
            socket.read(&mut buf).unwrap();
            write!(socket,"HTTP/1.1 307 Temporary Redirect\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
        });
        let response = perform(
            request(endpoint, "GET", "nextchat/backup.json"),
            Duration::from_secs(5),
        )
        .await
        .unwrap();
        assert_eq!(response.status, 307);
        assert_eq!(
            target.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
        handle.join().unwrap();
    }

    #[tokio::test]
    async fn network_failures_keep_safe_specific_codes() {
        let server = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}", server.local_addr().unwrap());
        drop(server);
        assert_eq!(
            perform(
                request(endpoint, "GET", "nextchat/backup.json"),
                Duration::from_secs(5)
            )
            .await
            .unwrap_err()
            .code,
            "NETWORK_REFUSED"
        );
        let server = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}", server.local_addr().unwrap());
        let handle = std::thread::spawn(move || {
            let (_socket, _) = server.accept().unwrap();
            std::thread::sleep(Duration::from_millis(300));
        });
        assert_eq!(
            perform(
                request(endpoint, "GET", "nextchat/backup.json"),
                Duration::from_millis(100)
            )
            .await
            .unwrap_err()
            .code,
            "NETWORK_TIMEOUT"
        );
        handle.join().unwrap();
    }
}
