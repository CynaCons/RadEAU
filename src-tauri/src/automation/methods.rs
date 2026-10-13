//! Automation method dispatch (AU-003/AU-004).

use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::export::ExportFrom;

type RpcResult = Result<Value, (i64, String)>;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CaptureStartParams {
    source: crate::capture::SourceSpec,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExportJsonlParams {
    path: String,
    from: ExportFrom,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReplayOpenParams {
    path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReplaySeekParams {
    t_ns: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReplaySetSpeedParams {
    speed: Option<f64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TraceFrameParams {
    idx: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TraceAnalyzeParams {
    #[serde(default)]
    from: Option<crate::analysis::AnalysisFrom>,
    #[serde(default)]
    sections: Option<crate::analysis::Sections>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TraceStatsResult {
    session: crate::capture::CaptureStatusDto,
    ring: crate::rows::RingStats,
}

pub fn dispatch(app: &AppHandle, method: &str, params: Option<Value>) -> RpcResult {
    match method {
        "capture_list_sources" => {
            let interfaces = crate::capture::list_interfaces().map_err(domain)?;
            Ok(json!({ "kinds": capture_kinds(), "interfaces": interfaces }))
        }
        "capture_start" => {
            let params: CaptureStartParams = parse(params)?;
            crate::capture::start_session(
                app.state::<crate::capture::CaptureState>().inner(),
                app.clone(),
                params.source,
            )
            .map_err(domain)?;
            Ok(json!({ "started": true }))
        }
        "capture_stop" => {
            crate::capture::stop_session(app.state::<crate::capture::CaptureState>().inner())
                .map_err(domain)?;
            Ok(json!({ "stopped": true }))
        }
        "capture_status" => serde_json::to_value(
            app.state::<crate::capture::CaptureState>()
                .automation_status(),
        )
        .map_err(encode),
        "recording_start" => serde_json::to_value(
            crate::recording::set_recording_armed(
                app.state::<crate::recording::RecordingState>().inner(),
                app.state::<crate::capture::CaptureState>().is_running(),
                app,
                true,
            )
            .map_err(domain)?,
        )
        .map_err(encode),
        "recording_stop" => serde_json::to_value(
            crate::recording::set_recording_armed(
                app.state::<crate::recording::RecordingState>().inner(),
                app.state::<crate::capture::CaptureState>().is_running(),
                app,
                false,
            )
            .map_err(domain)?,
        )
        .map_err(encode),
        "recording_status" => {
            serde_json::to_value(app.state::<crate::recording::RecordingState>().snapshot())
                .map_err(encode)
        }
        "recording_list" => serde_json::to_value(crate::recording::list_recordings(
            app.state::<crate::recording::RecordingState>().inner(),
        ))
        .map_err(encode),
        "export_jsonl" => {
            let params: ExportJsonlParams = parse(params)?;
            let catalog = app.state::<crate::catalog::CatalogState>();
            let capture = app.state::<crate::capture::CaptureState>();
            serde_json::to_value(
                catalog
                    .with_active(|active| {
                        crate::export::export_jsonl_for_automation(
                            params.path,
                            params.from,
                            capture.inner(),
                            active,
                        )
                    })
                    .map_err(domain)?,
            )
            .map_err(encode)
        }
        "replay_open" => {
            let params: ReplayOpenParams = parse(params)?;
            serde_json::to_value(
                crate::replay::replay_open_blocking(
                    app.state::<crate::replay::ReplayState>().inner(),
                    app,
                    params.path,
                )
                .map_err(domain)?,
            )
            .map_err(encode)
        }
        "replay_play" => serde_json::to_value(
            crate::replay::replay_play_inner(
                app.state::<crate::replay::ReplayState>().inner(),
                app.state::<crate::capture::CaptureState>().inner(),
                app,
            )
            .map_err(domain)?,
        )
        .map_err(encode),
        "replay_pause" => serde_json::to_value(
            crate::replay::replay_pause_inner(
                app.state::<crate::replay::ReplayState>().inner(),
                app,
            )
            .map_err(domain)?,
        )
        .map_err(encode),
        "replay_step" => serde_json::to_value(
            crate::replay::replay_step_inner(
                app.state::<crate::replay::ReplayState>().inner(),
                app,
            )
            .map_err(domain)?,
        )
        .map_err(encode),
        "replay_seek" => {
            let params: ReplaySeekParams = parse(params)?;
            serde_json::to_value(
                crate::replay::replay_seek_inner(
                    app.state::<crate::replay::ReplayState>().inner(),
                    app,
                    params.t_ns,
                )
                .map_err(domain)?,
            )
            .map_err(encode)
        }
        "replay_set_speed" => {
            let params: ReplaySetSpeedParams = parse(params)?;
            serde_json::to_value(
                crate::replay::replay_set_speed_inner(
                    app.state::<crate::replay::ReplayState>().inner(),
                    app,
                    params.speed,
                )
                .map_err(domain)?,
            )
            .map_err(encode)
        }
        "replay_status" => serde_json::to_value(
            app.state::<crate::replay::ReplayState>()
                .automation_status(),
        )
        .map_err(encode),
        // AU-006: the same dissection the UI's frame_detail returns.
        "trace_frame" => {
            let params: TraceFrameParams = parse(params)?;
            let catalog = app.state::<crate::catalog::CatalogState>();
            let capture = app.state::<crate::capture::CaptureState>();
            serde_json::to_value(
                catalog
                    .with_active(|active| capture.frame_detail(params.idx, active))
                    .map_err(domain)?,
            )
            .map_err(encode)
        }
        "trace_query" => {
            let query: crate::rows::TraceQuery = parse(params)?;
            if query.limit.is_some_and(|limit| !(1..=500).contains(&limit)) {
                return Err((-32602, "limit must be 1..=500".into()));
            }
            serde_json::to_value(
                crate::rows::trace_query(
                    app.state::<crate::capture::CaptureState>().inner(),
                    &query,
                )
                .map_err(invalid_trace_params)?,
            )
            .map_err(encode)
        }
        "trace_stats" => serde_json::to_value(TraceStatsResult {
            session: app
                .state::<crate::capture::CaptureState>()
                .automation_status(),
            ring: crate::rows::trace_stats_ring(
                app.state::<crate::capture::CaptureState>().inner(),
            ),
        })
        .map_err(encode),
        // AN-007: trace_analyze / service_summary / timing_report.
        "trace_analyze" => {
            let params: TraceAnalyzeParams = parse(params)?;
            let catalog = app.state::<crate::catalog::CatalogState>();
            let capture = app.state::<crate::capture::CaptureState>();
            serde_json::to_value(
                catalog
                    .with_active(|active| {
                        crate::analysis::analyze(
                            capture.inner(),
                            &params.from.unwrap_or(crate::analysis::AnalysisFrom::Ring),
                            &params.sections.unwrap_or_default(),
                            active,
                        )
                    })
                    .map_err(domain)?,
            )
            .map_err(encode)
        }
        "service_summary" => {
            let params: crate::analysis::ServiceSummaryParams = parse(params)?;
            let catalog = app.state::<crate::catalog::CatalogState>();
            let capture = app.state::<crate::capture::CaptureState>();
            serde_json::to_value(
                catalog
                    .with_active(|active| {
                        crate::analysis::service_summary(capture.inner(), params, active)
                    })
                    .map_err(domain)?,
            )
            .map_err(encode)
        }
        "timing_report" => {
            let params: crate::analysis::TimingReportParams = parse(params)?;
            let catalog = app.state::<crate::catalog::CatalogState>();
            let capture = app.state::<crate::capture::CaptureState>();
            serde_json::to_value(
                catalog
                    .with_active(|active| {
                        crate::analysis::timing_report(capture.inner(), params, active)
                    })
                    .map_err(domain)?,
            )
            .map_err(encode)
        }
        _ => Err((-32601, "unknown method".into())),
    }
}

fn parse<T: DeserializeOwned>(params: Option<Value>) -> Result<T, (i64, String)> {
    serde_json::from_value(params.unwrap_or_else(|| json!({}))).map_err(|error| {
        let message = error.to_string();
        (-32602, message)
    })
}

fn domain(error: String) -> (i64, String) {
    (-32000, error)
}

fn encode(error: serde_json::Error) -> (i64, String) {
    (-32000, error.to_string())
}

fn invalid_trace_params(error: String) -> (i64, String) {
    if error.contains("limit") || error.contains("dir") {
        (-32602, error)
    } else {
        domain(error)
    }
}

fn capture_kinds() -> Vec<&'static str> {
    let mut kinds = vec!["sim", "pcap", "pcapStream", "live"];
    #[cfg(debug_assertions)]
    kinds.push("devgen");
    kinds
}
