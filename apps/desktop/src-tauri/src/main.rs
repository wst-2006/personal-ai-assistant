use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::Mutex;

use tauri::{Manager, RunEvent};

#[derive(Default)]
struct LocalRuntime {
    children: Mutex<Vec<Child>>,
}

impl LocalRuntime {
    fn start(&self, root: &Path) -> Result<(), String> {
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

    fn stop(&self) {
        let Ok(mut children) = self.children.lock() else {
            return;
        };
        for child in children.drain(..) {
            stop_process_tree(child);
        }
    }
}

fn workspace_root() -> Option<PathBuf> {
    let executable = std::env::current_exe().ok()?;
    executable
        .ancestors()
        .find(|path| path.join("pnpm-workspace.yaml").is_file() && path.join(".env").is_file())
        .map(Path::to_path_buf)
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
                if let Some(root) = workspace_root() {
                    app.state::<LocalRuntime>()
                        .start(&root)
                        .map_err(std::io::Error::other)?;
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
