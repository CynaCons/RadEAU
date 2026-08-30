//! Runtime catalog state and off-thread ARXML import.
use radeau_catalog::{Catalog, Diagnostic, Severity};
use serde::Serialize;
use std::{path::PathBuf, sync::RwLock};
use tauri::{AppHandle, Emitter, State};

const SOURCE: &str = "embedded:catalog/sensor-fusion.arxml";
const EMBEDDED: &[u8] = include_bytes!("../../catalog/sensor-fusion.arxml");
struct Inner {
    catalog: Catalog,
    loaded: bool,
    source: String,
    kind: String,
    diagnostics: Vec<Diagnostic>,
    last_error: Option<String>,
}
pub struct CatalogState {
    inner: RwLock<Inner>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogModel {
    loaded: bool,
    source: String,
    services: Vec<radeau_catalog::Service>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogImport {
    source: String,
    services: usize,
    signals: usize,
    diagnostics: Vec<Diagnostic>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CatalogEvent {
    loaded: bool,
    service_count: usize,
    signal_count: usize,
    source: String,
    source_kind: String,
    errors: usize,
    warnings: usize,
    last_error: Option<String>,
}

fn counts(c: &Catalog) -> (usize, usize) {
    (
        c.services.len(),
        c.services
            .iter()
            .flat_map(|s| &s.events)
            .map(|e| e.signals.len())
            .sum(),
    )
}
fn embedded() -> Inner {
    match radeau_catalog::from_arxml_bytes(EMBEDDED) {
        Ok((catalog, diagnostics)) => Inner {
            catalog,
            loaded: true,
            source: SOURCE.into(),
            kind: "embedded".into(),
            diagnostics,
            last_error: None,
        },
        Err(e) => Inner {
            catalog: Catalog::default(),
            loaded: false,
            source: SOURCE.into(),
            kind: "embedded".into(),
            diagnostics: vec![],
            last_error: Some(e.to_string()),
        },
    }
}
impl Default for CatalogState {
    fn default() -> Self {
        let mut i = embedded();
        if let Ok(path) = std::env::var("RADEAU_CATALOG") {
            match std::fs::read(&path)
                .map_err(|e| e.to_string())
                .and_then(|b| radeau_catalog::from_arxml_bytes(&b).map_err(|e| e.to_string()))
            {
                Ok((c, d)) => {
                    i.catalog = c;
                    i.source = path;
                    i.kind = "env".into();
                    i.diagnostics = d;
                    i.last_error = None
                }
                Err(e) => i.last_error = Some(format!("RADEAU_CATALOG import failed: {e}")),
            }
        }
        Self {
            inner: RwLock::new(i),
        }
    }
}
impl CatalogState {
    /// Runs `f` with the active catalog borrowed under the read lock — no
    /// clone per call on the dissection path.
    pub fn with_active<R>(&self, f: impl FnOnce(Option<&Catalog>) -> R) -> R {
        match self.inner.read() {
            Ok(i) => f(i.loaded.then_some(&i.catalog)),
            Err(_) => f(None),
        }
    }
    fn model(&self) -> CatalogModel {
        let i = self.inner.read().expect("catalog state poisoned");
        CatalogModel {
            loaded: i.loaded,
            source: i.source.clone(),
            services: i.catalog.services.clone(),
        }
    }
    fn event(&self) -> CatalogEvent {
        let i = self.inner.read().expect("catalog state poisoned");
        let (service_count, signal_count) = counts(&i.catalog);
        CatalogEvent {
            loaded: i.loaded,
            service_count,
            signal_count,
            source: i.source.clone(),
            source_kind: i.kind.clone(),
            errors: i
                .diagnostics
                .iter()
                .filter(|d| d.severity == Severity::Error)
                .count()
                + usize::from(i.last_error.is_some()),
            warnings: i
                .diagnostics
                .iter()
                .filter(|d| d.severity == Severity::Warn)
                .count(),
            last_error: i.last_error.clone(),
        }
    }
    fn emit(&self, app: &AppHandle) {
        let _ = app.emit("catalog:state", self.event());
    }
}
pub fn emit_initial(state: &CatalogState, app: &AppHandle) {
    state.emit(app)
}
#[tauri::command]
pub fn catalog_model(state: State<CatalogState>) -> CatalogModel {
    state.model()
}
#[tauri::command]
pub fn catalog_load(state: State<CatalogState>, app: AppHandle) {
    if let Ok(mut i) = state.inner.write() {
        i.loaded = true
    }
    state.emit(&app)
}
#[tauri::command]
pub fn catalog_unload(state: State<CatalogState>, app: AppHandle) {
    if let Ok(mut i) = state.inner.write() {
        i.loaded = false
    }
    state.emit(&app)
}
async fn import_path(path: PathBuf) -> Result<(Catalog, Vec<Diagnostic>), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
        radeau_catalog::from_arxml_bytes(&bytes).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("catalog import worker failed: {e}"))?
}
#[tauri::command]
pub async fn catalog_import(
    path: String,
    state: State<'_, CatalogState>,
    app: AppHandle,
) -> Result<CatalogImport, String> {
    match import_path(PathBuf::from(&path)).await {
        Ok((catalog, diagnostics)) => {
            let (services, signals) = counts(&catalog);
            let result = CatalogImport {
                source: path.clone(),
                services,
                signals,
                diagnostics: diagnostics.clone(),
            };
            if let Ok(mut i) = state.inner.write() {
                i.catalog = catalog;
                i.loaded = true;
                i.source = path;
                i.kind = "file".into();
                i.diagnostics = diagnostics;
                i.last_error = None
            }
            state.emit(&app);
            Ok(result)
        }
        Err(e) => {
            if let Ok(mut i) = state.inner.write() {
                i.last_error = Some(e.clone())
            }
            state.emit(&app);
            Err(e)
        }
    }
}
#[tauri::command]
pub async fn catalog_reload(
    state: State<'_, CatalogState>,
    app: AppHandle,
) -> Result<CatalogImport, String> {
    let (source, kind) = {
        let i = state.inner.read().map_err(|e| e.to_string())?;
        (i.source.clone(), i.kind.clone())
    };
    if kind == "embedded" {
        match radeau_catalog::from_arxml_bytes(EMBEDDED) {
            Ok((catalog, diagnostics)) => {
                let (services, signals) = counts(&catalog);
                if let Ok(mut i) = state.inner.write() {
                    i.catalog = catalog;
                    i.diagnostics = diagnostics.clone();
                    i.last_error = None
                }
                state.emit(&app);
                Ok(CatalogImport {
                    source,
                    services,
                    signals,
                    diagnostics,
                })
            }
            Err(e) => {
                let e = e.to_string();
                if let Ok(mut i) = state.inner.write() {
                    i.last_error = Some(e.clone())
                }
                state.emit(&app);
                Err(e)
            }
        }
    } else {
        catalog_import(source, state, app).await
    }
}
#[tauri::command]
pub fn catalog_diagnostics(state: State<CatalogState>) -> Vec<Diagnostic> {
    state
        .inner
        .read()
        .map(|i| i.diagnostics.clone())
        .unwrap_or_default()
}
