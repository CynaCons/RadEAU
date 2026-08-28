//! Runtime catalog state. The embedded extract makes packaged builds
//! self-contained; `RADEAU_CATALOG` may point at a replacement extract.

use radeau_catalog::Catalog;
use serde::Serialize;
use std::sync::{Mutex, RwLock};
use tauri::{AppHandle, Emitter, State};

const EMBEDDED: &str = include_str!("../../catalog/sensor-fusion.arxml");

pub struct CatalogState {
    catalog: RwLock<Catalog>,
    loaded: Mutex<bool>,
    source: String,
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
struct CatalogEvent {
    loaded: bool,
    service_count: usize,
}

impl Default for CatalogState {
    fn default() -> Self {
        let (catalog, source) = match std::env::var("RADEAU_CATALOG") {
            Ok(path) => match std::fs::read_to_string(&path)
                .ok()
                .and_then(|xml| radeau_catalog::from_arxml(&xml).ok())
            {
                Some((c, _)) => (c, path),
                None => embedded(),
            },
            Err(_) => embedded(),
        };
        Self {
            catalog: RwLock::new(catalog),
            loaded: Mutex::new(true),
            source,
        }
    }
}
fn embedded() -> (Catalog, String) {
    radeau_catalog::from_arxml(EMBEDDED)
        .map(|(c, _)| (c, "embedded:catalog/sensor-fusion.arxml".into()))
        .unwrap_or_else(|_| {
            (
                Catalog::default(),
                "embedded:catalog/sensor-fusion.arxml (invalid)".into(),
            )
        })
}
impl CatalogState {
    pub fn active_catalog(&self) -> Option<Catalog> {
        if *self.loaded.lock().ok()? {
            self.catalog.read().ok().map(|c| c.clone())
        } else {
            None
        }
    }
    fn model(&self) -> CatalogModel {
        let loaded = self.loaded.lock().map(|v| *v).unwrap_or(false);
        let services = self
            .catalog
            .read()
            .map(|c| c.services.clone())
            .unwrap_or_default();
        CatalogModel {
            loaded,
            source: self.source.clone(),
            services,
        }
    }
    fn set_loaded(&self, value: bool) {
        if let Ok(mut loaded) = self.loaded.lock() {
            *loaded = value
        }
    }
    fn emit(&self, app: &AppHandle) {
        let model = self.model();
        let _ = app.emit(
            "catalog:state",
            CatalogEvent {
                loaded: model.loaded,
                service_count: model.services.len(),
            },
        );
    }
}
pub fn emit_initial(state: &CatalogState, app: &AppHandle) {
    state.emit(app);
}
#[tauri::command]
pub fn catalog_model(state: State<CatalogState>) -> CatalogModel {
    state.model()
}
#[tauri::command]
pub fn catalog_load(state: State<CatalogState>, app: AppHandle) {
    state.set_loaded(true);
    state.emit(&app);
}
#[tauri::command]
pub fn catalog_unload(state: State<CatalogState>, app: AppHandle) {
    state.set_loaded(false);
    state.emit(&app);
}
