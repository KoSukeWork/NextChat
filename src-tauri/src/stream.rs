//
//

use std::time::Duration;
use std::time::Instant;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use futures_util::{StreamExt};
use reqwest::Client;
use reqwest::header::{HeaderName, HeaderMap};
use tokio_util::sync::CancellationToken;

static REQUEST_COUNTER: AtomicU32 = AtomicU32::new(0);

#[derive(Default)]
pub struct StreamState {
  requests: Mutex<HashMap<String, (CancellationToken, Instant)>>,
}

impl StreamState {
  fn token(&self, id: &str) -> CancellationToken {
    let mut requests = self.requests.lock().unwrap();
    // A cancellation may arrive before its request is registered. Keep such
    // entries briefly so the later request cannot start after being stopped.
    requests.retain(|_, (token, created)| {
      !token.is_cancelled() || created.elapsed() < Duration::from_secs(120)
    });
    requests.entry(id.to_string())
      .or_insert_with(|| (CancellationToken::new(), Instant::now()))
      .0.clone()
  }

  fn finish(&self, id: &str) {
    self.requests.lock().unwrap().remove(id);
  }
}

#[tauri::command]
pub fn stream_cancel(state: tauri::State<'_, Arc<StreamState>>, cancel_id: String) {
  state.token(&cancel_id).cancel();
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct StreamResponse {
  request_id: u32,
  status: u16,
  status_text: String,
  headers: HashMap<String, String>,
  // Set only by the native bridge, never from an HTTP response header or body.
  network_error: Option<String>,
  request_not_sent: Option<bool>,
}

#[derive(Clone, serde::Serialize)]
pub struct EndPayload {
  request_id: u32,
  status: u16,
}

#[derive(Clone, serde::Serialize)]
pub struct ChunkPayload {
  request_id: u32,
  chunk: bytes::Bytes,
}

const LOOPBACK_CONNECT_TIMEOUT: Duration = Duration::from_millis(120);

fn is_localhost(url: &reqwest::Url) -> bool {
  url.host_str().map(|host| host.trim_end_matches('.').eq_ignore_ascii_case("localhost")).unwrap_or(false)
}

fn is_loopback(url: &reqwest::Url) -> bool {
  is_localhost(url) || url.host_str().and_then(|host| {
    host.trim_start_matches('[').trim_end_matches(']').parse::<IpAddr>().ok()
  }).map(|ip| ip.is_loopback()).unwrap_or(false)
}

struct NativeHttpClient {
  primary: Client,
  localhost_v6: Option<Client>,
  loopback: bool,
  redirected: Arc<AtomicBool>,
}

#[derive(Debug)]
struct NativeRequestFailure {
  error: reqwest::Error,
  loopback: bool,
  redirected: bool,
  fallback: bool,
}

impl NativeRequestFailure {
  fn reason(&self) -> &'static str {
    network_reason(&self.error, self.loopback, self.fallback)
  }

  fn request_not_sent(&self) -> bool {
    !self.redirected && self.error.is_connect() && self.reason() == "NETWORK_REFUSED"
  }
}

impl NativeHttpClient {
  fn new(url: &reqwest::Url, headers: &HeaderMap, redirect: Option<&str>) -> Result<Self, reqwest::Error> {
    let loopback = is_loopback(url);
    // MCP's SDK uses manual redirects. Avoid applying the short timeout to
    // unrelated requests that may redirect from localhost to a remote host.
    let fast_loopback = loopback && matches!(redirect, Some("manual" | "error"));
    let redirected = Arc::new(AtomicBool::new(false));
    let build = |ip: Option<IpAddr>| {
      let redirect_policy = if matches!(redirect, Some("manual" | "error")) {
        reqwest::redirect::Policy::none()
      } else {
        let marker = redirected.clone();
        let limited = reqwest::redirect::Policy::limited(3);
        reqwest::redirect::Policy::custom(move |attempt| {
          if attempt.previous().len() < 3 { marker.store(true, Ordering::SeqCst); }
          limited.redirect(attempt)
        })
      };
      let mut builder = Client::builder()
        .default_headers(headers.clone())
        .redirect(redirect_policy)
        .connect_timeout(if fast_loopback { LOOPBACK_CONNECT_TIMEOUT } else { Duration::from_secs(3) });
      if let (Some(host), Some(ip)) = (url.host_str(), ip) {
        // Retain the localhost URL/Host/TLS name; only override its socket address.
        builder = builder.resolve(host, SocketAddr::new(ip, 0));
      }
      builder.build()
    };
    let localhost = is_localhost(url) && fast_loopback;
    let primary = build(if localhost { Some(Ipv4Addr::LOCALHOST.into()) } else { None })?;
    let localhost_v6 = if localhost { Some(build(Some(Ipv6Addr::LOCALHOST.into()))?) } else { None };
    Ok(Self { primary, localhost_v6, loopback, redirected })
  }

  async fn send(&self, method: &reqwest::Method, url: &reqwest::Url, body: &bytes::Bytes) -> Result<reqwest::Response, NativeRequestFailure> {
    let send = |client: &Client| {
      let request = client.request(method.clone(), url.clone());
      if *method == reqwest::Method::POST || *method == reqwest::Method::PUT || *method == reqwest::Method::PATCH {
        request.body(body.clone())
      } else {
        request
      }
    };
    match send(&self.primary).send().await {
      Ok(response) => Ok(response),
      Err(error) => {
        let redirected = self.redirected.load(Ordering::SeqCst);
        let failed_loopback = error.url().map(is_loopback).unwrap_or(self.loopback);
        let reason = network_reason(&error, failed_loopback, false);
        // This fallback is safe only when IPv4 never sent the request and no
        // earlier redirect could already have delivered it to a server.
        if !redirected && reason == "NETWORK_REFUSED" {
          if let Some(client) = &self.localhost_v6 {
            return send(client).send().await.map_err(|error| {
              let loopback = error.url().map(is_loopback).unwrap_or(self.loopback);
              NativeRequestFailure { error, loopback, redirected: self.redirected.load(Ordering::SeqCst), fallback: true }
            });
          }
        }
        Err(NativeRequestFailure { error, loopback: failed_loopback, redirected, fallback: false })
      }
    }
  }
}

#[tauri::command]
pub async fn stream_fetch(
  window: tauri::Window,
  state: tauri::State<'_, Arc<StreamState>>,
  cancel_id: String,
  method: String,
  url: String,
  headers: HashMap<String, String>,
  body: Vec<u8>,
  redirect: Option<String>,
) -> Result<StreamResponse, String> {

  let event_name = "stream-response";
  let request_id = REQUEST_COUNTER.fetch_add(1, Ordering::SeqCst);
  let stream_state = Arc::clone(state.inner());

  let mut _headers = HeaderMap::new();
  for (key, value) in &headers {
    let name = key.parse::<HeaderName>().map_err(|_| "Invalid request header name")?;
    let value = value.parse().map_err(|_| "Invalid request header value")?;
    _headers.insert(name, value);
  }

  // println!("method: {:?}", method);
  // println!("url: {:?}", url);
  // println!("headers: {:?}", headers);
  // println!("headers: {:?}", _headers);

  let method = method.parse::<reqwest::Method>().map_err(|err| format!("failed to parse method: {}", err))?;
  let url = url.parse::<reqwest::Url>().map_err(|err| format!("failed to parse url: {}", err))?;
  let client = NativeHttpClient::new(&url, &_headers, redirect.as_deref())
    .map_err(|err| format!("failed to generate client: {}", err))?;
  let body = bytes::Bytes::from(body);

  // println!("client: {:?}", client);
  // println!("request: {:?}", request);

  let cancel = stream_state.token(&cancel_id);
  let response_future = client.send(&method, &url, &body);

  let res = tokio::select! {
    _ = cancel.cancelled() => {
      stream_state.finish(&cancel_id);
      return Err("Request aborted".to_string());
    },
    result = response_future => result,
  };
  let response = match res {
    Ok(res) => {
      // get response and emit to client
      let mut headers = HashMap::new();
      for (name, value) in res.headers() {
        if let Ok(value) = value.to_str() {
          headers.insert(name.as_str().to_string(), value.to_string());
        }
      }
      let status = res.status().as_u16();
      let status_text = res.status().canonical_reason().unwrap_or("").to_string();

      tauri::async_runtime::spawn(async move {
        let mut body_failed = false;
        tokio::select! {
          _ = cancel.cancelled() => {},
          _ = async {
            let mut stream = res.bytes_stream();
            while let Some(chunk) = stream.next().await {
              match chunk {
                Ok(bytes) => {
                  if let Err(e) = window.emit(event_name, ChunkPayload{ request_id, chunk: bytes }) {
                    println!("Failed to emit chunk payload: {:?}", e);
                  }
                }
                Err(_) => {
                  body_failed = true;
                  break;
                },
              }
            }
          } => {},
        }
        stream_state.finish(&cancel_id);
        if !cancel.is_cancelled() {
          if let Err(e) = window.emit(event_name, EndPayload{ request_id, status: if body_failed { 1 } else { 0 } }) {
            println!("Failed to emit end payload: {:?}", e);
          }
        }
      });

      StreamResponse {
        request_id,
        status,
        status_text,
        headers,
        network_error: None,
        request_not_sent: None,
      }
    }
    Err(err) => {
      stream_state.finish(&cancel_id);
      let error = err.reason().to_string();
      let request_not_sent = err.request_not_sent();
      let network_error = error.clone();
      tauri::async_runtime::spawn( async move {
        if let Err(e) = window.emit(event_name, ChunkPayload{ request_id, chunk: error.into() }) {
          println!("Failed to emit chunk payload: {:?}", e);
        }
        if let Err(e) = window.emit(event_name, EndPayload{ request_id, status: 0 }) {
          println!("Failed to emit end payload: {:?}", e);
        }
      });
      StreamResponse {
        request_id,
        status: 599,
        status_text: "Error".to_string(),
        headers: HashMap::new(),
        network_error: Some(network_error),
        request_not_sent: Some(request_not_sent),
      }
    }
  };
  // println!("Response: {:?}", response);
  Ok(response)
}

fn network_reason(error: &reqwest::Error, loopback: bool, fallback: bool) -> &'static str {
  let details = format!("{error:?}").to_ascii_lowercase();
  classify_network_error(error.is_connect(), error.is_timeout(), &details, loopback, fallback)
}

fn classify_network_error(connect: bool, timeout: bool, details: &str, loopback: bool, fallback: bool) -> &'static str {
  let refused = details.contains("refused") || details.contains("10061");
  if loopback && connect &&
    (timeout || refused || (fallback && !details.contains("tls") && !details.contains("certificate") && !details.contains("dns"))) {
    "NETWORK_REFUSED"
  }
  else if timeout || details.contains("timed out") { "NETWORK_TIMEOUT" }
  // A refusal is safe to classify as pre-send only when reqwest also reports
  // a connection-stage failure. Separate metadata guards redirects.
  else if connect && refused { "NETWORK_REFUSED" }
  else if details.contains("dns") || details.contains("resolve") || details.contains("11001") { "NETWORK_DNS" }
  else if details.contains("certificate") || details.contains("tls") { "NETWORK_TLS" }
  else if connect { "NETWORK_CONNECT" }
  else { "NETWORK_FAILED" }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::io::{Read, Write};
  use std::net::TcpListener;
  use std::thread;

  fn listener(host: &str) -> TcpListener {
    TcpListener::bind((host, 0)).unwrap()
  }

  fn send_ok(server: TcpListener, delay: Duration) -> thread::JoinHandle<()> {
    thread::spawn(move || {
      let (mut socket, _) = server.accept().unwrap();
      socket.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
      let mut request = [0; 4096];
      assert!(socket.read(&mut request).unwrap() > 0);
      thread::sleep(delay);
      socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok").unwrap();
    })
  }

  fn test_client(url: &reqwest::Url) -> NativeHttpClient {
    NativeHttpClient::new(url, &HeaderMap::new(), Some("manual")).unwrap()
  }

  #[test]
  fn loopback_and_connection_error_classification_is_narrow() {
    for target in ["http://127.0.0.1/", "http://127.9.8.7/", "http://[::1]/", "http://localhost/"] {
      assert!(is_loopback(&target.parse().unwrap()), "{target}");
    }
    for target in ["http://128.0.0.1/", "http://[::2]/", "http://localhost.example/"] {
      assert!(!is_loopback(&target.parse().unwrap()), "{target}");
    }
    assert_eq!(classify_network_error(true, true, "timed out", true, false), "NETWORK_REFUSED");
    assert_eq!(classify_network_error(true, true, "timed out", false, false), "NETWORK_TIMEOUT");
    assert_eq!(classify_network_error(false, true, "timed out", true, false), "NETWORK_TIMEOUT");
    assert_eq!(classify_network_error(true, false, "connection refused", false, false), "NETWORK_REFUSED");
    assert_eq!(classify_network_error(true, false, "tls certificate", true, true), "NETWORK_TLS");
  }

  #[tokio::test]
  async fn closed_loopback_ports_fail_quickly_and_are_known_unsent() {
    let ipv4 = listener("127.0.0.1");
    let port = ipv4.local_addr().unwrap().port();
    drop(ipv4);
    for host in ["127.0.0.1", "localhost"] {
      let url: reqwest::Url = format!("http://{host}:{port}/mcp").parse().unwrap();
      let started = Instant::now();
      let client = test_client(&url);
      let failure = client.send(&reqwest::Method::POST, &url, &bytes::Bytes::from_static(b"{}"))
        .await.unwrap_err();
      let elapsed = started.elapsed();
      println!("closed {host}: {elapsed:?} ({})", failure.reason());
      assert!(failure.error.is_connect());
      assert_eq!(failure.reason(), "NETWORK_REFUSED");
      assert!(failure.request_not_sent());
      assert!(elapsed < Duration::from_millis(500), "{host}: {elapsed:?}");
    }
    if let Ok(ipv6) = TcpListener::bind((Ipv6Addr::LOCALHOST, 0)) {
      let port = ipv6.local_addr().unwrap().port();
      drop(ipv6);
      let url: reqwest::Url = format!("http://[::1]:{port}/mcp").parse().unwrap();
      let started = Instant::now();
      let client = test_client(&url);
      let failure = client.send(&reqwest::Method::GET, &url, &bytes::Bytes::new()).await.unwrap_err();
      let elapsed = started.elapsed();
      println!("closed ::1: {elapsed:?} ({})", failure.reason());
      assert!(failure.error.is_connect());
      assert_eq!(failure.reason(), "NETWORK_REFUSED");
      assert!(failure.request_not_sent());
      assert!(elapsed < Duration::from_millis(500), "::1: {elapsed:?}");
    }
  }

  #[tokio::test]
  async fn localhost_reaches_an_ipv4_only_listener_quickly() {
    let server = listener("127.0.0.1");
    let port = server.local_addr().unwrap().port();
    let worker = send_ok(server, Duration::ZERO);
    let url: reqwest::Url = format!("http://localhost:{port}/mcp").parse().unwrap();
    let started = Instant::now();
    let client = test_client(&url);
    let response = client.send(&reqwest::Method::GET, &url, &bytes::Bytes::new()).await.unwrap();
    let elapsed = started.elapsed();
    println!("localhost IPv4 listener: {elapsed:?}");
    assert_eq!(response.text().await.unwrap(), "ok");
    assert!(elapsed < Duration::from_millis(500), "{elapsed:?}");
    worker.join().unwrap();
  }

  #[tokio::test]
  async fn localhost_also_reaches_an_ipv6_only_listener() {
    if let Ok(server) = TcpListener::bind((Ipv6Addr::LOCALHOST, 0)) {
      let port = server.local_addr().unwrap().port();
      let worker = send_ok(server, Duration::ZERO);
      let url: reqwest::Url = format!("http://localhost:{port}/mcp").parse().unwrap();
      let started = Instant::now();
      let client = test_client(&url);
      let response = client.send(&reqwest::Method::GET, &url, &bytes::Bytes::new()).await.unwrap();
      let elapsed = started.elapsed();
      println!("localhost IPv6-only listener: {elapsed:?}");
      assert_eq!(response.text().await.unwrap(), "ok");
      assert!(elapsed < Duration::from_millis(500), "{elapsed:?}");
      worker.join().unwrap();
    } else {
      println!("IPv6 loopback unavailable; IPv6-only listener test skipped");
    }
  }

  #[tokio::test]
  async fn slow_response_after_connection_is_not_a_connect_timeout() {
    let server = listener("127.0.0.1");
    let port = server.local_addr().unwrap().port();
    let worker = send_ok(server, Duration::from_millis(300));
    let url: reqwest::Url = format!("http://127.0.0.1:{port}/mcp").parse().unwrap();
    let client = test_client(&url);
    let response = client.send(&reqwest::Method::GET, &url, &bytes::Bytes::new()).await.unwrap();
    assert_eq!(response.text().await.unwrap(), "ok");
    worker.join().unwrap();
  }

  #[tokio::test]
  async fn a_refusal_after_redirect_is_not_proof_the_request_was_unsent() {
    let unavailable = listener("127.0.0.1");
    let unavailable_port = unavailable.local_addr().unwrap().port();
    drop(unavailable);
    let server = listener("127.0.0.1");
    let port = server.local_addr().unwrap().port();
    let worker = thread::spawn(move || {
      let (mut socket, _) = server.accept().unwrap();
      let mut request = [0; 4096];
      assert!(socket.read(&mut request).unwrap() > 0);
      write!(socket, "HTTP/1.1 307 Temporary Redirect\r\nLocation: http://127.0.0.1:{unavailable_port}/mcp\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
    });
    let url: reqwest::Url = format!("http://localhost:{port}/mcp").parse().unwrap();
    let client = NativeHttpClient::new(&url, &HeaderMap::new(), Some("follow")).unwrap();
    let failure = client.send(&reqwest::Method::POST, &url, &bytes::Bytes::from_static(b"{}"))
      .await.unwrap_err();
    assert!(failure.redirected);
    assert!(!failure.fallback);
    assert!(!failure.request_not_sent());
    worker.join().unwrap();
  }

  #[test]
  fn cancellation_is_scoped_and_can_arrive_before_registration() {
    let state = StreamState::default();
    let first = state.token("first");
    let second = state.token("second");
    state.token("first").cancel();
    assert!(first.is_cancelled());
    assert!(!second.is_cancelled());

    state.token("early").cancel();
    assert!(state.token("early").is_cancelled());
    state.finish("early");
    assert!(!state.token("early").is_cancelled());
  }

  #[tokio::test]
  async fn post_send_disconnect_is_not_marked_as_connection_refused() {
    let server = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = server.local_addr().unwrap().port();
    let worker = thread::spawn(move || {
      let (mut socket, _) = server.accept().unwrap();
      let mut request = [0; 4096];
      assert!(socket.read(&mut request).unwrap() > 0);
      // The request was already received; close without a response.
    });
    let result = Client::new().post(format!("http://127.0.0.1:{port}/refused"))
      .body("synthetic").send().await.unwrap_err();
    worker.join().unwrap();
    assert!(!result.is_connect());
    assert_ne!(network_reason(&result, true, false), "NETWORK_REFUSED");
  }
}

