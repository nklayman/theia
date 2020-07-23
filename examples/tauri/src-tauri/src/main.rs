#![cfg_attr(
  all(not(debug_assertions), target_os = "windows"),
  windows_subsystem = "windows"
)]

use std::{
  io::{BufRead, BufReader},
  process::{Command, Stdio},
};
use tauri::WebviewMut;

fn main() {
  let mut started = false;
  tauri::AppBuilder::new()
    .setup(move |_webview, _arg| {
      if !started {
        started = true;
        // Spawn Theia server in new thread
        let mut handle_clone = _webview.as_mut();
        std::thread::spawn(move || {
          spawn_theia_server(&mut handle_clone);
        });
      }
    })
    .build()
    .run();
}

// Takes the name of the binary and returns the full path to its location
fn get_bin_command(name: &str) -> String {
  tauri::api::command::command_path(tauri::api::command::binary_command(name.to_string()).unwrap())
    .unwrap()
}

// Spawns Theia server and loads url in webview
fn spawn_theia_server(handle: &mut WebviewMut) {
  println!("running");
  // Get paths to orchestrator and main binary
  let theia_binary = get_bin_command("theia");
  let orchestrator_binary = get_bin_command("theia-orchestrator");

  // Get stdout from binary
  println!("orchestator binary: {}", orchestrator_binary);
  let stdout = Command::new(orchestrator_binary)
    .args(vec!["run", theia_binary.as_str()])
    .env("VSCODE_RIPGREP_PATH", get_bin_command("rg"))
    .stdout(Stdio::piped())
    .spawn()
    .expect("Failed to start theia server")
    .stdout
    .expect("Failed to get theia server stdout");

  // Read stdout
  let reader = BufReader::new(stdout);
  let mut webview_started = false;
  reader
    .lines()
    .filter_map(|line| line.ok())
    // Check if binary has printed the url to the console
    .for_each(|line| {
      if line.starts_with("root INFO Theia app listening on ") {
        // Extract url from stdout line
        let url = line
          .replace("root INFO Theia app listening on ", "")
          .replace(".", "");
        // If the webview hasn't started yet, load the url of the server
        println!("Loading, started: {}", webview_started);
        if !webview_started {
          webview_started = true;
          handle
            .dispatch(move |webview| webview.eval(&format!("window.location.replace('{}')", url)))
            .expect("failed to initialize app");
        }
      }
    });
}
