use std::fs;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Mutex,
};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    AppHandle, LogicalSize, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder,
    WindowEvent, Wry,
};
use tauri_plugin_notification::NotificationExt;

use crate::{confirm_full_exit, show_main_window, AppLifecycle};

const FOCUS_MINI_WINDOW_LABEL_PREFIX: &str = "focus-mini";
const FOCUS_EVALUATION_WINDOW_LABEL_PREFIX: &str = "focus-evaluation";
const FOCUS_PREPARATION_WINDOW_LABEL_PREFIX: &str = "focus-preparation";
const SETTINGS_FILE: &str = "focus-mini.conf";
const FOCUS_MINI_WIDTH: f64 = 360.0;
const FOCUS_MINI_HEIGHT: f64 = 236.0;
const FOCUS_EVALUATION_WIDTH: f64 = 540.0;
const FOCUS_EVALUATION_HEIGHT: f64 = 620.0;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum FocusMiniPositionMode {
    BottomRight,
    Center,
    Custom,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FocusMiniSettings {
    pub x: Option<i32>,
    pub y: Option<i32>,
    #[serde(skip)]
    pub preparation_x: Option<i32>,
    #[serde(skip)]
    pub preparation_y: Option<i32>,
    #[serde(skip)]
    pub preparation_position_mode: FocusMiniPositionMode,
    pub position_mode: FocusMiniPositionMode,
    pub always_on_top: bool,
    pub locked: bool,
    pub auto_show: bool,
    pub notify_start: bool,
    pub notify_phase_change: bool,
    pub notify_complete: bool,
}

impl Default for FocusMiniSettings {
    fn default() -> Self {
        Self {
            x: None,
            y: None,
            preparation_x: None,
            preparation_y: None,
            preparation_position_mode: FocusMiniPositionMode::BottomRight,
            position_mode: FocusMiniPositionMode::BottomRight,
            always_on_top: false,
            locked: false,
            auto_show: true,
            notify_start: true,
            notify_phase_change: true,
            notify_complete: true,
        }
    }
}

#[derive(Clone)]
struct TrayItems {
    status: MenuItem<Wry>,
    show_mini: MenuItem<Wry>,
}

#[derive(Default)]
pub struct FocusCompanionState {
    settings: Mutex<FocusMiniSettings>,
    profile: Mutex<FocusWindowPreferences>,
    snapshot: Mutex<Option<FocusSnapshot>>,
    evaluation_snapshot: Mutex<Option<FocusSnapshot>>,
    preparation_snapshot: Mutex<Option<FocusSnapshot>>,
    tray_items: Mutex<Option<TrayItems>>,
    window_label: Mutex<Option<String>>,
    evaluation_window_label: Mutex<Option<String>>,
    preparation_window_label: Mutex<Option<String>>,
    window_generation: AtomicU64,
    initialized: AtomicBool,
    evaluation_initialized: AtomicBool,
    preparation_initialized: AtomicBool,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
struct FocusWindowPreferences {
    desktop_focus_enabled: bool,
    focus_preparation_window_enabled: bool,
    focus_timer_window_enabled: bool,
    focus_evaluation_enabled: bool,
}

impl Default for FocusWindowPreferences {
    fn default() -> Self {
        Self {
            desktop_focus_enabled: true,
            focus_preparation_window_enabled: true,
            focus_timer_window_enabled: true,
            focus_evaluation_enabled: true,
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
struct FocusProfileEnvelope {
    profile: FocusWindowPreferences,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotEnvelope {
    snapshot: Option<FocusSnapshot>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FocusSnapshot {
    session: FocusSession,
    task: FocusTask,
    phase: String,
    phase_ends_at_epoch_ms: Option<i64>,
    current_segment: Option<FocusSegment>,
    segments: Vec<FocusSegment>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FocusSession {
    id: String,
    state: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FocusTask {
    title: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FocusSegment {
    position: i32,
    duration_minutes: i32,
}

pub fn install(app: &AppHandle) -> tauri::Result<()> {
    let settings = load_settings(app);
    *app.state::<FocusCompanionState>()
        .settings
        .lock()
        .expect("focus companion settings lock poisoned") = settings;
    ensure_mini_window(app)?;
    install_tray(app)?;
    start_monitor(app.clone());
    Ok(())
}

fn ensure_mini_window(app: &AppHandle) -> tauri::Result<()> {
    if current_mini_window(app).is_some() {
        return Ok(());
    }
    create_fresh_mini_window(app)
}

fn create_fresh_mini_window(app: &AppHandle) -> tauri::Result<()> {
    let state = app.state::<FocusCompanionState>();
    let generation = state.window_generation.fetch_add(1, Ordering::SeqCst) + 1;
    let label = format!("{FOCUS_MINI_WINDOW_LABEL_PREFIX}-{generation}");
    let settings = app
        .state::<FocusCompanionState>()
        .settings
        .lock()
        .expect("focus companion settings lock poisoned")
        .clone();
    let window = WebviewWindowBuilder::new(
        app,
        &label,
        WebviewUrl::App("index.html?focus-mini=1".into()),
    )
    .title("专注伴随")
    .inner_size(FOCUS_MINI_WIDTH, FOCUS_MINI_HEIGHT)
    .resizable(false)
    .maximizable(false)
    .minimizable(true)
    .decorations(false)
    .transparent(false)
    .shadow(true)
    .skip_taskbar(false)
    .always_on_top(settings.always_on_top)
    .visible(false)
    .prevent_overflow()
    .build()?;
    restore_visible_position(&window, &settings);
    *state
        .window_label
        .lock()
        .expect("focus companion window label lock poisoned") = Some(label);
    Ok(())
}

fn current_mini_window(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    let label = app
        .state::<FocusCompanionState>()
        .window_label
        .lock()
        .expect("focus companion window label lock poisoned")
        .clone()?;
    app.get_webview_window(&label)
}

fn ensure_evaluation_window(app: &AppHandle) -> tauri::Result<()> {
    if current_evaluation_window(app).is_some() {
        return Ok(());
    }
    let state = app.state::<FocusCompanionState>();
    let generation = state.window_generation.fetch_add(1, Ordering::SeqCst) + 1;
    let label = format!("{FOCUS_EVALUATION_WINDOW_LABEL_PREFIX}-{generation}");
    let window = WebviewWindowBuilder::new(
        app,
        &label,
        WebviewUrl::App("index.html?focus-mini=1&focus-evaluation=1".into()),
    )
    .title("任务评价")
    .inner_size(FOCUS_EVALUATION_WIDTH, FOCUS_EVALUATION_HEIGHT)
    .resizable(false)
    .maximizable(false)
    .minimizable(true)
    .decorations(false)
    .transparent(false)
    .shadow(true)
    .skip_taskbar(false)
    .always_on_top(true)
    .visible(false)
    .prevent_overflow()
    .build()?;
    let _ = window.center();
    *state
        .evaluation_window_label
        .lock()
        .expect("focus evaluation window label lock poisoned") = Some(label);
    Ok(())
}

fn current_evaluation_window(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    let label = app
        .state::<FocusCompanionState>()
        .evaluation_window_label
        .lock()
        .expect("focus evaluation window label lock poisoned")
        .clone()?;
    app.get_webview_window(&label)
}

fn ensure_preparation_window(app: &AppHandle) -> tauri::Result<()> {
    if current_preparation_window(app).is_some() {
        return Ok(());
    }
    let state = app.state::<FocusCompanionState>();
    let generation = state.window_generation.fetch_add(1, Ordering::SeqCst) + 1;
    let label = format!("{FOCUS_PREPARATION_WINDOW_LABEL_PREFIX}-{generation}");
    let window = WebviewWindowBuilder::new(
        app,
        &label,
        WebviewUrl::App("index.html?focus-mini=1&focus-preparation=1".into()),
    )
    .title("任务准备")
    .inner_size(FOCUS_MINI_WIDTH, FOCUS_MINI_HEIGHT)
    .resizable(false)
    .maximizable(false)
    .minimizable(true)
    .decorations(false)
    .transparent(false)
    .shadow(true)
    .skip_taskbar(false)
    .always_on_top(true)
    .visible(false)
    .prevent_overflow()
    .build()?;
    position_preparation_window(app, &window);
    *state
        .preparation_window_label
        .lock()
        .expect("focus preparation window label lock poisoned") = Some(label);
    Ok(())
}

fn current_preparation_window(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    let label = app
        .state::<FocusCompanionState>()
        .preparation_window_label
        .lock()
        .expect("focus preparation window label lock poisoned")
        .clone()?;
    app.get_webview_window(&label)
}

fn install_tray(app: &AppHandle) -> tauri::Result<()> {
    let status = MenuItem::with_id(app, "focus_status", "当前没有专注", false, None::<&str>)?;
    let show_mini = MenuItem::with_id(
        app,
        "show_focus_mini",
        "显示专注悬浮窗",
        false,
        None::<&str>,
    )?;
    let open = MenuItem::with_id(app, "open", "打开主界面", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "彻底退出", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&status, &show_mini, &open, &separator, &quit])?;
    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| tauri::Error::AssetNotFound("default window icon".into()))?;

    *app.state::<FocusCompanionState>()
        .tray_items
        .lock()
        .expect("focus companion tray lock poisoned") = Some(TrayItems {
        status: status.clone(),
        show_mini: show_mini.clone(),
    });

    TrayIconBuilder::with_id("personal-ai-tray")
        .icon(icon)
        .tooltip("个人 AI 助理")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show_focus_mini" => show_mini_window(app),
            "open" => show_main_window(app),
            "quit" => {
                if !confirm_full_exit() {
                    return;
                }
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
                TrayIconEvent::DoubleClick {
                    button: MouseButton::Left,
                    ..
                }
            ) {
                let app = tray.app_handle();
                let state = app.state::<FocusCompanionState>();
                let snapshot = state
                    .snapshot
                    .lock()
                    .expect("focus companion snapshot lock poisoned")
                    .clone();
                let profile = state
                    .profile
                    .lock()
                    .expect("focus companion profile lock poisoned")
                    .clone();
                if companion_visible_for_snapshot(snapshot.as_ref(), &profile) {
                    show_mini_window(app);
                } else {
                    show_main_window(app);
                }
            }
        })
        .build(app)?;
    Ok(())
}

fn start_monitor(app: AppHandle) {
    thread::spawn(move || loop {
        if let Ok(profile) =
            local_api_request("GET", "/api/v1/user-profile", None).and_then(|body| {
                serde_json::from_str::<FocusProfileEnvelope>(&body)
                    .map_err(|error| error.to_string())
            })
        {
            apply_profile(&app, profile.profile);
        }
        match local_api_request("GET", "/api/v1/focus-sessions/current-execution", None).and_then(
            |body| {
                serde_json::from_str::<SnapshotEnvelope>(&body).map_err(|error| error.to_string())
            },
        ) {
            Ok(envelope) => apply_snapshot(&app, envelope.snapshot),
            Err(_) => {}
        }
        match local_api_request("GET", "/api/v1/focus-sessions/pending-evaluation", None).and_then(
            |body| {
                serde_json::from_str::<SnapshotEnvelope>(&body).map_err(|error| error.to_string())
            },
        ) {
            Ok(envelope) => apply_evaluation_snapshot(&app, envelope.snapshot),
            Err(_) => {}
        }
        match local_api_request(
            "GET",
            "/api/v1/focus-sessions/overlapping-preparation",
            None,
        )
        .and_then(|body| {
            serde_json::from_str::<SnapshotEnvelope>(&body).map_err(|error| error.to_string())
        }) {
            Ok(envelope) => apply_preparation_snapshot(&app, envelope.snapshot),
            Err(_) => {}
        }
        thread::sleep(Duration::from_secs(1));
    });
}

fn apply_profile(app: &AppHandle, profile: FocusWindowPreferences) {
    let state = app.state::<FocusCompanionState>();
    let changed = {
        let mut guard = state
            .profile
            .lock()
            .expect("focus companion profile lock poisoned");
        let changed = *guard != profile;
        *guard = profile.clone();
        changed
    };
    if !changed {
        return;
    }
    let snapshot = state
        .snapshot
        .lock()
        .expect("focus companion snapshot lock poisoned")
        .clone();
    refresh_tray(state.inner(), snapshot.as_ref(), &profile);
    if !companion_visible_for_snapshot(snapshot.as_ref(), &profile) {
        if let Some(window) = current_mini_window(app) {
            let _ = window.hide();
        }
    }
    if (!profile.desktop_focus_enabled || !profile.focus_evaluation_enabled)
        && current_evaluation_window(app).is_some()
    {
        if let Some(window) = current_evaluation_window(app) {
            let _ = window.hide();
        }
    }
    if (!profile.desktop_focus_enabled || !profile.focus_preparation_window_enabled)
        && current_preparation_window(app).is_some()
    {
        if let Some(window) = current_preparation_window(app) {
            let _ = window.hide();
        }
    }
    sync_companion_topmost_state(app);
}

fn apply_snapshot(app: &AppHandle, snapshot: Option<FocusSnapshot>) {
    let state = app.state::<FocusCompanionState>();
    let profile = state
        .profile
        .lock()
        .expect("focus companion profile lock poisoned")
        .clone();
    let previous = {
        let mut guard = state
            .snapshot
            .lock()
            .expect("focus companion snapshot lock poisoned");
        let previous = guard.clone();
        *guard = snapshot.clone();
        previous
    };
    refresh_tray(state.inner(), snapshot.as_ref(), &profile);

    let first_update = !state.initialized.swap(true, Ordering::SeqCst);
    if let Some(current) = snapshot.as_ref() {
        let current_surface_enabled = window_enabled_for_snapshot(current, &profile);
        if !current_surface_enabled {
            if let Some(window) = current_mini_window(app) {
                let _ = window.hide();
            }
        }
        let intermediate_break_finished =
            should_hide_after_intermediate_break(previous.as_ref(), current);
        if intermediate_break_finished {
            if let Some(window) = current_mini_window(app) {
                let _ = window.hide();
            }
            if !first_update {
                notify_transition(app, previous.as_ref(), current, &profile);
            }
            return;
        }
        let start_confirmation_finished =
            should_hide_after_start_confirmation(previous.as_ref(), current);
        if start_confirmation_finished {
            if let Some(window) = current_mini_window(app) {
                let _ = window.hide();
            }
        }
        let entered_running_window = current_surface_enabled
            && current.session.state == "running"
            && (current_mini_window(app).is_none()
                || should_recreate_for_running(previous.as_ref(), current));
        let entered_evaluation = current_surface_enabled
            && current.session.state == "ended"
            && previous.as_ref().map(|old| old.session.state.as_str()) != Some("ended");
        let entered_final_break = current_surface_enabled
            && is_final_break(current)
            && previous
                .as_ref()
                .map(|old| is_final_break(old))
                .unwrap_or(false)
                == false;
        let changed_surface = first_update
            || previous.as_ref().map(|old| old.session.state == "ended")
                != Some(current.session.state == "ended");
        if entered_running_window {
            // The preparation surface must not silently turn into the execution
            // surface behind another window. Destroying and rebuilding gives
            // Windows a genuinely new taskbar window and a fresh foreground cue.
            if recreate_companion_window(app).is_ok() {
                show_mini_window(app);
            }
        } else if current_surface_enabled && changed_surface {
            resize_companion_window(app, current.session.state == "ended");
        }
        if entered_evaluation || entered_final_break {
            show_mini_window(app);
        } else if !start_confirmation_finished
            && should_auto_show(previous.as_ref(), current, &profile)
        {
            let settings = state
                .settings
                .lock()
                .expect("focus companion settings lock poisoned")
                .clone();
            let requires_start_confirmation = matches!(
                current.session.state.as_str(),
                "preparing" | "armed" | "awaiting_late_start"
            );
            if requires_start_confirmation || settings.auto_show {
                show_mini_window(app);
            }
        }
        if !first_update {
            notify_transition(app, previous.as_ref(), current, &profile);
        }
    } else if let Some(window) = current_mini_window(app) {
        let _ = window.hide();
    }
}

fn apply_evaluation_snapshot(app: &AppHandle, snapshot: Option<FocusSnapshot>) {
    let state = app.state::<FocusCompanionState>();
    let profile = state
        .profile
        .lock()
        .expect("focus companion profile lock poisoned")
        .clone();
    let previous = {
        let mut guard = state
            .evaluation_snapshot
            .lock()
            .expect("focus evaluation snapshot lock poisoned");
        let previous = guard.clone();
        *guard = snapshot.clone();
        previous
    };
    let first_update = !state.evaluation_initialized.swap(true, Ordering::SeqCst);
    let enabled = profile.desktop_focus_enabled && profile.focus_evaluation_enabled;

    if !enabled || snapshot.is_none() {
        if let Some(window) = current_evaluation_window(app) {
            let _ = window.hide();
        }
        if let Some(window) = current_mini_window(app) {
            let settings = state
                .settings
                .lock()
                .expect("focus companion settings lock poisoned")
                .clone();
            let _ = window.set_always_on_top(settings.always_on_top);
            restore_visible_position(&window, &settings);
        }
        return;
    }

    let current = snapshot.as_ref().expect("checked evaluation snapshot");
    let changed =
        previous.as_ref().map(|old| old.session.id.as_str()) != Some(current.session.id.as_str());
    if ensure_evaluation_window(app).is_ok() {
        if let Some(window) = current_evaluation_window(app) {
            let _ = window.set_always_on_top(true);
            if first_update || changed {
                let _ = window.center();
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
    }
    if first_update || changed {
        position_mini_for_evaluation(app);
    }
    sync_companion_topmost_state(app);
    if !first_update && changed {
        notify_transition(app, previous.as_ref(), current, &profile);
    }
}

fn position_mini_for_evaluation(app: &AppHandle) {
    let Some(window) = current_mini_window(app) else {
        return;
    };
    let settings = app
        .state::<FocusCompanionState>()
        .settings
        .lock()
        .expect("focus companion settings lock poisoned")
        .clone();
    // Evaluation is a separate surface. Keep the execution companion at the
    // user's chosen position instead of silently forcing it to the bottom edge.
    restore_visible_position(&window, &settings);
}

fn apply_preparation_snapshot(app: &AppHandle, snapshot: Option<FocusSnapshot>) {
    let state = app.state::<FocusCompanionState>();
    let profile = state
        .profile
        .lock()
        .expect("focus companion profile lock poisoned")
        .clone();
    let previous = {
        let mut guard = state
            .preparation_snapshot
            .lock()
            .expect("focus preparation snapshot lock poisoned");
        let previous = guard.clone();
        *guard = snapshot.clone();
        previous
    };
    let first_update = !state.preparation_initialized.swap(true, Ordering::SeqCst);
    let enabled = profile.desktop_focus_enabled && profile.focus_preparation_window_enabled;
    if !enabled || snapshot.is_none() {
        if let Some(window) = current_preparation_window(app) {
            let _ = window.hide();
        }
        sync_companion_topmost_state(app);
        return;
    }

    let current = snapshot.as_ref().expect("checked preparation snapshot");
    let changed =
        previous.as_ref().map(|old| old.session.id.as_str()) != Some(current.session.id.as_str());
    if ensure_preparation_window(app).is_ok() {
        if let Some(window) = current_preparation_window(app) {
            let _ = window.set_always_on_top(true);
            if first_update || changed {
                position_preparation_window(app, &window);
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
    }
    sync_companion_topmost_state(app);
}

fn sync_companion_topmost_state(app: &AppHandle) {
    let evaluation_visible = current_evaluation_window(app)
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false);
    let preparation_visible = current_preparation_window(app)
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false);
    if let Some(window) = current_mini_window(app) {
        let settings = app
            .state::<FocusCompanionState>()
            .settings
            .lock()
            .expect("focus companion settings lock poisoned")
            .clone();
        let _ = window
            .set_always_on_top(evaluation_visible || preparation_visible || settings.always_on_top);
    }
}

fn position_preparation_window(app: &AppHandle, window: &tauri::WebviewWindow) {
    let settings = app
        .state::<FocusCompanionState>()
        .settings
        .lock()
        .expect("focus companion settings lock poisoned")
        .clone();
    restore_window_position(
        window,
        &settings.preparation_position_mode,
        settings.preparation_x.zip(settings.preparation_y),
    );
    if settings.preparation_position_mode == FocusMiniPositionMode::Custom
        && settings.preparation_x.is_some()
        && settings.preparation_y.is_some()
    {
        return;
    }
    let Some(base) = current_mini_window(app) else {
        return;
    };
    let Ok(base_position) = base.outer_position() else {
        return;
    };
    let Ok(size) = window.outer_size() else {
        return;
    };
    let monitor = base
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| app.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        return;
    };
    let monitor_position = monitor.position();
    let monitor_size = monitor.size();
    let max_x = monitor_position.x + monitor_size.width as i32 - size.width as i32;
    let max_y = monitor_position.y + monitor_size.height as i32 - size.height as i32;
    let target_x = base_position
        .x
        .clamp(monitor_position.x, max_x.max(monitor_position.x));
    let target_y = base_position
        .y
        .saturating_sub(size.height as i32 + 16)
        .clamp(monitor_position.y, max_y.max(monitor_position.y));
    let _ = window.set_position(PhysicalPosition::new(target_x, target_y));
}

fn should_recreate_for_running(previous: Option<&FocusSnapshot>, current: &FocusSnapshot) -> bool {
    current.session.state == "running"
        && previous
            .map(|old| old.session.id != current.session.id || old.session.state != "running")
            .unwrap_or(true)
}

fn is_final_break(snapshot: &FocusSnapshot) -> bool {
    snapshot.phase == "break"
        && snapshot
            .current_segment
            .as_ref()
            .map(|segment| segment.position)
            == snapshot
                .segments
                .iter()
                .map(|segment| segment.position)
                .max()
}

fn should_hide_after_intermediate_break(
    previous: Option<&FocusSnapshot>,
    current: &FocusSnapshot,
) -> bool {
    previous
        .map(|old| {
            old.session.id == current.session.id
                && old.phase == "break"
                && current.phase == "focus"
                && !is_final_break(old)
        })
        .unwrap_or(false)
}

fn should_hide_after_start_confirmation(
    previous: Option<&FocusSnapshot>,
    current: &FocusSnapshot,
) -> bool {
    previous
        .map(|old| {
            old.session.id == current.session.id
                && matches!(
                    old.session.state.as_str(),
                    "preparing" | "reminded" | "scheduled"
                )
                && matches!(
                    current.session.state.as_str(),
                    "armed" | "running" | "awaiting_late_start"
                )
        })
        .unwrap_or(false)
}

fn recreate_companion_window(app: &AppHandle) -> tauri::Result<()> {
    if let Some(window) = current_mini_window(app) {
        window.destroy()?;
    }
    create_fresh_mini_window(app)
}

fn resize_companion_window(app: &AppHandle, evaluation: bool) {
    let Some(window) = current_mini_window(app) else {
        return;
    };
    let (width, height) = if evaluation {
        (FOCUS_EVALUATION_WIDTH, FOCUS_EVALUATION_HEIGHT)
    } else {
        (FOCUS_MINI_WIDTH, FOCUS_MINI_HEIGHT)
    };
    let _ = window.set_size(LogicalSize::new(width, height));
    let settings = app
        .state::<FocusCompanionState>()
        .settings
        .lock()
        .expect("focus companion settings lock poisoned")
        .clone();
    restore_visible_position(&window, &settings);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot(id: &str, state: &str) -> FocusSnapshot {
        FocusSnapshot {
            session: FocusSession {
                id: id.to_string(),
                state: state.to_string(),
            },
            task: FocusTask {
                title: "测试任务".to_string(),
            },
            phase: "focus".to_string(),
            phase_ends_at_epoch_ms: None,
            current_segment: None,
            segments: Vec::new(),
        }
    }

    fn profile() -> FocusWindowPreferences {
        FocusWindowPreferences::default()
    }

    #[test]
    fn entering_running_recreates_the_native_window() {
        let preparing = snapshot("focus-1", "armed");
        let running = snapshot("focus-1", "running");
        assert!(should_recreate_for_running(Some(&preparing), &running));
    }

    #[test]
    fn running_phase_updates_do_not_recreate_the_native_window() {
        let before = snapshot("focus-1", "running");
        let after = snapshot("focus-1", "running");
        assert!(!should_recreate_for_running(Some(&before), &after));
    }

    #[test]
    fn a_different_running_session_gets_its_own_native_window() {
        let before = snapshot("focus-1", "running");
        let after = snapshot("focus-2", "running");
        assert!(should_recreate_for_running(Some(&before), &after));
    }

    #[test]
    fn intermediate_break_hides_when_the_next_focus_segment_begins() {
        let mut resting = snapshot("focus-1", "running");
        resting.phase = "break".to_string();
        resting.current_segment = Some(FocusSegment {
            position: 1,
            duration_minutes: 5,
        });
        resting.segments = vec![
            FocusSegment {
                position: 0,
                duration_minutes: 25,
            },
            FocusSegment {
                position: 1,
                duration_minutes: 5,
            },
            FocusSegment {
                position: 2,
                duration_minutes: 25,
            },
        ];
        let mut focusing = resting.clone();
        focusing.phase = "focus".to_string();
        focusing.current_segment = Some(FocusSegment {
            position: 2,
            duration_minutes: 25,
        });

        assert!(should_hide_after_intermediate_break(
            Some(&resting),
            &focusing
        ));
    }

    #[test]
    fn final_break_stays_visible_until_evaluation() {
        let mut resting = snapshot("focus-1", "running");
        resting.phase = "break".to_string();
        resting.current_segment = Some(FocusSegment {
            position: 2,
            duration_minutes: 5,
        });
        resting.segments = vec![
            FocusSegment {
                position: 0,
                duration_minutes: 25,
            },
            FocusSegment {
                position: 1,
                duration_minutes: 25,
            },
            FocusSegment {
                position: 2,
                duration_minutes: 5,
            },
        ];
        let mut ended = resting.clone();
        ended.session.state = "ended".to_string();
        ended.phase = "ended".to_string();

        assert!(is_final_break(&resting));
        assert!(!should_hide_after_intermediate_break(
            Some(&resting),
            &ended
        ));
    }

    #[test]
    fn start_confirmation_hides_preparation_until_running_window_reopens() {
        let preparing = snapshot("focus-1", "preparing");
        let armed = snapshot("focus-1", "armed");
        assert!(should_hide_after_start_confirmation(
            Some(&preparing),
            &armed
        ));

        let mut running = armed.clone();
        running.session.state = "running".to_string();
        running.phase = "focus".to_string();
        assert!(should_hide_after_start_confirmation(
            Some(&preparing),
            &running
        ));
    }

    #[test]
    fn stage_switches_control_only_their_own_surfaces() {
        let mut preferences = profile();
        preferences.focus_preparation_window_enabled = false;
        assert!(!window_enabled_for_snapshot(
            &snapshot("focus-1", "preparing"),
            &preferences
        ));
        assert!(window_enabled_for_snapshot(
            &snapshot("focus-1", "running"),
            &preferences
        ));

        preferences.focus_timer_window_enabled = false;
        assert!(!window_enabled_for_snapshot(
            &snapshot("focus-1", "running"),
            &preferences
        ));
        assert!(window_enabled_for_snapshot(
            &snapshot("focus-1", "ended"),
            &preferences
        ));

        preferences.focus_evaluation_enabled = false;
        assert!(!window_enabled_for_snapshot(
            &snapshot("focus-1", "ended"),
            &preferences
        ));
    }

    #[test]
    fn desktop_focus_switch_disables_every_surface() {
        let mut preferences = profile();
        preferences.desktop_focus_enabled = false;
        for state in [
            "preparing",
            "armed",
            "awaiting_late_start",
            "running",
            "ended",
        ] {
            assert!(!window_enabled_for_snapshot(
                &snapshot("focus-1", state),
                &preferences
            ));
        }
    }

    #[test]
    fn anchored_modes_keep_expected_positions() {
        assert_eq!(
            anchored_position(&FocusMiniPositionMode::Center, None, 0, 0, 1560, 844),
            (780, 422)
        );
        assert_eq!(
            anchored_position(&FocusMiniPositionMode::BottomRight, None, 0, 0, 1560, 844),
            (1536, 820)
        );
        assert_eq!(
            anchored_position(
                &FocusMiniPositionMode::Custom,
                Some((1700, -20)),
                0,
                0,
                1560,
                844
            ),
            (1560, 0)
        );
    }
}

fn refresh_tray(
    state: &FocusCompanionState,
    snapshot: Option<&FocusSnapshot>,
    profile: &FocusWindowPreferences,
) {
    let items = state
        .tray_items
        .lock()
        .expect("focus companion tray lock poisoned")
        .clone();
    let Some(items) = items else {
        return;
    };
    if let Some(snapshot) = snapshot {
        let remaining = snapshot
            .phase_ends_at_epoch_ms
            .map(|ends| ((ends - now_epoch_ms()).max(0) / 1000) as u64)
            .unwrap_or(0);
        let label = if matches!(
            snapshot.session.state.as_str(),
            "preparing" | "armed" | "awaiting_late_start" | "running"
        ) {
            format!("当前专注：{}", format_remaining(remaining))
        } else if snapshot.session.state == "ended" {
            "本次专注已结束".to_string()
        } else {
            "专注等待开始".to_string()
        };
        let _ = items.status.set_text(label);
        let _ = items
            .show_mini
            .set_enabled(companion_visible_for_snapshot(Some(snapshot), profile));
    } else {
        let _ = items.status.set_text("当前没有专注");
        let _ = items.show_mini.set_enabled(false);
    }
}

fn should_auto_show(
    previous: Option<&FocusSnapshot>,
    current: &FocusSnapshot,
    profile: &FocusWindowPreferences,
) -> bool {
    if !window_enabled_for_snapshot(current, profile) {
        return false;
    }
    let executing = matches!(
        current.session.state.as_str(),
        "preparing" | "armed" | "awaiting_late_start" | "running"
    );
    if !executing {
        return false;
    }
    previous
        .map(|old| {
            old.session.id != current.session.id
                || !matches!(
                    old.session.state.as_str(),
                    "preparing" | "armed" | "awaiting_late_start" | "running"
                )
        })
        .unwrap_or(true)
}

fn window_enabled_for_snapshot(snapshot: &FocusSnapshot, profile: &FocusWindowPreferences) -> bool {
    if !profile.desktop_focus_enabled {
        return false;
    }
    match snapshot.session.state.as_str() {
        "preparing" | "armed" | "awaiting_late_start" => profile.focus_preparation_window_enabled,
        "running" => profile.focus_timer_window_enabled,
        "ended" => profile.focus_evaluation_enabled,
        _ => false,
    }
}

fn companion_visible_for_snapshot(
    snapshot: Option<&FocusSnapshot>,
    profile: &FocusWindowPreferences,
) -> bool {
    snapshot
        .map(|value| window_enabled_for_snapshot(value, profile))
        .unwrap_or(false)
}

fn notify_transition(
    app: &AppHandle,
    previous: Option<&FocusSnapshot>,
    current: &FocusSnapshot,
    profile: &FocusWindowPreferences,
) {
    if !profile.desktop_focus_enabled {
        return;
    }
    let settings = app
        .state::<FocusCompanionState>()
        .settings
        .lock()
        .expect("focus companion settings lock poisoned")
        .clone();
    let prior = previous.filter(|old| old.session.id == current.session.id);
    let transition = if current.session.state == "ended"
        && prior.map(|old| old.session.state.as_str()) != Some("ended")
        && settings.notify_complete
    {
        let title = if profile.focus_evaluation_enabled {
            "专注结束，待评价"
        } else {
            "专注结束"
        };
        Some((title.to_string(), current.task.title.clone()))
    } else if current.session.state == "running"
        && prior.map(|old| old.session.state.as_str()) != Some("running")
        && settings.notify_start
    {
        let duration = current
            .current_segment
            .as_ref()
            .map(|segment| segment.duration_minutes)
            .unwrap_or(0);
        Some((
            format!("已开始 {duration} 分钟专注"),
            current.task.title.clone(),
        ))
    } else if settings.notify_phase_change
        && prior.map(|old| {
            (
                &old.phase,
                old.current_segment.as_ref().map(|segment| segment.position),
            )
        }) != Some((
            &current.phase,
            current
                .current_segment
                .as_ref()
                .map(|segment| segment.position),
        ))
    {
        if current.phase == "break" {
            Some((
                "这一段完成了".to_string(),
                format!(
                    "休息 {} 分钟",
                    current
                        .current_segment
                        .as_ref()
                        .map(|segment| segment.duration_minutes)
                        .unwrap_or(0)
                ),
            ))
        } else if current.phase == "focus" {
            Some(("下一段专注开始".to_string(), current.task.title.clone()))
        } else {
            None
        }
    } else {
        None
    };
    if let Some((title, body)) = transition {
        let _ = app.notification().builder().title(title).body(body).show();
    }
}

fn local_api_request(method: &str, path: &str, body: Option<&str>) -> Result<String, String> {
    let address: SocketAddr = "127.0.0.1:3000"
        .parse()
        .map_err(|error| format!("invalid API address: {error}"))?;
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_millis(650))
        .map_err(|error| format!("local API unavailable: {error}"))?;
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
    let payload = body.unwrap_or("");
    let request = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:3000\r\nConnection: close\r\nAccept: application/json\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
        payload.len(), payload
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|error| error.to_string())?;
    let mut response = Vec::new();
    stream
        .read_to_end(&mut response)
        .map_err(|error| error.to_string())?;
    let response = String::from_utf8(response).map_err(|error| error.to_string())?;
    let (headers, body) = response
        .split_once("\r\n\r\n")
        .ok_or_else(|| "local API returned an invalid response".to_string())?;
    let status = headers.lines().next().unwrap_or_default();
    if !status.contains(" 2") {
        return Err(format!("local API request failed: {status}"));
    }
    Ok(body.to_string())
}

fn show_mini_window(app: &AppHandle) {
    let state = app.state::<FocusCompanionState>();
    let snapshot = state
        .snapshot
        .lock()
        .expect("focus companion snapshot lock poisoned")
        .clone();
    let profile = state
        .profile
        .lock()
        .expect("focus companion profile lock poisoned")
        .clone();
    if !companion_visible_for_snapshot(snapshot.as_ref(), &profile) {
        return;
    }
    let Some(window) = current_mini_window(app) else {
        return;
    };
    let settings = app
        .state::<FocusCompanionState>()
        .settings
        .lock()
        .expect("focus companion settings lock poisoned")
        .clone();
    restore_visible_position(&window, &settings);
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

fn restore_visible_position(window: &tauri::WebviewWindow, settings: &FocusMiniSettings) {
    restore_window_position(window, &settings.position_mode, settings.x.zip(settings.y));
}

fn restore_window_position(
    window: &tauri::WebviewWindow,
    mode: &FocusMiniPositionMode,
    saved: Option<(i32, i32)>,
) {
    let Ok(monitors) = window.available_monitors() else {
        return;
    };
    if monitors.is_empty() {
        return;
    }
    let window_size = window
        .outer_size()
        .unwrap_or_else(|_| tauri::PhysicalSize::new(360, 236));
    let selected = saved
        .and_then(|(saved_x, saved_y)| {
            monitors.iter().find(|monitor| {
                let position = monitor.position();
                let size = monitor.size();
                saved_x >= position.x
                    && saved_x < position.x + size.width as i32
                    && saved_y >= position.y
                    && saved_y < position.y + size.height as i32
            })
        })
        .or_else(|| {
            window.current_monitor().ok().flatten().and_then(|current| {
                monitors
                    .iter()
                    .find(|monitor| monitor.name() == current.name())
            })
        })
        .or_else(|| monitors.first());
    let Some(monitor) = selected else {
        return;
    };
    let position = monitor.position();
    let size = monitor.size();
    let max_x = position.x + size.width as i32 - window_size.width as i32;
    let max_y = position.y + size.height as i32 - window_size.height as i32;
    let (x, y) = anchored_position(mode, saved, position.x, position.y, max_x, max_y);
    let _ = window.set_position(PhysicalPosition::new(x, y));
}

fn anchored_position(
    mode: &FocusMiniPositionMode,
    saved: Option<(i32, i32)>,
    min_x: i32,
    min_y: i32,
    max_x: i32,
    max_y: i32,
) -> (i32, i32) {
    match mode {
        FocusMiniPositionMode::Center => (
            min_x + ((max_x - min_x).max(0) / 2),
            min_y + ((max_y - min_y).max(0) / 2),
        ),
        FocusMiniPositionMode::Custom => saved
            .map(|(saved_x, saved_y)| {
                (
                    saved_x.clamp(min_x, max_x.max(min_x)),
                    saved_y.clamp(min_y, max_y.max(min_y)),
                )
            })
            .unwrap_or(((max_x - 24).max(min_x), (max_y - 24).max(min_y))),
        FocusMiniPositionMode::BottomRight => ((max_x - 24).max(min_x), (max_y - 24).max(min_y)),
    }
}

pub fn handle_window_event(app: &AppHandle, label: &str, event: &WindowEvent) -> bool {
    let is_mini = label.starts_with(&format!("{FOCUS_MINI_WINDOW_LABEL_PREFIX}-"));
    let is_evaluation = label.starts_with(&format!("{FOCUS_EVALUATION_WINDOW_LABEL_PREFIX}-"));
    let is_preparation = label.starts_with(&format!("{FOCUS_PREPARATION_WINDOW_LABEL_PREFIX}-"));
    if !is_mini && !is_evaluation && !is_preparation {
        return false;
    }
    match event {
        WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            if let Some(window) = app.get_webview_window(label) {
                let _ = window.hide();
            }
            if is_evaluation || is_preparation {
                sync_companion_topmost_state(app);
            }
        }
        WindowEvent::Moved(position) if is_mini || is_preparation => {
            let state = app.state::<FocusCompanionState>();
            let mut settings = state
                .settings
                .lock()
                .expect("focus companion settings lock poisoned");
            if is_preparation && settings.preparation_position_mode == FocusMiniPositionMode::Custom
            {
                settings.preparation_x = Some(position.x);
                settings.preparation_y = Some(position.y);
                save_settings(app, &settings);
            } else if is_mini && settings.position_mode == FocusMiniPositionMode::Custom {
                settings.x = Some(position.x);
                settings.y = Some(position.y);
                save_settings(app, &settings);
            }
        }
        _ => {}
    }
    true
}

#[tauri::command]
pub fn focus_mini_settings(app: AppHandle) -> FocusMiniSettings {
    app.state::<FocusCompanionState>()
        .settings
        .lock()
        .expect("focus companion settings lock poisoned")
        .clone()
}

#[tauri::command]
pub fn focus_mini_hide(app: AppHandle) {
    if let Some(window) = current_mini_window(&app) {
        let _ = window.hide();
    }
}

#[tauri::command]
pub fn focus_mini_minimize(app: AppHandle) {
    if let Some(window) = current_mini_window(&app) {
        let _ = window.minimize();
    }
}

#[tauri::command]
pub fn focus_evaluation_hide(app: AppHandle) {
    if let Some(window) = current_evaluation_window(&app) {
        let _ = window.hide();
    }
    sync_companion_topmost_state(&app);
}

#[tauri::command]
pub fn focus_evaluation_minimize(app: AppHandle) {
    if let Some(window) = current_evaluation_window(&app) {
        let _ = window.minimize();
    }
}

#[tauri::command]
pub fn focus_evaluation_start_drag(app: AppHandle) -> Result<(), String> {
    let window = current_evaluation_window(&app)
        .ok_or_else(|| "focus evaluation window is missing".to_string())?;
    window.start_dragging().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn focus_preparation_hide(app: AppHandle) {
    if let Some(window) = current_preparation_window(&app) {
        let _ = window.hide();
    }
    sync_companion_topmost_state(&app);
}

#[tauri::command]
pub fn focus_preparation_minimize(app: AppHandle) {
    if let Some(window) = current_preparation_window(&app) {
        let _ = window.minimize();
    }
}

#[tauri::command]
pub fn focus_preparation_start_drag(app: AppHandle) -> Result<(), String> {
    let window = current_preparation_window(&app)
        .ok_or_else(|| "focus preparation window is missing".to_string())?;
    let state = app.state::<FocusCompanionState>();
    let mut settings = state
        .settings
        .lock()
        .map_err(|_| "focus companion settings lock poisoned".to_string())?;
    if settings.locked {
        return Ok(());
    }
    if let Ok(position) = window.outer_position() {
        settings.preparation_x = Some(position.x);
        settings.preparation_y = Some(position.y);
    }
    settings.preparation_position_mode = FocusMiniPositionMode::Custom;
    save_settings(&app, &settings);
    drop(settings);
    window.start_dragging().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn focus_mini_open_main(app: AppHandle) {
    show_main_window(&app);
}

#[tauri::command]
pub fn focus_mini_start_drag(app: AppHandle) -> Result<(), String> {
    let window =
        current_mini_window(&app).ok_or_else(|| "focus mini window is missing".to_string())?;
    let state = app.state::<FocusCompanionState>();
    let mut settings = state
        .settings
        .lock()
        .map_err(|_| "focus companion settings lock poisoned".to_string())?;
    if settings.locked {
        return Ok(());
    }
    // The first drag opts out of the initial anchor. Subsequent native Moved
    // events persist the physical coordinates and restore them on relaunch.
    if let Ok(position) = window.outer_position() {
        settings.x = Some(position.x);
        settings.y = Some(position.y);
    }
    settings.position_mode = FocusMiniPositionMode::Custom;
    save_settings(&app, &settings);
    drop(settings);
    window.start_dragging().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn focus_mini_set_always_on_top(
    app: AppHandle,
    enabled: bool,
) -> Result<FocusMiniSettings, String> {
    let window =
        current_mini_window(&app).ok_or_else(|| "focus mini window is missing".to_string())?;
    window
        .set_always_on_top(enabled)
        .map_err(|error| error.to_string())?;
    update_settings(&app, |settings| settings.always_on_top = enabled)
}

#[tauri::command]
pub fn focus_mini_set_locked(app: AppHandle, enabled: bool) -> Result<FocusMiniSettings, String> {
    update_settings(&app, |settings| settings.locked = enabled)
}

#[tauri::command]
pub fn focus_mini_set_auto_show(
    app: AppHandle,
    enabled: bool,
) -> Result<FocusMiniSettings, String> {
    update_settings(&app, |settings| settings.auto_show = enabled)
}

#[tauri::command]
pub fn focus_mini_set_position_mode(
    app: AppHandle,
    position_mode: FocusMiniPositionMode,
) -> Result<FocusMiniSettings, String> {
    let settings = update_settings(&app, |settings| settings.position_mode = position_mode)?;
    if let Some(window) = current_mini_window(&app) {
        restore_visible_position(&window, &settings);
    }
    Ok(settings)
}

#[tauri::command]
pub fn focus_mini_set_notification(
    app: AppHandle,
    kind: String,
    enabled: bool,
) -> Result<FocusMiniSettings, String> {
    update_settings(&app, |settings| match kind.as_str() {
        "start" => settings.notify_start = enabled,
        "phase" => settings.notify_phase_change = enabled,
        "complete" => settings.notify_complete = enabled,
        _ => {}
    })
}

fn update_settings(
    app: &AppHandle,
    update: impl FnOnce(&mut FocusMiniSettings),
) -> Result<FocusMiniSettings, String> {
    let state = app.state::<FocusCompanionState>();
    let mut settings = state
        .settings
        .lock()
        .map_err(|_| "focus companion settings lock poisoned".to_string())?;
    update(&mut settings);
    save_settings(app, &settings);
    Ok(settings.clone())
}

fn settings_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|directory| directory.join(SETTINGS_FILE))
}

fn load_settings(app: &AppHandle) -> FocusMiniSettings {
    let Some(path) = settings_path(app) else {
        return FocusMiniSettings::default();
    };
    let Ok(content) = fs::read_to_string(path) else {
        return FocusMiniSettings::default();
    };
    let mut settings = FocusMiniSettings::default();
    for line in content.lines() {
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        match key {
            "x" => settings.x = value.parse().ok(),
            "y" => settings.y = value.parse().ok(),
            "preparation_x" => settings.preparation_x = value.parse().ok(),
            "preparation_y" => settings.preparation_y = value.parse().ok(),
            "position_mode" => {
                settings.position_mode = match value {
                    "center" => FocusMiniPositionMode::Center,
                    "custom" => FocusMiniPositionMode::Custom,
                    _ => FocusMiniPositionMode::BottomRight,
                }
            }
            "preparation_position_mode" => {
                settings.preparation_position_mode = match value {
                    "custom" => FocusMiniPositionMode::Custom,
                    "center" => FocusMiniPositionMode::Center,
                    _ => FocusMiniPositionMode::BottomRight,
                }
            }
            "always_on_top" => settings.always_on_top = value == "true",
            "locked" => settings.locked = value == "true",
            "auto_show" => settings.auto_show = value != "false",
            "notify_start" => settings.notify_start = value != "false",
            "notify_phase_change" => settings.notify_phase_change = value != "false",
            "notify_complete" => settings.notify_complete = value != "false",
            _ => {}
        }
    }
    settings
}

fn save_settings(app: &AppHandle, settings: &FocusMiniSettings) {
    let Some(path) = settings_path(app) else {
        return;
    };
    if let Some(directory) = path.parent() {
        let _ = fs::create_dir_all(directory);
    }
    let body = format!(
        "x={}\ny={}\npreparation_x={}\npreparation_y={}\nposition_mode={}\npreparation_position_mode={}\nalways_on_top={}\nlocked={}\nauto_show={}\nnotify_start={}\nnotify_phase_change={}\nnotify_complete={}\n",
        settings.x.map(|value| value.to_string()).unwrap_or_default(),
        settings.y.map(|value| value.to_string()).unwrap_or_default(),
        settings.preparation_x.map(|value| value.to_string()).unwrap_or_default(),
        settings.preparation_y.map(|value| value.to_string()).unwrap_or_default(),
        match settings.position_mode {
            FocusMiniPositionMode::BottomRight => "bottom_right",
            FocusMiniPositionMode::Center => "center",
            FocusMiniPositionMode::Custom => "custom",
        },
        match settings.preparation_position_mode {
            FocusMiniPositionMode::BottomRight => "bottom_right",
            FocusMiniPositionMode::Center => "center",
            FocusMiniPositionMode::Custom => "custom",
        },
        settings.always_on_top,
        settings.locked,
        settings.auto_show,
        settings.notify_start,
        settings.notify_phase_change,
        settings.notify_complete,
    );
    let _ = fs::write(path, body);
}

fn now_epoch_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn format_remaining(seconds: u64) -> String {
    let hours = seconds / 3600;
    let minutes = (seconds % 3600) / 60;
    let seconds = seconds % 60;
    if hours > 0 {
        format!("{hours}:{minutes:02}:{seconds:02}")
    } else {
        format!("{minutes:02}:{seconds:02}")
    }
}
