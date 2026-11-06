use std::{
    collections::HashMap,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::Manager;

const TIMEOUT: Duration = Duration::from_secs(300);

struct Pending {
    receiver: Option<mpsc::Receiver<Result<String, String>>>,
    cancelled: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct OAuthCallbacks {
    pending: Mutex<HashMap<String, Pending>>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CallbackListener {
    id: String,
    redirect_uri: String,
}

fn valid_state(state: &str) -> bool {
    (32..=128).contains(&state.len())
        && state
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn constant_time_equal(left: &str, right: &str) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.bytes()
        .zip(right.bytes())
        .fold(0u8, |diff, (a, b)| diff | (a ^ b))
        == 0
}

#[derive(Debug, PartialEq, Eq)]
enum Callback {
    Code(String),
    Denied,
}

fn parse_callback(request: &str, expected_state: &str, port: u16) -> Result<Callback, String> {
    let mut lines = request.split("\r\n");
    let first = lines.next().ok_or("Invalid OAuth callback")?;
    let mut pieces = first.split_whitespace();
    if pieces.next() != Some("GET") {
        return Err("Invalid OAuth callback".into());
    }
    let target = pieces.next().ok_or("Invalid OAuth callback")?;
    if !target.starts_with('/') || pieces.next() != Some("HTTP/1.1") || pieces.next().is_some() {
        return Err("Invalid OAuth callback".into());
    }
    let host = lines.find_map(|line| {
        line.split_once(':')
            .filter(|(name, _)| name.eq_ignore_ascii_case("host"))
            .map(|(_, value)| value.trim())
    });
    if host != Some(format!("127.0.0.1:{port}").as_str()) {
        return Err("Invalid OAuth callback".into());
    }
    let parsed = reqwest::Url::parse(&format!("http://127.0.0.1:{port}{target}"))
        .map_err(|_| "Invalid OAuth callback")?;
    if parsed.path() != "/callback" {
        return Err("Invalid OAuth callback".into());
    }
    let mut states = Vec::new();
    let mut codes = Vec::new();
    let mut denied = false;
    for (key, value) in parsed.query_pairs() {
        match key.as_ref() {
            "state" => states.push(value.into_owned()),
            "code" => codes.push(value.into_owned()),
            "error" => denied = true,
            _ => {}
        }
    }
    if states.len() != 1 || !constant_time_equal(&states[0], expected_state) {
        return Err("OAuth state mismatch".into());
    }
    if denied {
        return Ok(Callback::Denied);
    }
    if codes.len() != 1 || codes[0].is_empty() {
        return Err("Invalid OAuth callback".into());
    }
    Ok(Callback::Code(codes.remove(0)))
}

fn respond_to_callback(stream: &mut TcpStream, accepted: bool) {
    let message = if accepted {
        "登录完成，可以关闭此页面。 / Login complete. You may close this page."
    } else {
        "登录未完成，请返回应用重试。 / Login was not completed. Please return to the app."
    };
    let html = format!("<!doctype html><html lang=\"en\"><meta charset=\"utf-8\"><title>NextChat</title><body><p>{message}</p><script>history.replaceState(null,'',location.pathname)</script></body></html>");
    let status = if accepted {
        "200 OK"
    } else {
        "400 Bad Request"
    };
    let response = format!("HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nContent-Security-Policy: default-src 'none'; script-src 'sha256-UBodp8UhLR9ASBc1PNRKcs3r2CjAFWxCbrUGPN7u1jo='; frame-ancestors 'none'\r\nConnection: close\r\n\r\n{html}", html.as_bytes().len());
    let _ = stream.set_nonblocking(false);
    let _ = stream.set_write_timeout(Some(Duration::from_millis(200)));
    let _ = stream.write_all(response.as_bytes());
}

fn wait_for_callback(
    listener: TcpListener,
    expected: &str,
    port: u16,
    cancelled: &AtomicBool,
    timeout: Duration,
) -> Result<String, String> {
    const MAX_CONNECTIONS: usize = 32;
    const MAX_REQUEST: usize = 8192;
    const CONNECTION_TIMEOUT: Duration = Duration::from_secs(5);

    struct Connection {
        stream: TcpStream,
        data: Vec<u8>,
        started: Instant,
    }

    let started = Instant::now();
    let mut connections: Vec<Connection> = Vec::new();
    loop {
        if cancelled.load(Ordering::Relaxed) {
            return Err("OAuth login cancelled".into());
        }
        if started.elapsed() >= timeout {
            return Err("OAuth login timed out".into());
        }
        // Each socket is nonblocking. A browser's idle preconnection therefore
        // cannot keep us from accepting the actual authorization redirect.
        for _ in 0..MAX_CONNECTIONS {
            match listener.accept() {
                Ok((stream, peer)) if peer.ip().is_loopback() => {
                    if stream.set_nonblocking(true).is_err() {
                        continue;
                    }
                    if connections.len() == MAX_CONNECTIONS {
                        connections.remove(0);
                    }
                    connections.push(Connection {
                        stream,
                        data: Vec::new(),
                        started: Instant::now(),
                    });
                }
                Ok(_) => continue,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => break,
                Err(_) => return Err("OAuth callback failed".into()),
            }
        }

        let mut index = 0;
        while index < connections.len() {
            let connection = &mut connections[index];
            let mut disconnected = false;
            let mut chunk = [0u8; 1024];
            while connection.data.len() < MAX_REQUEST
                && !connection.data.windows(4).any(|w| w == b"\r\n\r\n")
            {
                let remaining = MAX_REQUEST - connection.data.len();
                let read_len = remaining.min(chunk.len());
                match connection.stream.read(&mut chunk[..read_len]) {
                    Ok(0) => {
                        disconnected = true;
                        break;
                    }
                    Ok(count) => connection.data.extend_from_slice(&chunk[..count]),
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => break,
                    Err(_) => {
                        disconnected = true;
                        break;
                    }
                }
            }
            let complete = connection.data.windows(4).any(|w| w == b"\r\n\r\n");
            let too_large = connection.data.len() >= MAX_REQUEST && !complete;
            if complete || too_large {
                let mut connection = connections.swap_remove(index);
                let parsed = if complete {
                    std::str::from_utf8(&connection.data)
                        .map_err(|_| "Invalid OAuth callback".to_owned())
                        .and_then(|text| parse_callback(text, expected, port))
                } else {
                    Err("Invalid OAuth callback".into())
                };
                respond_to_callback(
                    &mut connection.stream,
                    matches!(&parsed, Ok(Callback::Code(_))),
                );
                if cancelled.load(Ordering::Relaxed) {
                    return Err("OAuth login cancelled".into());
                }
                match parsed {
                    Ok(Callback::Code(code)) => return Ok(code),
                    Ok(Callback::Denied) => {
                        return Err("OAuth authorization was not completed".into())
                    }
                    Err(_) => continue,
                }
            } else if disconnected || connection.started.elapsed() >= CONNECTION_TIMEOUT {
                let mut connection = connections.swap_remove(index);
                if !connection.data.is_empty() {
                    respond_to_callback(&mut connection.stream, false);
                }
            } else {
                index += 1;
            }
        }
        thread::sleep(Duration::from_millis(10));
    }
}

#[tauri::command]
pub async fn mcp_oauth_listen(
    state: tauri::State<'_, Arc<OAuthCallbacks>>,
    nonce: String,
) -> Result<CallbackListener, String> {
    if !valid_state(&nonce) {
        return Err("Invalid OAuth state".into());
    }
    let listener =
        TcpListener::bind(("127.0.0.1", 0)).map_err(|_| "OAuth callback could not start")?;
    let port = listener
        .local_addr()
        .map_err(|_| "OAuth callback could not start")?
        .port();
    listener
        .set_nonblocking(true)
        .map_err(|_| "OAuth callback could not start")?;
    let (sender, receiver) = mpsc::channel();
    let cancelled = Arc::new(AtomicBool::new(false));
    let mut pending = state
        .pending
        .lock()
        .map_err(|_| "OAuth callback could not start")?;
    if pending.contains_key(&nonce) {
        return Err("Invalid OAuth state".into());
    }
    pending.insert(
        nonce.clone(),
        Pending {
            receiver: Some(receiver),
            cancelled: cancelled.clone(),
        },
    );
    drop(pending);
    let expected = nonce.clone();
    thread::spawn(move || {
        let result = wait_for_callback(listener, &expected, port, &cancelled, TIMEOUT);
        let _ = sender.send(result);
    });
    Ok(CallbackListener {
        id: nonce,
        redirect_uri: format!("http://127.0.0.1:{port}/callback"),
    })
}

#[tauri::command]
pub async fn mcp_oauth_wait(
    state: tauri::State<'_, Arc<OAuthCallbacks>>,
    id: String,
) -> Result<String, String> {
    let callbacks = state.inner().clone();
    let receiver = callbacks
        .pending
        .lock()
        .map_err(|_| "OAuth session unavailable")?
        .get_mut(&id)
        .and_then(|pending| pending.receiver.take())
        .ok_or("OAuth session unavailable")?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        receiver.recv_timeout(TIMEOUT + Duration::from_secs(2))
    })
    .await;
    if let Ok(mut pending) = callbacks.pending.lock() {
        pending.remove(&id);
    }
    result
        .map_err(|_| "OAuth callback failed")?
        .map_err(|_| "OAuth login timed out")?
}

#[tauri::command]
pub async fn mcp_oauth_cancel(
    state: tauri::State<'_, Arc<OAuthCallbacks>>,
    id: String,
) -> Result<(), String> {
    if let Some(pending) = state
        .pending
        .lock()
        .map_err(|_| "OAuth session unavailable")?
        .remove(&id)
    {
        pending.cancelled.store(true, Ordering::Relaxed);
    }
    Ok(())
}

#[tauri::command]
pub async fn mcp_oauth_open(
    app: tauri::AppHandle,
    authorization_url: String,
    callback_uri: String,
) -> Result<(), String> {
    let url = reqwest::Url::parse(&authorization_url).map_err(|_| "Invalid OAuth URL")?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("Invalid OAuth URL".into());
    }
    // This opt-in hook is restricted to loopback, and is used only with an
    // auto-consenting local mock so automated tests never open a browser.
    if std::env::var("NEXTCHAT_MCP_OAUTH_TEST_AUTO")
        .ok()
        .as_deref()
        == Some("1")
    {
        let callback = reqwest::Url::parse(&callback_uri).map_err(|_| "Invalid OAuth callback")?;
        if url.scheme() != "http"
            || url.host_str() != Some("127.0.0.1")
            || callback.scheme() != "http"
            || callback.host_str() != Some("127.0.0.1")
            || callback.path() != "/callback"
        {
            return Err("Invalid test OAuth URL".into());
        }
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| "OAuth login failed")?;
        let response = client
            .get(url)
            .send()
            .await
            .map_err(|_| "OAuth login failed")?;
        let location = response
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|v| v.to_str().ok())
            .ok_or("OAuth login failed")?;
        let target = reqwest::Url::parse(location).map_err(|_| "OAuth login failed")?;
        if target.origin() != callback.origin() || target.path() != callback.path() {
            return Err("OAuth login failed".into());
        }
        client
            .get(target)
            .send()
            .await
            .map_err(|_| "OAuth login failed")?;
        return Ok(());
    }
    tauri::api::shell::open(&app.shell_scope(), url.as_str(), None)
        .map_err(|_| "Could not open OAuth login".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn callback_requires_one_matching_state_and_code() {
        let state = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFG";
        let request = format!(
            "GET /callback?state={state}&code=test HTTP/1.1\r\nHost: 127.0.0.1:4567\r\n\r\n"
        );
        assert_eq!(
            parse_callback(&request, state, 4567).unwrap(),
            Callback::Code("test".into())
        );
        assert!(parse_callback(&request, "wrong", 4567).is_err());
        assert_eq!(
            parse_callback(&request.replace("code=test", "error=denied"), state, 4567).unwrap(),
            Callback::Denied
        );
        assert!(parse_callback(
            &request.replace("code=test", "code=test&code=other"),
            state,
            4567
        )
        .is_err());
        assert!(
            parse_callback(&request.replace("127.0.0.1:4567", "evil.test"), state, 4567).is_err()
        );
    }

    fn send_request(port: u16, path: &str) -> String {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let request = format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n");
        stream.write_all(request.as_bytes()).unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        response
    }

    #[test]
    fn idle_favicon_and_invalid_state_do_not_prevent_a_real_callback() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let state = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFG";
        let worker = thread::spawn(move || {
            wait_for_callback(
                listener,
                state,
                port,
                &AtomicBool::new(false),
                Duration::from_secs(5),
            )
        });
        let _idle = TcpStream::connect(("127.0.0.1", port)).unwrap();
        assert!(send_request(port, "/favicon.ico").starts_with("HTTP/1.1 400"));
        let mut malformed = TcpStream::connect(("127.0.0.1", port)).unwrap();
        malformed
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        malformed.write_all(b"GET /callback HTTP/1.1\r\n").unwrap();
        malformed.shutdown(std::net::Shutdown::Write).unwrap();
        let mut malformed_response = String::new();
        malformed.read_to_string(&mut malformed_response).unwrap();
        assert!(malformed_response.starts_with("HTTP/1.1 400"));
        assert!(
            send_request(port, "/callback?state=wrong&code=synthetic").starts_with("HTTP/1.1 400")
        );
        assert!(
            send_request(port, "/callback?state=wrong&error=denied").starts_with("HTTP/1.1 400")
        );
        assert!(
            send_request(port, &format!("/callback?state={state}&code=synthetic"))
                .starts_with("HTTP/1.1 200")
        );
        assert_eq!(worker.join().unwrap().unwrap(), "synthetic");
        assert!(TcpStream::connect(("127.0.0.1", port)).is_err());
    }

    #[test]
    fn matching_state_denial_ends_the_wait() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let state = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFG";
        let worker = thread::spawn(move || {
            wait_for_callback(
                listener,
                state,
                port,
                &AtomicBool::new(false),
                Duration::from_secs(5),
            )
        });
        assert!(send_request(
            port,
            &format!("/callback?state={state}&error=access_denied")
        )
        .starts_with("HTTP/1.1 400"));
        assert_eq!(
            worker.join().unwrap().unwrap_err(),
            "OAuth authorization was not completed"
        );
    }

    #[test]
    fn cancellation_closes_a_listener_with_an_idle_connection() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let cancelled = Arc::new(AtomicBool::new(false));
        let flag = cancelled.clone();
        let worker = thread::spawn(move || {
            wait_for_callback(listener, "state", port, &flag, Duration::from_secs(5))
        });
        let _idle = TcpStream::connect(("127.0.0.1", port)).unwrap();
        cancelled.store(true, Ordering::Relaxed);
        assert_eq!(worker.join().unwrap().unwrap_err(), "OAuth login cancelled");
    }

    #[test]
    fn loopback_callback_completes_once_and_listener_times_out() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let state = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFG";
        let worker = thread::spawn(move || {
            wait_for_callback(
                listener,
                state,
                port,
                &AtomicBool::new(false),
                Duration::from_secs(3),
            )
        });
        let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        let request = format!(
            "GET /callback?state={state}&code=synthetic HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n"
        );
        let write_result = stream.write_all(request.as_bytes());
        let mut response = String::new();
        let read_result = stream.read_to_string(&mut response);
        let callback_result = worker.join().unwrap();
        assert!(
            write_result.is_ok(),
            "write: {write_result:?}; callback: {callback_result:?}"
        );
        assert!(
            read_result.is_ok(),
            "read: {read_result:?}; callback: {callback_result:?}"
        );
        assert!(response.contains("Login complete"));
        assert_eq!(callback_result.unwrap(), "synthetic");
        assert!(TcpStream::connect(("127.0.0.1", port)).is_err());

        let idle = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        idle.set_nonblocking(true).unwrap();
        let idle_port = idle.local_addr().unwrap().port();
        assert_eq!(
            wait_for_callback(
                idle,
                state,
                idle_port,
                &AtomicBool::new(false),
                Duration::from_millis(100)
            )
            .unwrap_err(),
            "OAuth login timed out"
        );
    }
}
