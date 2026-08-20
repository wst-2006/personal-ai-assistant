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
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Manager, RunEvent, WindowEvent};

#[cfg(windows)]
use windows::Devices::Geolocation::{GeolocationAccessStatus, Geolocator, PositionAccuracy};

mod focus_companion;

const MAIN_WINDOW_LABEL: &str = "main";
const START_HIDDEN_ARGUMENT: &str = "--minimized";
const CLEANUP_INSTALLED_RUNTIME_ARGUMENT: &str = "--cleanup-installed-runtime";

#[derive(Default)]
pub(crate) struct AppLifecycle {
    pub(crate) quit_requested: AtomicBool,
}

struct ManagedChild {
    service: &'static str,
    child: Child,
}

#[derive(Clone)]
struct BundledLaunch {
    runtime: PathBuf,
    node: PathBuf,
    api: PathBuf,
    worker: PathBuf,
    user_env: PathBuf,
    log_directory: PathBuf,
}

#[derive(Default)]
struct LocalRuntime {
    children: Mutex<Vec<ManagedChild>>,
    bundled_launch: Mutex<Option<BundledLaunch>>,
    monitor_started: AtomicBool,
    stopping: AtomicBool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DeviceCoordinates {
    latitude: f64,
    longitude: f64,
}

#[tauri::command]
fn device_location() -> Result<DeviceCoordinates, String> {
    #[cfg(windows)]
    {
        let access = Geolocator::RequestAccessAsync()
            .map_err(|error| format!("location_access_request_failed: {error}"))?
            .get()
            .map_err(|error| format!("location_access_request_failed: {error}"))?;
        if access != GeolocationAccessStatus::Allowed {
            return Err("location_permission_denied".to_string());
        }

        let locator = Geolocator::new()
            .map_err(|error| format!("location_service_unavailable: {error}"))?;
        locator
            .SetDesiredAccuracy(PositionAccuracy::Default)
            .map_err(|error| format!("location_accuracy_failed: {error}"))?;
        let point = locator
            .GetGeopositionAsync()
            .map_err(|error| format!("location_request_failed: {error}"))?
            .get()
            .map_err(|error| format!("location_request_failed: {error}"))?
            .Coordinate()
            .and_then(|coordinate| coordinate.Point())
            .and_then(|point| point.Position())
            .map_err(|error| format!("location_coordinates_failed: {error}"))?;
        return Ok(DeviceCoordinates {
            latitude: point.Latitude,
            longitude: point.Longitude,
        });
    }

    #[cfg(not(windows))]
    Err("native_location_not_supported".to_string())
}

impl LocalRuntime {
    fn start_bundled(&self, app: &AppHandle) -> Result<(), String> {
        self.stopping.store(false, Ordering::SeqCst);
        let runtime = bundled_runtime_dir(app)?
            .ok_or_else(|| "standalone runtime is missing from the installed app".to_string())?;
        let node = runtime.join("node.exe");
        let api = runtime.join("api").join("dist").join("server.js");
        let worker = runtime.join("worker").join("dist").join("worker.js");
        let migration = runtime
            .join("api")
            .join("node_modules")
            .join("@personal-ai")
            .join("db")
            .join("dist")
            .join("migrate.js");
        let migration_journal = runtime
            .join("api")
            .join("node_modules")
            .join("@personal-ai")
            .join("db")
            .join("drizzle")
            .join("meta")
            .join("_journal.json");
        let bundled_env_template = runtime.join(".env.example");

        if !node.is_file()
            || !api.is_file()
            || !worker.is_file()
            || !migration.is_file()
            || !migration_journal.is_file()
            || !bundled_env_template.is_file()
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

        run_bundled_migrations(&runtime, &node, &migration, &user_env, &app_data_dir)?;

        let launch = BundledLaunch {
            runtime: runtime.clone(),
            node: node.clone(),
            api: api.clone(),
            worker: worker.clone(),
            user_env: user_env.clone(),
            log_directory: app_data_dir.clone(),
        };
        *self
            .bundled_launch
            .lock()
            .map_err(|_| "local runtime launch lock poisoned")? = Some(launch);

        let mut api_child =
            match self.spawn_node(&runtime, &node, &api, &user_env, &app_data_dir, "api") {
                Ok(child) => child,
                Err(error) => {
                    self.start_monitor(app);
                    return Err(error);
                }
            };
        if let Err(error) = wait_for_local_api(&mut api_child) {
            stop_process_tree(api_child);
            self.start_monitor(app);
            return Err(error);
        }

        let mut worker_child =
            match self.spawn_node(&runtime, &node, &worker, &user_env, &app_data_dir, "worker") {
                Ok(child) => child,
                Err(error) => {
                    stop_process_tree(api_child);
                    self.start_monitor(app);
                    return Err(error);
                }
            };
        thread::sleep(Duration::from_millis(300));
        match worker_child.try_wait() {
            Ok(Some(status)) => {
                stop_process_tree(api_child);
                self.start_monitor(app);
                return Err(format!(
                    "bundled worker exited during startup with status {status}; inspect worker.stderr.log"
                ));
            }
            Ok(None) => {}
            Err(error) => {
                stop_process_tree(api_child);
                stop_process_tree(worker_child);
                self.start_monitor(app);
                return Err(format!("failed to inspect bundled worker process: {error}"));
            }
        }

        let mut children = match self.children.lock() {
            Ok(children) => children,
            Err(_) => {
                stop_process_tree(api_child);
                stop_process_tree(worker_child);
                self.start_monitor(app);
                return Err("local runtime lock poisoned".to_string());
            }
        };
        children.push(ManagedChild {
            service: "api",
            child: api_child,
        });
        children.push(ManagedChild {
            service: "worker",
            child: worker_child,
        });
        drop(children);

        self.start_monitor(app);
        Ok(())
    }

    fn has_retryable_bundled_launch(&self) -> bool {
        self.bundled_launch
            .lock()
            .map(|launch| launch.is_some())
            .unwrap_or(false)
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
            children.push(ManagedChild {
                service: "workspace",
                child,
            });
        }
        Ok(())
    }

    fn start_monitor(&self, app: &AppHandle) {
        if self.monitor_started.swap(true, Ordering::SeqCst) {
            return;
        }
        let app = app.clone();
        thread::spawn(move || {
            let mut pending_restarts: Vec<&'static str> = Vec::new();
            loop {
                thread::sleep(Duration::from_secs(2));
                let runtime = app.state::<LocalRuntime>();
                if runtime.stopping.load(Ordering::SeqCst) {
                    break;
                }

                let mut stopped_services = Vec::new();
                let mut running_services = Vec::new();
                if let Ok(mut children) = runtime.children.lock() {
                    let mut index = 0;
                    while index < children.len() {
                        match children[index].child.try_wait() {
                            Ok(Some(status)) => {
                                let service = children[index].service;
                                stopped_services
                                    .push((service, format!("exited with status {status}")));
                                children.remove(index);
                            }
                            Ok(None) => {
                                running_services.push(children[index].service);
                                index += 1;
                            }
                            Err(error) => {
                                let service = children[index].service;
                                stopped_services
                                    .push((service, format!("could not be inspected: {error}")));
                                children.remove(index);
                            }
                        }
                    }
                }

                let launch = runtime
                    .bundled_launch
                    .lock()
                    .ok()
                    .and_then(|launch| launch.clone());
                let Some(launch) = launch else {
                    continue;
                };
                for (service, reason) in stopped_services {
                    append_desktop_log(
                        &launch.log_directory,
                        &format!("bundled {service} {reason}; scheduling restart"),
                    );
                    if !pending_restarts.contains(&service) {
                        pending_restarts.push(service);
                    }
                }
                for service in ["api", "worker"] {
                    if !running_services.contains(&service) && !pending_restarts.contains(&service)
                    {
                        pending_restarts.push(service);
                        append_desktop_log(
                            &launch.log_directory,
                            &format!("bundled {service} is missing; scheduling restart"),
                        );
                    }
                }

                for service in pending_restarts.clone() {
                    if runtime.stopping.load(Ordering::SeqCst) {
                        break;
                    }
                    match runtime.restart_bundled_service(&launch, service) {
                        Ok(()) => pending_restarts.retain(|pending| *pending != service),
                        Err(error) => append_desktop_log(
                            &launch.log_directory,
                            &format!("bundled {service} restart failed; will retry: {error}"),
                        ),
                    }
                }
            }
        });
    }

    fn restart_bundled_service(
        &self,
        launch: &BundledLaunch,
        service: &'static str,
    ) -> Result<(), String> {
        let entrypoint = match service {
            "api" => &launch.api,
            "worker" => &launch.worker,
            _ => return Err(format!("unsupported bundled service: {service}")),
        };
        let mut child = self.spawn_node(
            &launch.runtime,
            &launch.node,
            entrypoint,
            &launch.user_env,
            &launch.log_directory,
            service,
        )?;
        if service == "api" {
            if let Err(error) = wait_for_local_api(&mut child) {
                stop_process_tree(child);
                return Err(error);
            }
        } else {
            thread::sleep(Duration::from_millis(800));
            if let Some(status) = child
                .try_wait()
                .map_err(|error| format!("failed to inspect bundled worker process: {error}"))?
            {
                return Err(format!(
                    "bundled worker exited during restart with status {status}"
                ));
            }
        }

        self.children
            .lock()
            .map_err(|_| "local runtime lock poisoned")?
            .push(ManagedChild { service, child });
        append_desktop_log(
            &launch.log_directory,
            &format!("bundled {service} restarted successfully"),
        );
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
        let stdout_path = log_directory.join(format!("{service}.stdout.log"));
        let stderr_path = log_directory.join(format!("{service}.stderr.log"));
        rotate_log_if_needed(&stdout_path);
        rotate_log_if_needed(&stderr_path);
        let stdout = OpenOptions::new()
            .create(true)
            .append(true)
            .open(stdout_path)
            .map_err(|error| format!("failed to open bundled {service} stdout log: {error}"))?;
        let stderr = OpenOptions::new()
            .create(true)
            .append(true)
            .open(stderr_path)
            .map_err(|error| format!("failed to open bundled {service} stderr log: {error}"))?;
        let entrypoint_argument = node_entrypoint_argument(runtime, entrypoint);
        let mut command = Command::new(node);
        command
            .arg(&entrypoint_argument)
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
        self.stopping.store(true, Ordering::SeqCst);
        let Ok(mut children) = self.children.lock() else {
            return;
        };
        for managed in children.drain(..) {
            stop_process_tree(managed.child);
        }
    }
}

fn node_entrypoint_argument(runtime: &Path, entrypoint: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        // Tauri can expose resource paths with the Windows extended-path prefix.
        // Normalize that prefix before making the script path relative; otherwise
        // Node may receive only the drive marker (for example, `C:`) as argv[1].
        let runtime_text = normalize_windows_path_text(&runtime.to_string_lossy());
        let entrypoint_text = normalize_windows_path_text(&entrypoint.to_string_lossy());
        let runtime_path = Path::new(&runtime_text);
        let entrypoint_path = Path::new(&entrypoint_text);
        if let Ok(relative) = entrypoint_path.strip_prefix(runtime_path) {
            let mut relative_path = PathBuf::from(".");
            relative_path.push(relative);
            return relative_path;
        }
        return PathBuf::from(entrypoint_text);
    }

    #[cfg(not(windows))]
    {
        entrypoint
            .strip_prefix(runtime)
            .map(|relative| {
                let mut relative_path = PathBuf::from(".");
                relative_path.push(relative);
                relative_path
            })
            .unwrap_or_else(|_| entrypoint.to_path_buf())
    }
}

fn append_desktop_log(directory: &Path, message: &str) {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default();
    let path = directory.join("desktop-runtime.log");
    rotate_log_if_needed(&path);
    if let Ok(mut log) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(log, "[{timestamp}] {message}");
    }
}

fn run_bundled_migrations(
    runtime: &Path,
    node: &Path,
    migration: &Path,
    env_file: &Path,
    log_directory: &Path,
) -> Result<(), String> {
    let stdout_path = log_directory.join("migration.stdout.log");
    let stderr_path = log_directory.join("migration.stderr.log");
    rotate_log_if_needed(&stdout_path);
    rotate_log_if_needed(&stderr_path);
    let stdout = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&stdout_path)
        .map_err(|error| format!("failed to open migration stdout log: {error}"))?;
    let stderr = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&stderr_path)
        .map_err(|error| format!("failed to open migration stderr log: {error}"))?;
    let migration_argument = node_entrypoint_argument(runtime, migration);
    let mut command = Command::new(node);
    command
        .arg(&migration_argument)
        .current_dir(runtime)
        .env("NODE_ENV", "production")
        .env("PERSONAL_AI_ENV_FILE", env_file)
        .env(
            "PERSONAL_AI_MIGRATION_BACKUP_DIR",
            log_directory.join("backups").join("migrations"),
        )
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr));
    configure_command(&mut command);
    let status = command
        .status()
        .map_err(|error| format!("failed to start guarded database migration: {error}"))?;
    if status.success() {
        append_desktop_log(log_directory, "guarded database migration check completed");
        return Ok(());
    }
    Err(format!(
        "guarded database migration stopped with status {status}; inspect {} and {}",
        stdout_path.display(),
        stderr_path.display()
    ))
}

fn rotate_log_if_needed(path: &Path) {
    const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;
    if fs::metadata(path)
        .map(|metadata| metadata.len() <= MAX_LOG_BYTES)
        .unwrap_or(true)
    {
        return;
    }
    let backup = path.with_extension("log.1");
    let _ = fs::remove_file(&backup);
    let _ = fs::rename(path, backup);
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
fn normalized_windows_path(path: &Path) -> String {
    let resolved = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    normalize_windows_path_text(&resolved.to_string_lossy())
}

#[cfg(windows)]
fn normalize_windows_path_text(value: &str) -> String {
    if let Some(network_path) = value.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{network_path}")
    } else {
        value.trim_start_matches(r"\\?\").to_string()
    }
}

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

    let expected_node = normalized_windows_path(node);
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
        if !normalize_windows_path_text(&path).eq_ignore_ascii_case(&expected_node) {
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

#[cfg(windows)]
fn stop_bundled_nodes_by_exact_path(node: &Path) -> Result<(), String> {
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

    let expected_node = normalized_windows_path(node);

    let matching_processes = || -> Result<Vec<u32>, String> {
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
        if snapshot == INVALID_HANDLE_VALUE {
            return Err("failed to inspect local runtime processes".to_string());
        }

        let mut process_ids = Vec::new();
        let mut entry: PROCESSENTRY32W = unsafe { zeroed() };
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut has_entry = unsafe { Process32FirstW(snapshot, &mut entry) } != 0;
        while has_entry {
            let process_id = entry.th32ProcessID;
            if process_id != 0 {
                let process =
                    unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, process_id) };
                if !process.is_null() {
                    let mut buffer = [0_u16; 32_768];
                    let mut length = buffer.len() as u32;
                    let queried = unsafe {
                        QueryFullProcessImageNameW(process, 0, buffer.as_mut_ptr(), &mut length)
                    } != 0;
                    unsafe {
                        CloseHandle(process);
                    }
                    if queried {
                        let candidate = String::from_utf16_lossy(&buffer[..length as usize]);
                        if normalize_windows_path_text(&candidate)
                            .eq_ignore_ascii_case(&expected_node)
                        {
                            process_ids.push(process_id);
                        }
                    }
                }
            }

            entry = unsafe { zeroed() };
            entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
            has_entry = unsafe { Process32NextW(snapshot, &mut entry) } != 0;
        }
        unsafe {
            CloseHandle(snapshot);
        }
        Ok(process_ids)
    };

    for _ in 0..20 {
        let process_ids = matching_processes()?;
        if process_ids.is_empty() {
            return Ok(());
        }

        let mut failures = Vec::new();
        for process_id in process_ids {
            let process = unsafe { OpenProcess(PROCESS_TERMINATE, 0, process_id) };
            if process.is_null() {
                failures.push(process_id);
                continue;
            }
            let stopped = unsafe { TerminateProcess(process, 0) } != 0;
            unsafe {
                CloseHandle(process);
            }
            if !stopped {
                failures.push(process_id);
            }
        }
        if !failures.is_empty() {
            return Err(format!(
                "failed to stop bundled runtime processes: {}",
                failures
                    .iter()
                    .map(u32::to_string)
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
        thread::sleep(Duration::from_millis(100));
    }

    Err(format!(
        "bundled runtime processes did not exit for {}",
        node.display()
    ))
}

#[cfg(not(windows))]
fn stop_bundled_nodes_by_exact_path(_node: &Path) -> Result<(), String> {
    Err("installed runtime cleanup is only supported on Windows".to_string())
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

pub(crate) fn show_main_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        return;
    };
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}

#[cfg(windows)]
pub(crate) fn confirm_full_exit() -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        MessageBoxW, IDYES, MB_DEFBUTTON2, MB_ICONWARNING, MB_YESNO,
    };

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    let title = wide("彻底退出个人 AI 助理");
    let body = wide("彻底退出后，本地提醒服务和飞书提醒将停止。\n\n确定要彻底退出吗？");
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            body.as_ptr(),
            title.as_ptr(),
            MB_YESNO | MB_ICONWARNING | MB_DEFBUTTON2,
        ) == IDYES
    }
}

#[cfg(not(windows))]
pub(crate) fn confirm_full_exit() -> bool {
    true
}

fn should_start_hidden() -> bool {
    std::env::args_os().any(|argument| argument == START_HIDDEN_ARGUMENT)
}

#[cfg(windows)]
fn show_startup_error(message: &str) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }
    let title = wide("个人 AI 助理启动失败");
    let body = wide(message);
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            body.as_ptr(),
            title.as_ptr(),
            MB_OK | MB_ICONERROR,
        );
    }
}

#[cfg(not(windows))]
fn show_startup_error(message: &str) {
    eprintln!("Personal AI Assistant startup failed: {message}");
}

fn internal_command_exit_code() -> Option<i32> {
    let mut arguments = std::env::args_os().skip(1);
    let command = arguments.next()?;
    if command != CLEANUP_INSTALLED_RUNTIME_ARGUMENT {
        return None;
    }
    let Some(node_path) = arguments.next() else {
        return Some(2);
    };
    if arguments.next().is_some() {
        return Some(2);
    }

    Some(
        match stop_bundled_nodes_by_exact_path(Path::new(&node_path)) {
            Ok(()) => 0,
            Err(_) => 1,
        },
    )
}

fn main() {
    if let Some(exit_code) = internal_command_exit_code() {
        std::process::exit(exit_code);
    }

    let app = tauri::Builder::default()
        .manage(LocalRuntime::default())
        .manage(AppLifecycle::default())
        .manage(focus_companion::FocusCompanionState::default())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }))
        .invoke_handler(tauri::generate_handler![
            device_location,
            focus_companion::focus_mini_settings,
            focus_companion::focus_mini_hide,
            focus_companion::focus_mini_minimize,
            focus_companion::focus_evaluation_hide,
            focus_companion::focus_evaluation_minimize,
            focus_companion::focus_evaluation_start_drag,
            focus_companion::focus_preparation_hide,
            focus_companion::focus_preparation_minimize,
            focus_companion::focus_preparation_start_drag,
            focus_companion::focus_mini_open_main,
            focus_companion::focus_mini_start_drag,
            focus_companion::focus_mini_set_always_on_top,
            focus_companion::focus_mini_set_locked,
            focus_companion::focus_mini_set_auto_show,
            focus_companion::focus_mini_set_position_mode,
            focus_companion::focus_mini_set_notification,
        ])
        .setup(|app| {
            focus_companion::install(app.handle())?;
            let mut runtime_started = true;
            if !cfg!(debug_assertions) {
                let app_handle = app.handle();
                let bundled_runtime_available = bundled_runtime_dir(app_handle)
                    .map_err(std::io::Error::other)?
                    .is_some();
                let start_result = if bundled_runtime_available {
                    app.state::<LocalRuntime>()
                        .start_bundled(app_handle)
                } else if let Some(root) = workspace_root() {
                    // Keep source-tree launches usable while developing. Installed
                    // releases take the bundled branch above and do not need pnpm.
                    app.state::<LocalRuntime>().start_workspace(&root)
                } else {
                    Err("standalone runtime is missing; rebuild the desktop installer".to_string())
                };

                if let Err(error) = &start_result {
                    let retrying = app
                        .state::<LocalRuntime>()
                        .has_retryable_bundled_launch();
                    runtime_started = retrying;
                    if let Ok(app_data_dir) = app.path().app_data_dir() {
                        let _ = fs::create_dir_all(&app_data_dir);
                        append_desktop_log(
                            &app_data_dir,
                            &format!(
                                "startup failed: {error}; automatic retry: {}",
                                if retrying { "enabled" } else { "disabled" }
                            ),
                        );
                    }
                    if !should_start_hidden() || !retrying {
                        show_startup_error(&format!(
                            "后台服务暂时没有启动，软件不会再静默闪退。\n\n{error}\n\n{}\n请查看应用数据目录中的 desktop-runtime.log、api.stderr.log 和 worker.stderr.log。",
                            if retrying {
                                "软件会留在后台自动重试。"
                            } else {
                                "请修正配置后重新启动软件。"
                            }
                        ));
                        show_main_window(app_handle);
                    }
                }
            }
            if runtime_started && should_start_hidden() {
                if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
                    window.hide()?;
                }
            } else {
                show_main_window(app.handle());
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to run Personal AI Assistant desktop shell");
    app.run(|app, event| match event {
        RunEvent::WindowEvent { label, event, .. }
            if focus_companion::handle_window_event(app, &label, &event) => {}
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

#[cfg(test)]
mod tests {
    use super::node_entrypoint_argument;
    use std::path::{Path, PathBuf};

    #[cfg(windows)]
    #[test]
    fn normalizes_extended_windows_runtime_paths_before_spawning_node() {
        let runtime = Path::new(r"\\?\C:\runtime");
        let entrypoint = Path::new(r"\\?\C:\runtime\api\dist\server.js");
        assert_eq!(
            node_entrypoint_argument(runtime, entrypoint),
            PathBuf::from(".")
                .join("api")
                .join("dist")
                .join("server.js")
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn uses_a_runtime_relative_node_entrypoint() {
        let runtime = Path::new("/runtime");
        let entrypoint = Path::new("/runtime/api/dist/server.js");
        assert_eq!(
            node_entrypoint_argument(runtime, entrypoint),
            PathBuf::from(".")
                .join("api")
                .join("dist")
                .join("server.js")
        );
    }
}
