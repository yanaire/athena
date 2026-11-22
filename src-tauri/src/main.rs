mod legacy_keychain;
mod sidecar;

use anyhow::{ensure, Context as _, Result};
use sidecar::{Notice, Sidecar};
use std::{
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{
    webview::{cookie::SameSite, Cookie, DownloadEvent, NewWindowResponse},
    AppHandle, Manager, RunEvent, State, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_dialog::{DialogExt as _, MessageDialogKind};

#[derive(Default)]
struct Desktop {
    origin: Mutex<Option<Url>>,
    stopping: AtomicBool,
    stopped: AtomicBool,
}

fn show_workspace(app: &AppHandle, ready: sidecar::Ready) -> Result<()> {
    let url = Url::parse(&format!("http://127.0.0.1:{}/", ready.port))?;
    let window = app
        .get_webview_window("main")
        .context("Window was closed")?;
    window.set_cookie(
        Cookie::build(("athena_desktop", ready.token.clone()))
            .domain("127.0.0.1")
            .path("/")
            .http_only(true)
            .same_site(SameSite::Strict)
            .build(),
    )?;
    // The dispatched setter does not report WebKit errors. Wait for WebKit's
    // cookie store on this worker, never block the GUI thread waiting for it.
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        // Wry's WKWebView cookies_for_url compares URL::domain(), which is
        // absent for our IPv4 literal. Compare the native cookie host instead.
        if window.cookies()?.iter().any(|cookie| {
            cookie.name() == "athena_desktop"
                && cookie.value() == ready.token
                && cookie.domain() == url.host_str()
                && cookie.path() == Some("/")
                && cookie.http_only() == Some(true)
        }) {
            break;
        }
        ensure!(
            Instant::now() < deadline,
            "WebKit did not accept the private session"
        );
        thread::sleep(Duration::from_millis(25));
    }
    let desktop = app.state::<Desktop>();
    ensure!(
        !desktop.stopping.load(Ordering::Acquire),
        "Athena is quitting"
    );
    *desktop
        .origin
        .lock()
        .map_err(|_| anyhow::anyhow!("Window session unavailable"))? = Some(url.clone());
    window.navigate(url)?;
    Ok(())
}

fn is_workspace(app: &AppHandle, url: &Url) -> bool {
    app.state::<Desktop>().origin.lock().is_ok_and(|allowed| {
        allowed.as_ref().is_some_and(|base| {
            url.origin() == base.origin() && url.username().is_empty() && url.password().is_none()
        })
    })
}

fn is_artifact(path: &str) -> bool {
    let Some(rest) = path.strip_prefix("/api/artifacts/") else {
        return false;
    };
    let Some((conversation, artifact)) = rest.split_once('/') else {
        return false;
    };
    [conversation, artifact].iter().all(|part| {
        !part.is_empty()
            && part
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
    })
}

fn focus(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if let Err(error) = window.unminimize().and_then(|()| window.set_focus()) {
            eprintln!("Could not focus Athena: {error}");
        }
    }
}

fn show_failure(app: &AppHandle, headline: &str, detail: &str) {
    let exit = app.clone();
    let mut dialog = app
        .dialog()
        .message(detail)
        .title(headline)
        .kind(MessageDialogKind::Error);
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.parent(&window);
    }
    dialog.show(move |_| exit.exit(1));
}

fn supervise(app: AppHandle, sidecar: Sidecar) {
    let desktop = app.state::<Desktop>();
    let result = sidecar.run(&desktop.stopping, |notice| match notice {
        Notice::Ready(ready) => show_workspace(&app, ready),
    });
    desktop.stopped.store(true, Ordering::Release);
    if desktop.stopping.load(Ordering::Acquire) {
        app.exit(0);
    } else if let Err(error) = result {
        let stranded = app.clone();
        if let Err(error) = app.run_on_main_thread(move || {
            show_failure(&stranded, "Athena could not continue", &error.to_string());
        }) {
            eprintln!("Could not display the Athena startup error: {error}");
            app.exit(1);
        }
    }
}

fn startup(app: &mut tauri::App) -> Result<()> {
    let main = app.handle().clone();
    let download = app
        .path()
        .download_dir()
        .context("macOS Downloads folder is unavailable")?;
    WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("Athena")
        .inner_size(1340.0, 900.0)
        .min_inner_size(680.0, 480.0)
        .incognito(true)
        .disable_drag_drop_handler()
        .devtools(false)
        .center()
        .on_navigation(move |url| {
            (url.scheme() == "tauri"
                && url.host_str() == Some("localhost")
                && matches!(url.path(), "/" | "/index.html"))
                || (is_workspace(&main, url) && (url.path() == "/" || is_artifact(url.path())))
        })
        .on_new_window(|_, _| NewWindowResponse::Deny)
        .on_download(move |view, event| match event {
            DownloadEvent::Requested { url, destination } => {
                // Only scoped result-file downloads. Wry's macOS delegate
                // supplies a collision-free filename in the user's Downloads.
                is_workspace(view.app_handle(), &url)
                    && is_artifact(url.path())
                    && destination.parent() == Some(Path::new(&download))
            }
            DownloadEvent::Finished { success, .. } => {
                if !success {
                    view.app_handle()
                        .dialog()
                        .message("Athena could not save the result file to Downloads.")
                        .title("Download failed")
                        .kind(MessageDialogKind::Error)
                        .show(|_| {});
                }
                true
            }
            _ => false,
        })
        .build()?;

    let sidecar = Sidecar::from_app(app)?;
    let app = app.handle().clone();
    thread::Builder::new()
        .name("athena-sidecar".into())
        .spawn(move || supervise(app, sidecar))?;
    Ok(())
}

fn wait_for_shutdown(app: &AppHandle, state: &State<'_, Desktop>) {
    if !state.stopping.swap(true, Ordering::AcqRel) {
        let exit = app.clone();
        // Closing stdin is the clean shutdown signal. Bound shutdown even if
        // the backend cannot finish draining its active requests.
        thread::spawn(move || {
            thread::sleep(Duration::from_secs(12));
            exit.state::<Desktop>()
                .stopped
                .store(true, Ordering::Release);
            exit.exit(0);
        });
    }
}

fn main() -> Result<()> {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| focus(app)))
        .plugin(tauri_plugin_dialog::init())
        .manage(Desktop::default())
        .setup(|app| {
            if let Err(error) = startup(app) {
                app.state::<Desktop>()
                    .stopped
                    .store(true, Ordering::Release);
                show_failure(app.handle(), "Athena could not start", &error.to_string());
            }
            Ok(())
        })
        .build(tauri::generate_context!())?;

    app.run(|app, event| match event {
        RunEvent::WindowEvent {
            event: WindowEvent::CloseRequested { api, .. },
            ..
        } => {
            api.prevent_close();
            app.exit(0);
        }
        RunEvent::ExitRequested { api, .. } => {
            let state = app.state::<Desktop>();
            if !state.stopped.load(Ordering::Acquire) {
                api.prevent_exit();
                wait_for_shutdown(app, &state);
            }
        }
        RunEvent::Reopen { .. } => focus(app),
        _ => {}
    });
    Ok(())
}
