#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use std::thread;
use std::time::Duration;

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, RunEvent, WindowEvent,
};
use tauri_plugin_autostart::ManagerExt;

const MAIN_WINDOW_LABEL: &str = "main";
const START_HIDDEN_ARGUMENT: &str = "--minimized";

#[derive(Default)]
struct AppLifecycle {
    quit_requested: AtomicBool,
}

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
        let bundled_env_template = runtime.join(".env.example");

        if !node.is_file() || !api.is_file() || !worker.is_file() || !bundled_env_template.is_file()
        {
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
            fs::copy(&bundled_env_template, &user_env).map_err(|error| {
                format!("failed to initialize application configuration: {error}")
            })?;
            return Err(format!(
                "application configuration was created at {}; fill in the local database settings and restart",
                user_env.display()
            ));
        }
        let configuration = fs::read_to_string(&user_env)
            .map_err(|error| format!("failed to read application configuration: {error}"))?;
        if configuration.contains("replace-with-url-encoded-password") {
            return Err(format!(
                "application configuration at {} still contains placeholders; fill in the local database settings and restart",
                user_env.display()
            ));
        }

        // A previous release accidentally exposed the desktop process's console.
        // If that console was closed, its API and worker children could survive and
        // occupy the local API port. Reap only orphaned children from this exact
        // bundled runtime; never touch a source-tree API or another application.
        recover_orphaned_bundled_runtime(&node);

        if local_api_port_is_in_use()? {
            return Err(
                "local API port 127.0.0.1:3000 is already in use; close the source API or another running desktop instance before starting the installed application"
                    .to_string(),
            );
        }

        let mut api_child =
            self.spawn_node(&runtime, &node, &api, &user_env, &app_data_dir, "api")?;
        if let Err(error) = wait_for_local_api(&mut api_child) {
            stop_process_tree(api_child);
            return Err(error);
        }

        let mut worker_child =
            match self.spawn_node(&runtime, &node, &worker, &user_env, &app_data_dir, "worker") {
                Ok(child) => child,
                Err(error) => {
                    stop_process_tree(api_child);
                    return Err(error);
                }
            };
        thread::sleep(Duration::from_millis(300));
        match worker_child.try_wait() {
            Ok(Some(status)) => {
                stop_process_tree(api_child);
                return Err(format!(
                    "bundled worker exited during startup with status {status}; inspect worker.stderr.log"
                ));
            }
            Ok(None) => {}
            Err(error) => {
                stop_process_tree(api_child);
                stop_process_tree(worker_child);
                return Err(format!("failed to inspect bundled worker process: {error}"));
            }
        }

        let mut children = match self.children.lock() {
            Ok(children) => children,
            Err(_) => {
                stop_process_tree(api_child);
                stop_process_tree(worker_child);
                return Err("local runtime lock poisoned".to_string());
            }
        };
        children.push(api_child);
        children.push(worker_child);
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
    ) -> Result<Child, String> {
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
        command
            .spawn()
            .map_err(|error| format!("failed to start bundled {service}: {error}"))
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

fn local_api_address() -> Result<SocketAddr, String> {
    "127.0.0.1:3000"
        .parse()
        .map_err(|error| format!("invalid bundled API address: {error}"))
}

fn local_api_port_is_in_use() -> Result<bool, String> {
    let address = local_api_address()?;
    Ok(TcpStream::connect_timeout(&address, Duration::from_millis(250)).is_ok())
}

fn wait_for_local_api(api_child: &mut Child) -> Result<(), String> {
    let address = local_api_address()?;
    let mut last_error = "API did not accept a connection".to_string();

    for _ in 0..50 {
        if let Some(status) = api_child
            .try_wait()
            .map_err(|error| format!("failed to inspect bundled API process: {error}"))?
        {
            return Err(format!(
                "bundled API exited during startup with status {status}; inspect api.stderr.log"
            ));
        }
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

#[cfg(windows)]
fn recover_orphaned_bundled_runtime(node: &Path) {
    let Ok(recovered) = reap_orphaned_bundled_nodes(node) else {
        return;
    };
    if recovered == 0 {
        return;
    }

    // Give Windows a brief moment to release port 3000 before the normal guard
    // checks it. This only follows termination of this app's own orphaned nodes.
    for _ in 0..10 {
        if !local_api_port_is_in_use().unwrap_or(true) {
            break;
        }
        thread::sleep(Duration::from_millis(100));
    }
}

#[cfg(not(windows))]
fn recover_orphaned_bundled_runtime(_node: &Path) {}

#[cfg(windows)]
fn reap_orphaned_bundled_nodes(node: &Path) -> Result<usize, String> {
    use std::mem::zeroed;
    use windows_sys::Win32::{
        Foundation::{CloseHandle, INVALID_HANDLE_VALUE},
        System::{
            Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
                TH32CS_SNAPPROCESS,
            },
            Threading::{
                OpenProcess, QueryFullProcessImageNameW, TerminateProcess,
                PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE,
            },
        },
    };

    let expected_node = fs::canonicalize(node)
        .unwrap_or_else(|_| node.to_path_buf())
        .to_string_lossy()
        .to_string();
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err("failed to inspect local runtime processes".to_string());
    }

    let mut entries = Vec::new();
    let mut entry: PROCESSENTRY32W = unsafe { zeroed() };
    entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
    let mut has_entry = unsafe { Process32FirstW(snapshot, &mut entry) } != 0;
    while has_entry {
        entries.push((entry.th32ProcessID, entry.th32ParentProcessID));
        entry = unsafe { zeroed() };
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        has_entry = unsafe { Process32NextW(snapshot, &mut entry) } != 0;
    }
    unsafe {
        CloseHandle(snapshot);
    }

    let mut recovered = 0;
    for (process_id, parent_process_id) in entries {
        if process_id == 0 || process_exists(parent_process_id) {
            continue;
        }
        let Some(path) = process_image_path(process_id) else {
            continue;
        };
        if !path.eq_ignore_ascii_case(&expected_node) {
            continue;
        }

        let process = unsafe { OpenProcess(PROCESS_TERMINATE, 0, process_id) };
        if process.is_null() {
            continue;
        }
        let stopped = unsafe { TerminateProcess(process, 0) } != 0;
        unsafe {
            CloseHandle(process);
        }
        if stopped {
            recovered += 1;
        }
    }
    fn process_exists(process_id: u32) -> bool {
        if process_id == 0 {
            return false;
        }
        let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, process_id) };
        if process.is_null() {
            return false;
        }
        unsafe {
            CloseHandle(process);
        }
        true
    }

    fn process_image_path(process_id: u32) -> Option<String> {
        let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, process_id) };
        if process.is_null() {
            return None;
        }
        let mut buffer = [0_u16; 32_768];
        let mut length = buffer.len() as u32;
        let queried =
            unsafe { QueryFullProcessImageNameW(process, 0, buffer.as_mut_ptr(), &mut length) }
                != 0;
        unsafe {
            CloseHandle(process);
        }
        queried.then(|| String::from_utf16_lossy(&buffer[..length as usize]))
    }

    Ok(recovered)
}

fn stop_process_tree(mut child: Child) {
    #[cfg(windows)]
    {
        let mut command = Command::new("taskkill");
        command
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        configure_command(&mut command);
        let _ = command.status();
    }
    #[cfg(not(windows))]
    {
        let _ = child.kill();
    }
    let _ = child.wait();
}

fn show_main_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        return;
    };
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}

fn install_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "打开主界面", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出个人 AI 助理", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;
    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| tauri::Error::AssetNotFound("default window icon".into()))?;

    TrayIconBuilder::with_id("personal-ai-tray")
        .icon(icon)
        .tooltip("个人 AI 助理")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main_window(app),
            "quit" => {
                app.state::<AppLifecycle>()
                    .quit_requested
                    .store(true, Ordering::SeqCst);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

fn should_start_hidden() -> bool {
    std::env::args_os().any(|argument| argument == START_HIDDEN_ARGUMENT)
}

fn main() {
    let app = tauri::Builder::default()
        .manage(LocalRuntime::default())
        .manage(AppLifecycle::default())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }))
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .args([START_HIDDEN_ARGUMENT])
                .build(),
        )
        .setup(|app| {
            install_tray(app.handle())?;
            if !cfg!(debug_assertions) {
                if let Err(error) = app.autolaunch().enable() {
                    eprintln!("failed to enable Windows login startup: {error}");
                }
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
            if should_start_hidden() {
                if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
                    window.hide()?;
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to run Personal AI Assistant desktop shell");
    app.run(|app, event| match event {
        RunEvent::WindowEvent {
            label,
            event: WindowEvent::CloseRequested { api, .. },
            ..
        } if label == MAIN_WINDOW_LABEL => {
            let quit_requested = app
                .state::<AppLifecycle>()
                .quit_requested
                .load(Ordering::SeqCst);
            if !quit_requested {
                api.prevent_close();
                if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
                    let _ = window.hide();
                }
            }
        }
        RunEvent::Exit => app.state::<LocalRuntime>().stop(),
        _ => {}
    });
}
