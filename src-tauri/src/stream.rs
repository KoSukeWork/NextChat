//
//

use std::time::Duration;
use std::time::Instant;
use std::error::Error;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::collections::HashMap;
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
  headers: HashMap<String, String>
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

#[tauri::command]
pub async fn stream_fetch(
  window: tauri::Window,
  state: tauri::State<'_, Arc<StreamState>>,
  cancel_id: String,
  method: String,
  url: String,
  headers: HashMap<String, String>,
  body: Vec<u8>,
) -> Result<StreamResponse, String> {

  let event_name = "stream-response";
  let request_id = REQUEST_COUNTER.fetch_add(1, Ordering::SeqCst);
  let stream_state = Arc::clone(state.inner());

  let mut _headers = HeaderMap::new();
  for (key, value) in &headers {
    _headers.insert(key.parse::<HeaderName>().unwrap(), value.parse().unwrap());
  }

  // println!("method: {:?}", method);
  // println!("url: {:?}", url);
  // println!("headers: {:?}", headers);
  // println!("headers: {:?}", _headers);

  let method = method.parse::<reqwest::Method>().map_err(|err| format!("failed to parse method: {}", err))?;
  let client = Client::builder()
    .default_headers(_headers)
    .redirect(reqwest::redirect::Policy::limited(3))
    .connect_timeout(Duration::new(3, 0))
    .build()
    .map_err(|err| format!("failed to generate client: {}", err))?;

  let mut request = client.request(
    method.clone(),
    url.parse::<reqwest::Url>().map_err(|err| format!("failed to parse url: {}", err))?
  );

  if method == reqwest::Method::POST || method == reqwest::Method::PUT || method == reqwest::Method::PATCH {
    let body = bytes::Bytes::from(body);
    // println!("body: {:?}", body);
    request = request.body(body);
  }

  // println!("client: {:?}", client);
  // println!("request: {:?}", request);

  let cancel = stream_state.token(&cancel_id);
  let response_future = request.send();

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
        headers.insert(
          name.as_str().to_string(),
          std::str::from_utf8(value.as_bytes()).unwrap().to_string()
        );
      }
      let status = res.status().as_u16();

      tauri::async_runtime::spawn(async move {
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
                Err(err) => {
                  println!("Error chunk: {:?}", err);
                }
              }
            }
          } => {},
        }
        stream_state.finish(&cancel_id);
        if !cancel.is_cancelled() {
          if let Err(e) = window.emit(event_name, EndPayload{ request_id, status: 0 }) {
            println!("Failed to emit end payload: {:?}", e);
          }
        }
      });

      StreamResponse {
        request_id,
        status,
        status_text: "OK".to_string(),
        headers,
      }
    }
    Err(err) => {
      stream_state.finish(&cancel_id);
      let error: String = err.source()
        .map(|e| e.to_string())
        .unwrap_or_else(|| "Unknown error occurred".to_string());
      println!("Error response: {:?}", error);
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
      }
    }
  };
  // println!("Response: {:?}", response);
  Ok(response)
}

#[cfg(test)]
mod tests {
  use super::*;

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
}

