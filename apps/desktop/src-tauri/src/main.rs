use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use tauri::{AppHandle, Manager, RunEvent};

#[derive(Default)]
struct LocalRuntime {
    children: Mutex<Vec<Child>>,
}

impl LocalRuntime {
    fn start_bundled(&self, app: &AppHandle) -> Result<(), String> {
        let runtime = bundled_runtime_dir(app)?
            .ok_or_else(|| "standalone runtime is missing from the installed app".to_string())?;
        let node = runtime.join("node.exe");
        let api = runtime.join("api").join("dist").join("server.js");
        let worker = runtime.join("worker").join("dist").join("worker.js");
        let bundled_env = runtime.join(".env");

        if !node.is_file() || !api.is_file() || !worker.is_file() || !bundled_env.is_file() {
            return Err(format!(
                "standalone runtime is incomplete under {}",
                runtime.display()
            ));
        }

        let app_data_dir = app
            .path()
            .app_data_dir()
            .map_err(|error| format!("failed to resolve application data directory: {error}"))?;
        fs::create_dir_all(&app_data_dir)
            .map_err(|error| format!("failed to create application data directory: {error}"))?;
        let user_env = app_data_dir.join(".env");
        if !user_env.is_file() {
            fs::copy(&bundled_env, &user_env).map_err(|error| {
                format!("failed to initialize application configuration: {error}")
            })?;
        }

        self.spawn_node(&runtime, &node, &api, &user_env, &app_data_dir, "api")?;
        self.spawn_node(&runtime, &node, &worker, &user_env, &app_data_dir, "worker")?;
        wait_for_local_api()?;
        Ok(())
    }

    fn start_workspace(&self, root: &Path) -> Result<(), String> {
        let mut children = self
            .children
            .lock()
            .map_err(|_| "local runtime lock poisoned")?;
        for script in ["dev:api", "dev:worker"] {
            let mut command = Command::new(pnpm_command());
            command.args(["--dir", root.to_string_lossy().as_ref(), script]);
            configure_command(&mut command);
            let child = command
                .spawn()
                .map_err(|error| format!("failed to start {script}: {error}"))?;
            children.push(child);
        }
        Ok(())
    }

    fn spawn_node(
        &self,
        runtime: &Path,
        node: &Path,
        entrypoint: &Path,
        env_file: &Path,
        log_directory: &Path,
        service: &str,
    ) -> Result<(), String> {
        let stdout = OpenOptions::new()
            .create(true)
            .append(true)
            .open(log_directory.join(format!("{service}.stdout.log")))
            .map_err(|error| format!("failed to open bundled {service} stdout log: {error}"))?;
        let stderr = OpenOptions::new()
            .create(true)
            .append(true)
            .open(log_directory.join(format!("{service}.stderr.log")))
            .map_err(|error| format!("failed to open bundled {service} stderr log: {error}"))?;
        let entrypoint_argument = entrypoint.strip_prefix(runtime).unwrap_or(entrypoint);
        let mut command = Command::new(node);
        command
            .arg(entrypoint_argument)
            .current_dir(runtime)
            .env("NODE_ENV", "production")
            .env("PERSONAL_AI_ENV_FILE", env_file)
            .env("API_HOST", "127.0.0.1")
            .env("API_PORT", "3000")
            .stdout(Stdio::from(stdout))
            .stderr(Stdio::from(stderr));
        configure_command(&mut command);
        let child = command
            .spawn()
            .map_err(|error| format!("failed to start bundled {service}: {error}"))?;
        self.children
            .lock()
            .map_err(|_| "local runtime lock poisoned")?
            .push(child);
        Ok(())
    }

    fn stop(&self) {
        let Ok(mut children) = self.children.lock() else {
            return;
        };
        for child in children.drain(..) {
            stop_process_tree(child);
        }
    }
}

fn wait_for_local_api() -> Result<(), String> {
    let address: SocketAddr = "127.0.0.1:3000"
        .parse()
        .map_err(|error| format!("invalid bundled API address: {error}"))?;
    let mut last_error = "API did not accept a connection".to_string();

    for _ in 0..50 {
        match TcpStream::connect_timeout(&address, Duration::from_millis(250)) {
            Ok(mut stream) => {
                let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
                let _ = stream.set_write_timeout(Some(Duration::from_millis(500)));
                let request =
                    b"GET /health HTTP/1.1\r\nHost: 127.0.0.1:3000\r\nConnection: close\r\n\r\n";
                if let Err(error) = stream.write_all(request) {
                    last_error = format!("failed to query bundled API health: {error}");
                } else {
                    let mut response = String::new();
                    match stream.read_to_string(&mut response) {
                        Ok(_) if response.contains("\"status\":\"ok\"") => return Ok(()),
                        Ok(_) => {
                            last_error =
                                "bundled API returned an unexpected health response".to_string()
                        }
                        Err(error) => {
                            last_error = format!("failed to read bundled API health: {error}")
                        }
                    }
                }
            }
            Err(error) => last_error = format!("bundled API is not ready: {error}"),
        }
        thread::sleep(Duration::from_millis(200));
    }

    Err(format!("bundled API did not become healthy: {last_error}"))
}

fn workspace_root() -> Option<PathBuf> {
    let executable = std::env::current_exe().ok()?;
    executable
        .ancestors()
        .find(|path| path.join("pnpm-workspace.yaml").is_file() && path.join(".env").is_file())
        .map(Path::to_path_buf)
}

fn bundled_runtime_dir(app: &AppHandle) -> Result<Option<PathBuf>, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| format!("failed to resolve application resources: {error}"))?;
    let mut candidates = vec![
        resource_dir.join("runtime"),
        resource_dir.join("resources").join("runtime"),
    ];
    if let Ok(executable) = std::env::current_exe() {
        if let Some(parent) = executable.parent() {
            candidates.push(parent.join("runtime"));
            candidates.push(parent.join("resources").join("runtime"));
        }
    }
    Ok(candidates.into_iter().find(|runtime| {
        runtime.join("node.exe").is_file()
            && runtime.join("api").join("dist").join("server.js").is_file()
            && runtime
                .join("worker")
                .join("dist")
                .join("worker.js")
                .is_file()
    }))
}

#[cfg(windows)]
fn pnpm_command() -> &'static str {
    "pnpm.cmd"
}

#[cfg(not(windows))]
fn pnpm_command() -> &'static str {
    "pnpm"
}

#[cfg(windows)]
fn configure_command(command: &mut Command) {
    std::os::windows::process::CommandExt::creation_flags(command, 0x08000000);
}

#[cfg(not(windows))]
fn configure_command(_command: &mut Command) {}

fn stop_process_tree(mut child: Child) {
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .status();
    }
    #[cfg(not(windows))]
    {
        let _ = child.kill();
    }
    let _ = child.wait();
}

fn main() {
    let app = tauri::Builder::default()
        .manage(LocalRuntime::default())
        .setup(|app| {
            if !cfg!(debug_assertions) {
                let app_handle = app.handle();
                let bundled_runtime_available = bundled_runtime_dir(app_handle)
                    .map_err(std::io::Error::other)?
                    .is_some();
                if bundled_runtime_available {
                    app.state::<LocalRuntime>()
                        .start_bundled(app_handle)
                        .map_err(std::io::Error::other)?;
                } else if let Some(root) = workspace_root() {
                    // Keep source-tree launches usable while developing. Installed
                    // releases take the bundled branch above and do not need pnpm.
                    app.state::<LocalRuntime>()
                        .start_workspace(&root)
                        .map_err(std::io::Error::other)?;
                } else {
                    return Err(Box::new(std::io::Error::other(
                        "standalone runtime is missing; rebuild the desktop installer",
                    )));
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to run Personal AI Assistant desktop shell");
    app.run(|app, event| {
        if matches!(event, RunEvent::Exit) {
            app.state::<LocalRuntime>().stop();
        }
    });
}
