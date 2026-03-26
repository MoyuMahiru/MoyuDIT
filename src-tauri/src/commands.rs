use chrono::{DateTime, Local, LocalResult, NaiveDate, NaiveDateTime, TimeZone};
use base64::Engine;
use fs4::available_space;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::env;
use std::ffi::OsStr;
use std::fs::{self, File};
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::sync::Mutex;
use tauri::{async_runtime, Emitter, State, Window};
use thiserror::Error;
use walkdir::WalkDir;

const SUPPORTED_EXTENSIONS: &[&str] = &[
    "3fr", "arw", "cr2", "cr3", "dng", "erf", "gif", "heic", "jpeg", "jpg", "kdc", "mef",
    "mos", "mrw", "nef", "nrw", "orf", "pef", "png", "raf", "raw", "rw2", "sr2", "srf",
    "tif", "tiff",
];

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardScanRequest {
    pub root: PathBuf,
    pub recursive: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectSourceEntry {
    pub label: String,
    pub root_path: String,
    pub file_count: usize,
    pub formats: Vec<String>,
    pub source_kind: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreviewRequest {
    pub source_root: PathBuf,
    pub target_root: PathBuf,
    pub backup_target_root: Option<PathBuf>,
    pub path_template: String,
    pub filename_template: String,
    pub min_rating: u8,
    pub media_selection: MediaSelection,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
    pub recursive: bool,
    pub selected_files: Option<Vec<SelectedImportFile>>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ImportRunRequest {
    pub source_root: PathBuf,
    pub target_root: PathBuf,
    pub backup_target_root: Option<PathBuf>,
    pub path_template: String,
    pub filename_template: String,
    pub min_rating: u8,
    pub media_selection: MediaSelection,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
    pub recursive: bool,
    pub verify_mode: VerifyMode,
    pub duplicate_strategy: DuplicateStrategy,
    pub write_xmp: bool,
    pub selected_files: Option<Vec<SelectedImportFile>>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SelectedImportFile {
    pub source_path: String,
    pub rating: u8,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MediaEntry {
    pub filename: String,
    pub source_path: String,
    pub shot_at: Option<DateTime<Local>>,
    pub camera: Option<String>,
    pub rating: Option<u8>,
    pub size_bytes: u64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewEntry {
    pub filename: String,
    pub source_path: String,
    pub target_path: String,
    pub exists: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub imported: usize,
    pub skipped: usize,
    pub failed: usize,
    pub verified: usize,
    pub renamed: usize,
    pub cancelled: bool,
    pub failure_details: Vec<ImportFailureDetail>,
    pub renamed_details: Vec<ImportRenameDetail>,
    pub skipped_details: Vec<ImportSkipDetail>,
    pub primary_target_root: String,
    pub backup_target_root: Option<String>,
    pub duplicate_warning: Option<DuplicateImportWarning>,
    pub started_at: DateTime<Local>,
    pub finished_at: DateTime<Local>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportImportReportRequest {
    pub path: PathBuf,
    pub report: Value,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SpaceCheckRequest {
    pub source_root: PathBuf,
    pub target_root: PathBuf,
    pub backup_target_root: Option<PathBuf>,
    pub min_rating: u8,
    pub media_selection: MediaSelection,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
    pub recursive: bool,
    pub selected_files: Option<Vec<SelectedImportFile>>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SpaceCheckTarget {
    pub path: String,
    pub required_bytes: u64,
    pub available_bytes: u64,
    pub enough: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SpaceCheckResult {
    pub planned_files: usize,
    pub total_bytes: u64,
    pub primary: SpaceCheckTarget,
    pub backup: Option<SpaceCheckTarget>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ImportProgressEvent {
    pub stage: String,
    pub current_file: Option<String>,
    pub processed: usize,
    pub total: usize,
    pub imported: usize,
    pub skipped: usize,
    pub failed: usize,
    pub progress: u8,
    pub message: String,
    pub latest_error: Option<ImportFailureDetail>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ImportFailureDetail {
    pub filename: String,
    pub source_path: String,
    pub category: String,
    pub reason: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ImportRenameDetail {
    pub filename: String,
    pub source_path: String,
    pub target_path: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ImportSkipDetail {
    pub filename: String,
    pub source_path: String,
    pub target_path: String,
    pub reason: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ImportHistoryEntry {
    pub id: String,
    pub source_root: String,
    pub source_fingerprint: String,
    pub source_label: String,
    pub target_root: String,
    pub backup_target_root: Option<String>,
    pub imported: usize,
    pub skipped: usize,
    pub failed: usize,
    pub verified: usize,
    pub started_at: DateTime<Local>,
    pub finished_at: DateTime<Local>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateImportWarning {
    pub source_fingerprint: String,
    pub source_label: String,
    pub latest_import_at: DateTime<Local>,
    pub latest_target_root: String,
    pub latest_backup_target_root: Option<String>,
    pub times_imported: usize,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PendingImportResume {
    pub id: String,
    pub source_root: String,
    pub source_label: String,
    pub target_root: String,
    pub backup_target_root: Option<String>,
    pub total: usize,
    pub remaining: usize,
    pub imported: usize,
    pub skipped: usize,
    pub failed: usize,
    pub last_processed_file: Option<String>,
    pub remaining_raw: usize,
    pub remaining_jpeg: usize,
    pub top_failure_category: Option<String>,
    pub remaining_files: Vec<String>,
    pub started_at: DateTime<Local>,
    pub updated_at: DateTime<Local>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DetectSourcesProgressEvent {
    pub stage: String,
    pub current_item: Option<String>,
    pub processed: usize,
    pub total: usize,
    pub found: usize,
    pub progress: u8,
    pub message: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ScanProgressEvent {
    pub stage: String,
    pub current_item: Option<String>,
    pub processed: usize,
    pub total: usize,
    pub progress: u8,
    pub message: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub enum VerifyMode {
    Md5,
    Blake3,
}

#[derive(Debug, Serialize, Deserialize, Clone, Copy)]
#[serde(rename_all = "kebab-case")]
pub enum DuplicateStrategy {
    Skip,
    Rename,
    KeepBoth,
}

#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum MediaSelection {
    All,
    Raw,
    Jpeg,
    Paired,
}

#[derive(Debug, Clone)]
struct ScannedFile {
    path: PathBuf,
    filename: String,
    shot_at: DateTime<Local>,
    camera: Option<String>,
    rating: Option<u8>,
    size_bytes: u64,
}

#[derive(Debug, Default, Clone)]
struct ExternalMetadata {
    shot_at: Option<DateTime<Local>>,
    camera: Option<String>,
    rating: Option<u8>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct MetadataCacheEntry {
    source_path: String,
    modified_millis: i64,
    size_bytes: u64,
    shot_at: Option<DateTime<Local>>,
    camera: Option<String>,
    rating: Option<u8>,
    updated_at: DateTime<Local>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PendingImportState {
    id: String,
    request: ImportRunRequest,
    source_label: String,
    total: usize,
    remaining_files: Vec<SelectedImportFile>,
    imported: usize,
    skipped: usize,
    failed: usize,
    last_processed_file: Option<String>,
    failure_categories: HashMap<String, usize>,
    started_at: DateTime<Local>,
    updated_at: DateTime<Local>,
}

pub struct ImportCancellationState(pub Arc<AtomicBool>);
pub struct ScanCacheState(Arc<Mutex<HashMap<String, Vec<ScannedFile>>>>);

impl ScanCacheState {
    pub fn new() -> Self {
        Self(Arc::new(Mutex::new(HashMap::new())))
    }
}

#[derive(Debug, Error)]
pub enum CommandError {
    #[error("source path does not exist: {0}")]
    MissingPath(String),
    #[error("I/O error: {0}")]
    Io(String),
    #[error("hash verification failed for {0}")]
    HashMismatch(String),
}

impl Serialize for CommandError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

impl From<std::io::Error> for CommandError {
    fn from(value: std::io::Error) -> Self {
        Self::Io(value.to_string())
    }
}

#[tauri::command]
pub fn detect_sources(window: Window) -> Result<Vec<DetectSourceEntry>, CommandError> {
    let mut entries = Vec::new();
    let candidates = candidate_source_roots();
    let total = candidates.len();

    emit_detect_sources_progress(
        &window,
        DetectSourcesProgressEvent {
            stage: "started".to_string(),
            current_item: None,
            processed: 0,
            total,
            found: 0,
            progress: progress_percent(0, total),
            message: if total == 0 {
                "没有找到可检查的来源目录。".to_string()
            } else {
                format!("准备检查 {total} 个可能的来源。")
            },
        },
    );

    for (index, candidate) in candidates.iter().enumerate() {
        emit_detect_sources_progress(
            &window,
            DetectSourcesProgressEvent {
                stage: "processing".to_string(),
                current_item: Some(candidate.display().to_string()),
                processed: index,
                total,
                found: entries.len(),
                progress: progress_percent(index, total),
                message: format!("正在检查 {}", candidate.display()),
            },
        );

        if let Some(entry) = inspect_source_candidate(&candidate) {
            entries.push(entry);
        }

        let processed = index + 1;
        emit_detect_sources_progress(
            &window,
            DetectSourcesProgressEvent {
                stage: "processing".to_string(),
                current_item: Some(candidate.display().to_string()),
                processed,
                total,
                found: entries.len(),
                progress: progress_percent(processed, total),
                message: format!("已检查 {processed}/{total}，发现 {} 个可导入来源。", entries.len()),
            },
        );
    }

    entries.sort_by(|left, right| {
        right
            .file_count
            .cmp(&left.file_count)
            .then_with(|| left.label.cmp(&right.label))
    });
    entries.dedup_by(|left, right| left.root_path == right.root_path);

    emit_detect_sources_progress(
        &window,
        DetectSourcesProgressEvent {
            stage: "finished".to_string(),
            current_item: None,
            processed: total,
            total,
            found: entries.len(),
            progress: progress_percent(total, total),
            message: format!("来源检查完成，发现 {} 个可导入来源。", entries.len()),
        },
    );

    Ok(entries)
}

#[tauri::command]
pub async fn scan_card(
    window: Window,
    request: CardScanRequest,
    cache_state: State<'_, ScanCacheState>,
) -> Result<Vec<MediaEntry>, CommandError> {
    let root = request.root.clone();
    let recursive = request.recursive;
    let files = async_runtime::spawn_blocking(move || {
        scan_media_entries_with_progress(&window, &request.root, request.recursive)
    })
    .await
    .map_err(|error| CommandError::Io(format!("scan task failed: {error}")))??;

    store_scan_cache(&cache_state.0, &root, recursive, files.clone());

    Ok(files
        .into_iter()
        .map(|file| MediaEntry {
            filename: file.filename,
            source_path: file.path.display().to_string(),
            shot_at: Some(file.shot_at),
            camera: file.camera,
            rating: file.rating,
            size_bytes: file.size_bytes,
        })
        .collect())
}

#[tauri::command]
pub async fn preview_import(
    cache_state: State<'_, ScanCacheState>,
    request: ImportPreviewRequest,
) -> Result<Vec<PreviewEntry>, CommandError> {
    let cache = cache_state.0.clone();
    async_runtime::spawn_blocking(move || {
        let files = get_cached_or_scan(&cache, &request.source_root, request.recursive)?;
        let entries = resolve_import_candidates(
            files,
            request.min_rating,
            request.media_selection,
            request.start_date.as_deref(),
            request.end_date.as_deref(),
            request.selected_files.as_deref(),
        )
            .into_iter()
            .map(|file| {
                let relative = build_target_relative_path(&file, &request.path_template);
                let target_name = build_target_filename(&file, &request.filename_template);
                let target = request.target_root.join(relative).join(&target_name);
                PreviewEntry {
                    filename: target_name,
                    source_path: file.path.display().to_string(),
                    target_path: target.display().to_string(),
                    exists: target.exists(),
                }
            })
            .collect();
        Ok(entries)
    })
    .await
    .map_err(|error| CommandError::Io(format!("preview task failed: {error}")))?
}

#[tauri::command]
pub fn get_import_history() -> Result<Vec<ImportHistoryEntry>, CommandError> {
    read_import_history()
}

#[tauri::command]
pub fn get_pending_import_resume() -> Result<Option<PendingImportResume>, CommandError> {
    Ok(read_pending_import_state()?.map(|state| {
        let remaining_raw = state
            .remaining_files
            .iter()
            .filter(|file| is_raw_file(Path::new(&file.source_path)))
            .count();
        let remaining_jpeg = state
            .remaining_files
            .iter()
            .filter(|file| is_jpeg_file(Path::new(&file.source_path)))
            .count();
        let top_failure_category = state
            .failure_categories
            .iter()
            .max_by_key(|(_, count)| *count)
            .map(|(category, _)| category.clone());

        PendingImportResume {
            id: state.id,
            source_root: state.request.source_root.display().to_string(),
            source_label: state.source_label,
            target_root: state.request.target_root.display().to_string(),
            backup_target_root: state
                .request
                .backup_target_root
                .as_ref()
                .map(|path| path.display().to_string()),
            total: state.total,
            remaining: state.remaining_files.len(),
            imported: state.imported,
            skipped: state.skipped,
            failed: state.failed,
            last_processed_file: state.last_processed_file,
            remaining_raw,
            remaining_jpeg,
            top_failure_category,
            remaining_files: state
                .remaining_files
                .iter()
                .take(8)
                .map(|file| {
                    Path::new(&file.source_path)
                        .file_name()
                        .and_then(OsStr::to_str)
                        .unwrap_or(&file.source_path)
                        .to_string()
                })
                .collect(),
            started_at: state.started_at,
            updated_at: state.updated_at,
        }
    }))
}

#[tauri::command]
pub fn dismiss_pending_import_resume() -> Result<(), CommandError> {
    clear_pending_import_state()
}

#[tauri::command]
pub fn get_duplicate_import_warning(
    source_root: String,
) -> Result<Option<DuplicateImportWarning>, CommandError> {
    let history = read_import_history()?;
    let fingerprint = source_fingerprint_from_root(Path::new(&source_root));
    Ok(build_duplicate_warning(&history, &fingerprint))
}

#[tauri::command]
pub async fn open_in_file_manager(path: String) -> Result<(), CommandError> {
    async_runtime::spawn_blocking(move || open_path_in_file_manager(Path::new(&path).to_path_buf()))
        .await
        .map_err(|error| CommandError::Io(format!("open path task failed: {error}")))?
}

#[tauri::command]
pub async fn export_import_report(request: ExportImportReportRequest) -> Result<(), CommandError> {
    async_runtime::spawn_blocking(move || write_import_report(request.path, request.report))
        .await
        .map_err(|error| CommandError::Io(format!("export report task failed: {error}")))?
}

#[tauri::command]
pub async fn check_target_space(
    cache_state: State<'_, ScanCacheState>,
    request: SpaceCheckRequest,
) -> Result<SpaceCheckResult, CommandError> {
    let cache = cache_state.0.clone();
    async_runtime::spawn_blocking(move || check_target_space_blocking(&cache, request))
        .await
        .map_err(|error| CommandError::Io(format!("space check task failed: {error}")))?
}

#[tauri::command]
pub async fn load_media_preview(path: String) -> Result<String, CommandError> {
    async_runtime::spawn_blocking(move || build_media_preview_data_url(PathBuf::from(path)))
        .await
        .map_err(|error| CommandError::Io(format!("load preview task failed: {error}")))?
}

#[tauri::command]
pub async fn run_import(
    window: Window,
    request: ImportRunRequest,
    cancel_state: State<'_, ImportCancellationState>,
    cache_state: State<'_, ScanCacheState>,
) -> Result<ImportResult, CommandError> {
    cancel_state.0.store(false, Ordering::SeqCst);
    let cancel_flag = cancel_state.0.clone();
    let cache = cache_state.0.clone();
    async_runtime::spawn_blocking(move || {
        run_import_blocking(&window, &cache, request, cancel_flag, None, None, None)
    })
        .await
        .map_err(|error| CommandError::Io(format!("import task failed: {error}")))?
}

#[tauri::command]
pub fn cancel_import(cancel_state: State<'_, ImportCancellationState>) {
    cancel_state.0.store(true, Ordering::SeqCst);
}

#[tauri::command]
pub async fn resume_pending_import(
    window: Window,
    cancel_state: State<'_, ImportCancellationState>,
    cache_state: State<'_, ScanCacheState>,
) -> Result<ImportResult, CommandError> {
    cancel_state.0.store(false, Ordering::SeqCst);
    let cancel_flag = cancel_state.0.clone();
    let cache = cache_state.0.clone();
    async_runtime::spawn_blocking(move || {
        let state = read_pending_import_state()?
            .ok_or_else(|| CommandError::Io("没有可恢复的导入任务。".to_string()))?;
        run_import_blocking(
            &window,
            &cache,
            state.request,
            cancel_flag,
            Some(state.id),
            Some(state.started_at),
            Some((
                state.total,
                state.imported,
                state.skipped,
                state.failed,
                state.source_label,
            )),
        )
    })
    .await
    .map_err(|error| CommandError::Io(format!("resume import task failed: {error}")))?
}

fn run_import_blocking(
    window: &Window,
    cache_state: &Arc<Mutex<HashMap<String, Vec<ScannedFile>>>>,
    request: ImportRunRequest,
    cancel_flag: Arc<AtomicBool>,
    pending_state_id: Option<String>,
    started_at_override: Option<DateTime<Local>>,
    resume_stats: Option<(usize, usize, usize, usize, String)>,
) -> Result<ImportResult, CommandError> {
    let started_at = started_at_override.unwrap_or_else(Local::now);
    let files = get_cached_or_scan(cache_state, &request.source_root, request.recursive)?;
    let candidates = resolve_import_candidates(
        files,
        request.min_rating,
        request.media_selection,
        request.start_date.as_deref(),
        request.end_date.as_deref(),
        request.selected_files.as_deref(),
    );
    let source_fingerprint = source_fingerprint_from_root(&request.source_root);
    let source_label = resume_stats
        .as_ref()
        .map(|(_, _, _, _, source_label)| source_label.clone())
        .unwrap_or_else(|| source_label_from_root(&request.source_root));
    let history_before = read_import_history().unwrap_or_default();
    let duplicate_warning = build_duplicate_warning(&history_before, &source_fingerprint);
    let total = resume_stats.as_ref().map(|(total, _, _, _, _)| *total).unwrap_or(candidates.len());
    let mut imported = resume_stats.as_ref().map(|(_, imported, _, _, _)| *imported).unwrap_or(0);
    let mut skipped = resume_stats.as_ref().map(|(_, _, skipped, _, _)| *skipped).unwrap_or(0);
    let mut failed = resume_stats.as_ref().map(|(_, _, _, failed, _)| *failed).unwrap_or(0);
    let mut verified = 0usize;
    let mut renamed = 0usize;
    let mut cancelled = false;
    let mut failure_details = Vec::<ImportFailureDetail>::new();
    let mut renamed_details = Vec::<ImportRenameDetail>::new();
    let mut skipped_details = Vec::<ImportSkipDetail>::new();
    let state_id = pending_state_id.unwrap_or_else(|| format!("resume-{}", started_at.timestamp_millis()));

    write_pending_import_state(PendingImportState {
        id: state_id.clone(),
        request: request.clone(),
        source_label: source_label.clone(),
        total,
        remaining_files: candidates
            .iter()
            .map(|file| SelectedImportFile {
                source_path: file.path.display().to_string(),
                rating: file.rating.unwrap_or(0),
            })
            .collect(),
        imported,
        skipped,
        failed,
        last_processed_file: None,
        failure_categories: HashMap::new(),
        started_at,
        updated_at: Local::now(),
    })?;

    emit_import_progress(
        &window,
        ImportProgressEvent {
            stage: "started".to_string(),
            current_file: None,
            processed: imported + skipped + failed,
            total,
            imported,
            skipped,
            failed,
            progress: progress_percent(imported + skipped + failed, total),
            message: if total == 0 {
                "没有符合当前导入规则的文件。".to_string()
            } else {
                format!("准备导入剩余 {} / {total} 个文件。", candidates.len())
            },
            latest_error: None,
        },
    );

    for (index, file) in candidates.iter().enumerate() {
        if cancel_flag.load(Ordering::SeqCst) {
            cancelled = true;
            emit_import_progress(
                window,
                ImportProgressEvent {
                    stage: "finished".to_string(),
                    current_file: None,
                    processed: index,
                    total,
                    imported,
                    skipped,
                    failed,
                    progress: progress_percent(index, total),
                    message: format!("导入已取消，已完成 {index}/{total}。"),
                    latest_error: failure_details.last().cloned(),
                },
            );
            break;
        }

        let relative_dir = build_target_relative_path(&file, &request.path_template);
        let target_name = build_target_filename(file, &request.filename_template);
        let preferred = request.target_root.join(&relative_dir).join(&target_name);
        let backup_preferred = request
            .backup_target_root
            .as_ref()
            .map(|root| root.join(&relative_dir).join(&target_name));

        emit_import_progress(
            &window,
            ImportProgressEvent {
                stage: "processing".to_string(),
                current_file: Some(file.filename.clone()),
                processed: index,
                total,
                imported,
                skipped,
                failed,
                progress: progress_percent(index, total),
                message: format!("正在处理 {}", file.filename),
                latest_error: None,
            },
        );

        let result = import_file_to_destinations(
            &file.path,
            &preferred,
            backup_preferred.as_deref(),
            request.duplicate_strategy,
            request.verify_mode,
        );

        match result {
            Ok(outcome) => {
                if request.write_xmp {
                    let rating = file.rating.unwrap_or(0);
                    let _ = write_rating_to_targets(&outcome.written_paths, rating);
                }

                renamed += outcome.renamed_paths.len();
                renamed_details.extend(outcome.renamed_paths.iter().map(|path| ImportRenameDetail {
                    filename: file.filename.clone(),
                    source_path: file.path.display().to_string(),
                    target_path: path.display().to_string(),
                }));
                skipped_details.extend(outcome.skipped_targets.iter().map(|(path, reason)| {
                    ImportSkipDetail {
                        filename: file.filename.clone(),
                        source_path: file.path.display().to_string(),
                        target_path: path.display().to_string(),
                        reason: reason.clone(),
                    }
                }));

                match outcome.status {
                    ImportFileStatus::Imported => {
                        imported += 1;
                        verified += 1;
                    }
                    ImportFileStatus::Skipped => skipped += 1,
                }
            }
            Err(error) => {
                failed += 1;
                let detail = ImportFailureDetail {
                    filename: file.filename.clone(),
                    source_path: file.path.display().to_string(),
                    category: error_category(&error).to_string(),
                    reason: localize_error_reason(&error),
                };
                failure_details.push(detail.clone());
                emit_import_progress(
                    &window,
                    ImportProgressEvent {
                        stage: "processing".to_string(),
                        current_file: Some(file.filename.clone()),
                        processed: index,
                        total,
                        imported,
                        skipped,
                        failed,
                        progress: progress_percent(index, total),
                        message: format!("导入失败：{} - {}", file.filename, detail.reason),
                        latest_error: Some(detail),
                    },
                );
            }
        }

        update_pending_import_progress(
            &state_id,
            file,
            imported,
            skipped,
            failed,
            failure_details.last().map(|detail| detail.category.as_str()),
        )?;

        let processed = index + 1;
        emit_import_progress(
            &window,
            ImportProgressEvent {
                stage: "processing".to_string(),
                current_file: Some(file.filename.clone()),
                processed,
                total,
                imported,
                skipped,
                failed,
                progress: progress_percent(processed, total),
                message: format!(
                    "已完成 {processed}/{total}，成功 {imported}，跳过 {skipped}，失败 {failed}"
                ),
                latest_error: failure_details.last().cloned(),
            },
        );
    }

    let finished_at = Local::now();
    let history_entry = ImportHistoryEntry {
        id: format!("{}-{}", finished_at.timestamp_millis(), source_fingerprint),
        source_root: request.source_root.display().to_string(),
        source_fingerprint: source_fingerprint.clone(),
        source_label,
        target_root: request.target_root.display().to_string(),
        backup_target_root: request
            .backup_target_root
            .as_ref()
            .map(|path| path.display().to_string()),
        imported,
        skipped,
        failed,
        verified,
        started_at,
        finished_at,
    };
    let _ = append_import_history(history_entry);
    if cancelled {
        let _ = touch_pending_import_state(&state_id, imported, skipped, failed);
    } else {
        let _ = clear_pending_import_state();
    }

    emit_import_progress(
        &window,
        ImportProgressEvent {
            stage: "finished".to_string(),
            current_file: None,
            processed: imported + skipped + failed,
            total,
            imported,
            skipped,
            failed,
            progress: progress_percent(imported + skipped + failed, total),
            message: if cancelled {
                format!("导入已取消，成功 {imported}，跳过 {skipped}，失败 {failed}")
            } else {
                format!("导入结束，成功 {imported}，跳过 {skipped}，失败 {failed}")
            },
            latest_error: failure_details.last().cloned(),
        },
    );

    Ok(ImportResult {
        imported,
        skipped,
        failed,
        verified,
        renamed,
        cancelled,
        failure_details,
        renamed_details,
        skipped_details,
        primary_target_root: request.target_root.display().to_string(),
        backup_target_root: request
            .backup_target_root
            .as_ref()
            .map(|path| path.display().to_string()),
        duplicate_warning,
        started_at,
        finished_at,
    })
}

fn emit_import_progress(window: &Window, event: ImportProgressEvent) {
    let _ = window.emit("import-progress", event);
}

fn emit_detect_sources_progress(window: &Window, event: DetectSourcesProgressEvent) {
    let _ = window.emit("detect-sources-progress", event);
}

fn emit_scan_progress(window: &Window, event: ScanProgressEvent) {
    let _ = window.emit("scan-progress", event);
}

fn file_matches_filters(
    file: &ScannedFile,
    min_rating: u8,
    start_date: Option<&str>,
    end_date: Option<&str>,
) -> bool {
    if file.rating.unwrap_or(0) < min_rating {
        return false;
    }

    let shot_date = file.shot_at.date_naive();
    if let Some(start) = parse_filter_date(start_date) {
        if shot_date < start {
            return false;
        }
    }

    if let Some(end) = parse_filter_date(end_date) {
        if shot_date > end {
            return false;
        }
    }

    true
}

fn filter_files_for_import(
    files: Vec<ScannedFile>,
    min_rating: u8,
    media_selection: MediaSelection,
    start_date: Option<&str>,
    end_date: Option<&str>,
) -> Vec<ScannedFile> {
    let filtered: Vec<ScannedFile> = files
        .into_iter()
        .filter(|file| file_matches_filters(file, min_rating, start_date, end_date))
        .collect();

    match media_selection {
        MediaSelection::All => return filtered,
        MediaSelection::Raw => {
            return filtered
                .into_iter()
                .filter(|file| is_raw_file(&file.path))
                .collect()
        }
        MediaSelection::Jpeg => {
            return filtered
                .into_iter()
                .filter(|file| is_jpeg_file(&file.path))
                .collect()
        }
        MediaSelection::Paired => {}
    }

    let mut pair_state = HashMap::<String, (bool, bool)>::new();
    for file in &filtered {
        let entry = pair_state
            .entry(import_group_key(&file.path))
            .or_insert((false, false));
        if is_raw_file(&file.path) {
            entry.0 = true;
        }
        if is_jpeg_file(&file.path) {
            entry.1 = true;
        }
    }

    filtered
        .into_iter()
        .filter(|file| {
            pair_state
                .get(&import_group_key(&file.path))
                .map(|(has_raw, has_jpeg)| *has_raw && *has_jpeg)
                .unwrap_or(false)
        })
        .collect()
}

fn resolve_import_candidates(
    files: Vec<ScannedFile>,
    min_rating: u8,
    media_selection: MediaSelection,
    start_date: Option<&str>,
    end_date: Option<&str>,
    selected_files: Option<&[SelectedImportFile]>,
) -> Vec<ScannedFile> {
    if let Some(selected_files) = selected_files {
        let ratings_by_path: HashMap<&str, u8> = selected_files
            .iter()
            .map(|file| (file.source_path.as_str(), file.rating.min(5)))
            .collect();

        let mut selected: Vec<ScannedFile> = files
            .into_iter()
            .filter_map(|mut file| {
                let rating = ratings_by_path.get(file.path.to_string_lossy().as_ref())?;
                file.rating = Some(*rating);
                Some(file)
            })
            .collect();
        selected.sort_by(|left, right| {
            left.shot_at
                .cmp(&right.shot_at)
                .then_with(|| left.filename.cmp(&right.filename))
        });
        return selected;
    }

    filter_files_for_import(files, min_rating, media_selection, start_date, end_date)
}

fn import_group_key(path: &Path) -> String {
    let directory = path
        .parent()
        .map(|parent| parent.display().to_string().replace('\\', "/"))
        .unwrap_or_default();
    let stem = path
        .file_stem()
        .and_then(OsStr::to_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    format!("{directory}::{stem}")
}

fn parse_filter_date(value: Option<&str>) -> Option<NaiveDate> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .and_then(|value| NaiveDate::parse_from_str(value, "%Y-%m-%d").ok())
}

fn progress_percent(processed: usize, total: usize) -> u8 {
    if total == 0 {
        100
    } else {
        ((processed.saturating_mul(100)) / total).min(100) as u8
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ImportFileStatus {
    Imported,
    Skipped,
}

#[derive(Debug, Clone)]
struct ImportFileOutcome {
    status: ImportFileStatus,
    written_paths: Vec<PathBuf>,
    renamed_paths: Vec<PathBuf>,
    skipped_targets: Vec<(PathBuf, String)>,
}

fn localize_error_reason(error: &CommandError) -> String {
    match error {
        CommandError::MissingPath(path) => format!("源文件不存在：{path}"),
        CommandError::HashMismatch(path) => format!("文件校验失败：{path}"),
        CommandError::Io(message) => {
            if message.starts_with("主目录导入失败：") || message.starts_with("备份目录导入失败：") {
                return message.clone();
            }
            let lower = message.to_ascii_lowercase();
            if lower.contains("permission denied") {
                "权限不足，无法写入目标目录。".to_string()
            } else if lower.contains("no space left on device") {
                "目标磁盘空间不足。".to_string()
            } else if lower.contains("read-only file system") {
                "目标目录是只读的，无法完成导入。".to_string()
            } else if lower.contains("file exists") {
                "目标文件已存在，当前策略未能覆盖。".to_string()
            } else {
                format!("文件读写失败：{message}")
            }
        }
    }
}

fn error_category(error: &CommandError) -> &'static str {
    match error {
        CommandError::MissingPath(_) => "missing",
        CommandError::HashMismatch(_) => "verification",
        CommandError::Io(message) => {
            let lower = message.to_ascii_lowercase();
            if lower.contains("permission denied") || message.contains("权限不足") {
                "permission"
            } else if lower.contains("no space left on device") || message.contains("空间不足") {
                "space"
            } else if lower.contains("file exists") || message.contains("已存在") {
                "duplicate"
            } else {
                "io"
            }
        }
    }
}

fn source_fingerprint_from_root(root: &Path) -> String {
    let normalized = root.display().to_string().replace('\\', "/");
    if normalized.ends_with("/DCIM") {
        return normalized.trim_end_matches("/DCIM").to_string();
    }
    if normalized.ends_with("/PRIVATE/M4ROOT") {
        return normalized.trim_end_matches("/PRIVATE/M4ROOT").to_string();
    }
    normalized
}

fn source_label_from_root(root: &Path) -> String {
    Path::new(&source_fingerprint_from_root(root))
        .file_name()
        .and_then(OsStr::to_str)
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| root.display().to_string())
}

fn app_support_dir() -> Result<PathBuf, CommandError> {
    #[cfg(target_os = "macos")]
    let base = env::var("HOME")
        .map(PathBuf::from)
        .map(|home| home.join("Library").join("Application Support"))
        .map_err(|_| CommandError::Io("HOME is not set".to_string()))?;

    #[cfg(target_os = "linux")]
    let base = env::var("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|_| env::var("HOME").map(|home| PathBuf::from(home).join(".local/share")))
        .map_err(|_| CommandError::Io("HOME is not set".to_string()))?;

    #[cfg(target_os = "windows")]
    let base = env::var("APPDATA")
        .map(PathBuf::from)
        .map_err(|_| CommandError::Io("APPDATA is not set".to_string()))?;

    let dir = base.join("Photo Ingest Studio");
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn app_history_path() -> Result<PathBuf, CommandError> {
    Ok(app_support_dir()?.join("import-history.json"))
}

fn app_pending_import_path() -> Result<PathBuf, CommandError> {
    let path = app_history_path()?;
    Ok(path.with_file_name("pending-import.json"))
}

fn app_metadata_cache_path() -> Result<PathBuf, CommandError> {
    Ok(app_support_dir()?.join("metadata-cache.json"))
}

fn read_import_history() -> Result<Vec<ImportHistoryEntry>, CommandError> {
    let path = app_history_path()?;
    if !path.exists() {
        return Ok(Vec::new());
    }

    let content = fs::read_to_string(path)?;
    let mut entries =
        serde_json::from_str::<Vec<ImportHistoryEntry>>(&content).unwrap_or_else(|_| Vec::new());
    entries.sort_by(|left, right| right.finished_at.cmp(&left.finished_at));
    Ok(entries)
}

fn append_import_history(entry: ImportHistoryEntry) -> Result<(), CommandError> {
    let path = app_history_path()?;
    let mut entries = read_import_history().unwrap_or_default();
    entries.insert(0, entry);
    if entries.len() > 80 {
        entries.truncate(80);
    }
    let serialized =
        serde_json::to_string_pretty(&entries).map_err(|error| CommandError::Io(error.to_string()))?;
    fs::write(path, serialized)?;
    Ok(())
}

fn read_pending_import_state() -> Result<Option<PendingImportState>, CommandError> {
    let path = app_pending_import_path()?;
    if !path.exists() {
        return Ok(None);
    }

    let content = fs::read_to_string(path)?;
    let parsed = serde_json::from_str::<PendingImportState>(&content)
        .map_err(|error| CommandError::Io(format!("导入恢复数据损坏：{error}")))?;
    Ok(Some(parsed))
}

fn write_pending_import_state(state: PendingImportState) -> Result<(), CommandError> {
    let path = app_pending_import_path()?;
    let serialized = serde_json::to_string_pretty(&state)
        .map_err(|error| CommandError::Io(format!("写入导入恢复数据失败：{error}")))?;
    fs::write(path, serialized)?;
    Ok(())
}

fn update_pending_import_progress(
    state_id: &str,
    file: &ScannedFile,
    imported: usize,
    skipped: usize,
    failed: usize,
    latest_failure_category: Option<&str>,
) -> Result<(), CommandError> {
    let Some(mut state) = read_pending_import_state()? else {
        return Ok(());
    };

    if state.id != state_id {
        return Ok(());
    }

    state.remaining_files.retain(|entry| entry.source_path != file.path.display().to_string());
    state.imported = imported;
    state.skipped = skipped;
    state.failed = failed;
    state.last_processed_file = Some(file.filename.clone());
    if let Some(category) = latest_failure_category {
        *state.failure_categories.entry(category.to_string()).or_insert(0) += 1;
    }
    state.updated_at = Local::now();
    write_pending_import_state(state)
}

fn touch_pending_import_state(
    state_id: &str,
    imported: usize,
    skipped: usize,
    failed: usize,
) -> Result<(), CommandError> {
    let Some(mut state) = read_pending_import_state()? else {
        return Ok(());
    };

    if state.id != state_id {
        return Ok(());
    }

    state.imported = imported;
    state.skipped = skipped;
    state.failed = failed;
    state.updated_at = Local::now();
    write_pending_import_state(state)
}

fn clear_pending_import_state() -> Result<(), CommandError> {
    let path = app_pending_import_path()?;
    if path.exists() {
        fs::remove_file(path)?;
    }
    Ok(())
}

fn build_duplicate_warning(
    history: &[ImportHistoryEntry],
    fingerprint: &str,
) -> Option<DuplicateImportWarning> {
    let mut related = history
        .iter()
        .filter(|entry| entry.source_fingerprint == fingerprint);

    let latest = related.next()?;
    let count = 1 + related.count();

    Some(DuplicateImportWarning {
        source_fingerprint: fingerprint.to_string(),
        source_label: latest.source_label.clone(),
        latest_import_at: latest.finished_at,
        latest_target_root: latest.target_root.clone(),
        latest_backup_target_root: latest.backup_target_root.clone(),
        times_imported: count,
    })
}

fn open_path_in_file_manager(path: PathBuf) -> Result<(), CommandError> {
    if !path.exists() {
        return Err(CommandError::MissingPath(path.display().to_string()));
    }

    #[cfg(target_os = "macos")]
    let mut command = {
        let mut cmd = Command::new("open");
        cmd.arg(path);
        cmd
    };

    #[cfg(target_os = "linux")]
    let mut command = {
        let mut cmd = Command::new("xdg-open");
        cmd.arg(path);
        cmd
    };

    #[cfg(target_os = "windows")]
    let mut command = {
        let mut cmd = Command::new("explorer");
        cmd.arg(path);
        cmd
    };

    let status = command.status()?;
    if status.success() {
        Ok(())
    } else {
        Err(CommandError::Io("failed to open path in file manager".to_string()))
    }
}

fn write_import_report(path: PathBuf, report: Value) -> Result<(), CommandError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    let serialized =
        serde_json::to_string_pretty(&report).map_err(|error| CommandError::Io(error.to_string()))?;
    fs::write(path, serialized)?;
    Ok(())
}

fn check_target_space_blocking(
    cache_state: &Arc<Mutex<HashMap<String, Vec<ScannedFile>>>>,
    request: SpaceCheckRequest,
) -> Result<SpaceCheckResult, CommandError> {
    let files = get_cached_or_scan(cache_state, &request.source_root, request.recursive)?;
    let candidates = resolve_import_candidates(
        files,
        request.min_rating,
        request.media_selection,
        request.start_date.as_deref(),
        request.end_date.as_deref(),
        request.selected_files.as_deref(),
    );
    let total_bytes = candidates.iter().map(|file| file.size_bytes).sum::<u64>();
    let required_bytes = total_bytes.saturating_mul(105).saturating_div(100);
    let primary_available = resolve_available_space(&request.target_root)?;
    let primary = SpaceCheckTarget {
        path: request.target_root.display().to_string(),
        required_bytes,
        available_bytes: primary_available,
        enough: primary_available >= required_bytes,
    };
    let backup = if let Some(root) = request.backup_target_root.as_ref() {
        let available = resolve_available_space(root)?;
        Some(SpaceCheckTarget {
            path: root.display().to_string(),
            required_bytes,
            available_bytes: available,
            enough: available >= required_bytes,
        })
    } else {
        None
    };

    let mut warnings = Vec::new();
    if candidates.is_empty() {
        warnings.push("当前规则下没有可导入文件，无需检查空间。".to_string());
    }
    if !primary.enough {
        warnings.push("主目录可用空间不足，导入前请释放空间或更换目标盘。".to_string());
    }
    if let Some(backup) = &backup {
        if !backup.enough {
            warnings.push("备份目录可用空间不足，双目标导入会失败。".to_string());
        }
    }

    Ok(SpaceCheckResult {
        planned_files: candidates.len(),
        total_bytes,
        primary,
        backup,
        warnings,
    })
}

fn resolve_available_space(path: &Path) -> Result<u64, CommandError> {
    let probe = if path.exists() {
        path.to_path_buf()
    } else {
        path.parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| path.to_path_buf())
    };
    available_space(&probe).map_err(|error| {
        CommandError::Io(format!("无法读取目标目录可用空间 {}: {error}", probe.display()))
    })
}

fn build_media_preview_data_url(path: PathBuf) -> Result<String, CommandError> {
    let bytes = fs::read(&path)?;
    let extension = path
        .extension()
        .and_then(OsStr::to_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    let mime = match extension.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        _ => "application/octet-stream",
    };
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    Ok(format!("data:{mime};base64,{encoded}"))
}

fn read_metadata_cache() -> HashMap<String, MetadataCacheEntry> {
    let Ok(path) = app_metadata_cache_path() else {
        return HashMap::new();
    };
    if !path.exists() {
        return HashMap::new();
    }

    let Ok(content) = fs::read_to_string(path) else {
        return HashMap::new();
    };
    serde_json::from_str::<Vec<MetadataCacheEntry>>(&content)
        .unwrap_or_default()
        .into_iter()
        .map(|entry| (entry.source_path.clone(), entry))
        .collect()
}

fn write_metadata_cache(cache: &HashMap<String, MetadataCacheEntry>) -> Result<(), CommandError> {
    let path = app_metadata_cache_path()?;
    let mut entries: Vec<MetadataCacheEntry> = cache.values().cloned().collect();
    entries.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    if entries.len() > 20_000 {
        entries.truncate(20_000);
    }
    let serialized =
        serde_json::to_string_pretty(&entries).map_err(|error| CommandError::Io(error.to_string()))?;
    fs::write(path, serialized)?;
    Ok(())
}

fn file_signature(path: &Path) -> Result<(i64, u64), CommandError> {
    let metadata = fs::metadata(path)?;
    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0);
    Ok((modified, metadata.len()))
}

fn cached_metadata_for_paths(
    paths: &[PathBuf],
) -> (HashMap<PathBuf, ExternalMetadata>, Vec<PathBuf>, HashMap<String, MetadataCacheEntry>) {
    let mut resolved = HashMap::new();
    let mut missing = Vec::new();
    let cache = read_metadata_cache();

    for path in paths {
        let key = path.display().to_string();
        let Ok((modified_millis, size_bytes)) = file_signature(path) else {
            missing.push(path.clone());
            continue;
        };

        if let Some(entry) = cache.get(&key) {
            if entry.modified_millis == modified_millis && entry.size_bytes == size_bytes {
                resolved.insert(
                    path.clone(),
                    ExternalMetadata {
                        shot_at: entry.shot_at,
                        camera: entry.camera.clone(),
                        rating: entry.rating,
                    },
                );
                continue;
            }
        }

        missing.push(path.clone());
    }

    (resolved, missing, cache)
}

fn update_metadata_cache(
    cache: &mut HashMap<String, MetadataCacheEntry>,
    path: &Path,
    metadata: &ExternalMetadata,
) {
    if let Ok((modified_millis, size_bytes)) = file_signature(path) {
        cache.insert(
            path.display().to_string(),
            MetadataCacheEntry {
                source_path: path.display().to_string(),
                modified_millis,
                size_bytes,
                shot_at: metadata.shot_at,
                camera: metadata.camera.clone(),
                rating: metadata.rating,
                updated_at: Local::now(),
            },
        );
    }
}

fn scan_cache_key(root: &Path, recursive: bool) -> String {
    format!("{}::{recursive}", root.display())
}

fn store_scan_cache(
    cache_state: &Arc<Mutex<HashMap<String, Vec<ScannedFile>>>>,
    root: &Path,
    recursive: bool,
    files: Vec<ScannedFile>,
) {
    if let Ok(mut cache) = cache_state.lock() {
        cache.insert(scan_cache_key(root, recursive), files);
        if cache.len() > 8 {
            let first_key = cache.keys().next().cloned();
            if let Some(first_key) = first_key {
                cache.remove(&first_key);
            }
        }
    }
}

fn get_cached_or_scan(
    cache_state: &Arc<Mutex<HashMap<String, Vec<ScannedFile>>>>,
    root: &Path,
    recursive: bool,
) -> Result<Vec<ScannedFile>, CommandError> {
    let cache_key = scan_cache_key(root, recursive);
    if let Ok(cache) = cache_state.lock() {
        if let Some(files) = cache.get(&cache_key) {
            return Ok(files.clone());
        }
    }

    let files = scan_media_entries(root, recursive)?;
    store_scan_cache(cache_state, root, recursive, files.clone());
    Ok(files)
}

fn scan_media_entries(root: &Path, recursive: bool) -> Result<Vec<ScannedFile>, CommandError> {
    if !root.exists() {
        return Err(CommandError::MissingPath(root.display().to_string()));
    }

    let walker = WalkDir::new(root)
        .follow_links(false)
        .max_depth(if recursive { usize::MAX } else { 1 })
        .into_iter();

    let paths: Vec<PathBuf> = walker
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file() && is_supported_media(entry.path()))
        .map(|entry| entry.into_path())
        .collect();

    let external_metadata = load_external_metadata(&paths);
    let mut files = Vec::with_capacity(paths.len());

    for path in paths {
        let metadata = fs::metadata(&path)?;
        let fallback_shot_at = metadata
            .modified()
            .map(DateTime::<Local>::from)
            .unwrap_or_else(|_| Local::now());
        let info = external_metadata
            .get(&path)
            .cloned()
            .unwrap_or_else(ExternalMetadata::default);

        files.push(ScannedFile {
            filename: path
                .file_name()
                .and_then(OsStr::to_str)
                .unwrap_or_default()
                .to_string(),
            path,
            shot_at: info.shot_at.unwrap_or(fallback_shot_at),
            camera: info.camera,
            rating: info.rating,
            size_bytes: metadata.len(),
        });
    }

    files.sort_by(|left, right| {
        left.shot_at
            .cmp(&right.shot_at)
            .then_with(|| left.filename.cmp(&right.filename))
    });

    Ok(files)
}

fn scan_media_entries_with_progress(
    window: &Window,
    root: &Path,
    recursive: bool,
) -> Result<Vec<ScannedFile>, CommandError> {
    if !root.exists() {
        return Err(CommandError::MissingPath(root.display().to_string()));
    }

    emit_scan_progress(
        window,
        ScanProgressEvent {
            stage: "discovering".to_string(),
            current_item: Some(root.display().to_string()),
            processed: 0,
            total: 0,
            progress: 0,
            message: "正在扫描目录中的照片文件。".to_string(),
        },
    );

    let walker = WalkDir::new(root)
        .follow_links(false)
        .max_depth(if recursive { usize::MAX } else { 1 })
        .into_iter();

    let mut paths = Vec::<PathBuf>::new();
    for (index, entry) in walker.filter_map(Result::ok).enumerate() {
        if entry.file_type().is_file() && is_supported_media(entry.path()) {
            paths.push(entry.into_path());
        }

        if index % 50 == 0 {
            emit_scan_progress(
                window,
                ScanProgressEvent {
                    stage: "discovering".to_string(),
                    current_item: Some(root.display().to_string()),
                    processed: paths.len(),
                    total: 0,
                    progress: (5 + ((paths.len() % 14) as u8)).min(18),
                    message: format!("正在发现文件，当前已找到 {} 个。", paths.len()),
                },
            );
        }
    }

    let total = paths.len();
    emit_scan_progress(
        window,
        ScanProgressEvent {
            stage: "metadata".to_string(),
            current_item: None,
            processed: 0,
            total,
            progress: if total == 0 { 100 } else { 25 },
            message: if total == 0 {
                "没有找到可分析的照片文件。".to_string()
            } else {
                format!("已找到 {total} 个文件，开始读取元数据。")
            },
        },
    );

    let external_metadata = load_external_metadata_with_progress(window, &paths);
    let mut files = Vec::with_capacity(paths.len());

    for (index, path) in paths.into_iter().enumerate() {
        let metadata = fs::metadata(&path)?;
        let fallback_shot_at = metadata
            .modified()
            .map(DateTime::<Local>::from)
            .unwrap_or_else(|_| Local::now());
        let info = external_metadata
            .get(&path)
            .cloned()
            .unwrap_or_else(ExternalMetadata::default);

        files.push(ScannedFile {
            filename: path
                .file_name()
                .and_then(OsStr::to_str)
                .unwrap_or_default()
                .to_string(),
            path: path.clone(),
            shot_at: info.shot_at.unwrap_or(fallback_shot_at),
            camera: info.camera,
            rating: info.rating,
            size_bytes: metadata.len(),
        });

        let processed = index + 1;
        let progress = if total == 0 {
            100
        } else {
            75 + (((processed.saturating_mul(24)) / total).min(24) as u8)
        };
        if processed == total || processed % 25 == 0 {
            emit_scan_progress(
                window,
                ScanProgressEvent {
                    stage: "metadata".to_string(),
                    current_item: Some(
                        files
                            .last()
                            .map(|file| file.filename.clone())
                            .unwrap_or_default(),
                    ),
                    processed,
                    total,
                    progress,
                    message: format!("正在整理素材信息 {processed}/{total}。"),
                },
            );
        }
    }

    files.sort_by(|left, right| {
        left.shot_at
            .cmp(&right.shot_at)
            .then_with(|| left.filename.cmp(&right.filename))
    });

    emit_scan_progress(
        window,
        ScanProgressEvent {
            stage: "finished".to_string(),
            current_item: None,
            processed: total,
            total,
            progress: 100,
            message: format!("素材分析完成，共识别 {total} 个文件。"),
        },
    );

    Ok(files)
}

fn inspect_source_candidate(root: &Path) -> Option<DetectSourceEntry> {
    let inspected = preferred_media_root(root);
    let summary = summarize_media_root(&inspected)?;
    if summary.file_count == 0 {
        return None;
    }

    let source_kind = detect_source_kind(root, &inspected);

    Some(DetectSourceEntry {
        label: root
            .file_name()
            .and_then(OsStr::to_str)
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| root.to_string_lossy().into_owned()),
        root_path: inspected.display().to_string(),
        file_count: summary.file_count,
        formats: summary.formats,
        source_kind,
    })
}

fn detect_source_kind(root: &Path, inspected: &Path) -> String {
    #[cfg(target_os = "macos")]
    {
        if let Some(info) = load_macos_volume_info(root) {
            let kind = classify_macos_source_kind(&info);
            if inspected != root {
                return format!("{kind}-dcim");
            }
            return kind.to_string();
        }
    }

    if inspected != root {
        "dcim".to_string()
    } else {
        "removable-volume".to_string()
    }
}

#[derive(Debug)]
struct MediaRootSummary {
    file_count: usize,
    formats: Vec<String>,
}

#[cfg(target_os = "macos")]
#[derive(Debug, Default, Clone)]
struct MacOsVolumeInfo {
    device_location: Option<String>,
    removable_media: Option<String>,
    solid_state: Option<bool>,
}

fn summarize_media_root(root: &Path) -> Option<MediaRootSummary> {
    if !root.exists() || !root.is_dir() {
        return None;
    }

    let mut formats = Vec::<String>::new();
    let mut file_count = 0usize;

    for entry in WalkDir::new(root)
        .follow_links(false)
        .max_depth(4)
        .into_iter()
        .filter_map(Result::ok)
    {
        let path = entry.path();
        if !entry.file_type().is_file() || !is_supported_media(path) {
            continue;
        }

        file_count += 1;
        if let Some(ext) = path.extension().and_then(OsStr::to_str) {
            let ext = ext.to_ascii_uppercase();
            if !formats.contains(&ext) {
                formats.push(ext);
            }
        }
    }

    if file_count == 0 {
        None
    } else {
        formats.sort();
        Some(MediaRootSummary { file_count, formats })
    }
}

fn preferred_media_root(root: &Path) -> PathBuf {
    let dcim = root.join("DCIM");
    if dcim.is_dir() {
        return dcim;
    }

    let private_dcim = root.join("PRIVATE").join("M4ROOT");
    if private_dcim.is_dir() {
        return private_dcim;
    }

    root.to_path_buf()
}

fn candidate_source_roots() -> Vec<PathBuf> {
    let mut candidates = Vec::<PathBuf>::new();

    #[cfg(target_os = "macos")]
    {
        collect_macos_removable_volumes(Path::new("/Volumes"), &mut candidates);
    }

    #[cfg(target_os = "linux")]
    {
        collect_child_directories(Path::new("/media"), &mut candidates);
        collect_grandchild_directories(Path::new("/run/media"), &mut candidates);
        collect_child_directories(Path::new("/mnt"), &mut candidates);
    }

    #[cfg(target_os = "windows")]
    {
        for letter in b'D'..=b'Z' {
            let drive = format!("{}:\\", letter as char);
            let path = PathBuf::from(drive);
            if path.exists() {
                candidates.push(path);
            }
        }
    }

    candidates.sort();
    candidates.dedup();
    candidates
}

#[cfg(target_os = "macos")]
fn collect_macos_removable_volumes(root: &Path, candidates: &mut Vec<PathBuf>) {
    let Ok(read_dir) = fs::read_dir(root) else {
        return;
    };

    for entry in read_dir.filter_map(Result::ok) {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }

        if is_macos_removable_volume(&path) {
            candidates.push(path);
        }
    }
}

#[cfg(target_os = "macos")]
fn is_macos_removable_volume(path: &Path) -> bool {
    load_macos_volume_info(path)
        .map(|info| macos_volume_is_removable(&info))
        .unwrap_or(false)
}

#[cfg(target_os = "macos")]
fn load_macos_volume_info(path: &Path) -> Option<MacOsVolumeInfo> {
    let Ok(output) = Command::new("diskutil").arg("info").arg(path).output() else {
        return None;
    };

    if !output.status.success() {
        return None;
    }

    let info = String::from_utf8_lossy(&output.stdout);
    Some(parse_macos_volume_info(&info))
}

#[cfg(target_os = "macos")]
fn parse_macos_volume_info(info: &str) -> MacOsVolumeInfo {
    let mut parsed = MacOsVolumeInfo::default();

    for line in info.lines() {
        let Some((label, value)) = line.split_once(':') else {
            continue;
        };

        match label.trim() {
            "Device Location" => parsed.device_location = Some(value.trim().to_ascii_lowercase()),
            "Removable Media" => parsed.removable_media = Some(value.trim().to_ascii_lowercase()),
            "Solid State" => {
                parsed.solid_state = match value.trim().to_ascii_lowercase().as_str() {
                    "yes" => Some(true),
                    "no" => Some(false),
                    _ => None,
                }
            }
            _ => {}
        }
    }

    parsed
}

#[cfg(target_os = "macos")]
fn macos_volume_is_removable(info: &MacOsVolumeInfo) -> bool {
    match (
        info.device_location.as_deref(),
        info.removable_media.as_deref(),
    ) {
        (Some("internal"), Some("fixed")) => false,
        (_, Some("removable")) => true,
        (Some("external"), _) => true,
        (_, Some(value)) if value != "fixed" => true,
        _ => false,
    }
}

#[cfg(target_os = "macos")]
fn classify_macos_source_kind(info: &MacOsVolumeInfo) -> &'static str {
    if matches!(info.removable_media.as_deref(), Some("removable")) {
        return "removable-media";
    }

    if matches!(info.device_location.as_deref(), Some("external")) {
        if matches!(info.solid_state, Some(true)) {
            return "external-ssd";
        }
        return "external-disk";
    }

    "removable-volume"
}

#[cfg(target_os = "linux")]
fn collect_child_directories(root: &Path, candidates: &mut Vec<PathBuf>) {
    let Ok(read_dir) = fs::read_dir(root) else {
        return;
    };

    for entry in read_dir.filter_map(Result::ok) {
        let path = entry.path();
        if path.is_dir() {
            candidates.push(path);
        }
    }
}

#[cfg(target_os = "linux")]
fn collect_grandchild_directories(root: &Path, candidates: &mut Vec<PathBuf>) {
    let Ok(read_dir) = fs::read_dir(root) else {
        return;
    };

    for entry in read_dir.filter_map(Result::ok) {
        let path = entry.path();
        if path.is_dir() {
            collect_child_directories(&path, candidates);
        }
    }
}

fn is_supported_media(path: &Path) -> bool {
    path.extension()
        .and_then(OsStr::to_str)
        .map(|ext| SUPPORTED_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

fn is_raw_file(path: &Path) -> bool {
    path.extension()
        .and_then(OsStr::to_str)
        .map(|ext| {
            matches!(
                ext.to_ascii_lowercase().as_str(),
                "3fr"
                    | "arw"
                    | "cr2"
                    | "cr3"
                    | "dng"
                    | "erf"
                    | "kdc"
                    | "mef"
                    | "mos"
                    | "mrw"
                    | "nef"
                    | "nrw"
                    | "orf"
                    | "pef"
                    | "raf"
                    | "raw"
                    | "rw2"
                    | "sr2"
                    | "srf"
            )
        })
        .unwrap_or(false)
}

fn is_jpeg_file(path: &Path) -> bool {
    path.extension()
        .and_then(OsStr::to_str)
        .map(|ext| matches!(ext.to_ascii_lowercase().as_str(), "jpg" | "jpeg"))
        .unwrap_or(false)
}

fn load_external_metadata(paths: &[PathBuf]) -> HashMap<PathBuf, ExternalMetadata> {
    if paths.is_empty() {
        return HashMap::new();
    }

    let (mut resolved, missing, mut cache) = cached_metadata_for_paths(paths);
    if missing.is_empty() {
        return resolved;
    }

    if Command::new("exiftool").arg("-ver").output().is_err() {
        return resolved;
    }

    for chunk in missing.chunks(200) {
        let output = Command::new("exiftool")
            .arg("-json")
            .arg("-DateTimeOriginal")
            .arg("-CreateDate")
            .arg("-Model")
            .arg("-Rating")
            .args(chunk)
            .output();

        let Ok(output) = output else {
            continue;
        };

        if !output.status.success() {
            continue;
        }

        let Ok(rows) = serde_json::from_slice::<Vec<Value>>(&output.stdout) else {
            continue;
        };

        for row in rows {
            let Some(source_file) = row.get("SourceFile").and_then(Value::as_str) else {
                continue;
            };
            let path = PathBuf::from(source_file);
            let shot_at = row
                .get("DateTimeOriginal")
                .and_then(Value::as_str)
                .and_then(parse_exif_datetime)
                .or_else(|| {
                    row.get("CreateDate")
                        .and_then(Value::as_str)
                        .and_then(parse_exif_datetime)
                });
            let camera = row
                .get("Model")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
                .filter(|value| !value.trim().is_empty());
            let rating = row
                .get("Rating")
                .and_then(|value| value.as_u64().or_else(|| value.as_str()?.parse().ok()))
                .map(|value| value.min(5) as u8);

            let metadata = ExternalMetadata { shot_at, camera, rating };
            update_metadata_cache(&mut cache, &path, &metadata);
            resolved.insert(path, metadata);
        }
    }

    let _ = write_metadata_cache(&cache);
    resolved
}

fn load_external_metadata_with_progress(
    window: &Window,
    paths: &[PathBuf],
) -> HashMap<PathBuf, ExternalMetadata> {
    if paths.is_empty() {
        return HashMap::new();
    }

    let (mut resolved, missing, mut cache) = cached_metadata_for_paths(paths);
    if missing.is_empty() {
        emit_scan_progress(
            window,
            ScanProgressEvent {
                stage: "metadata".to_string(),
                current_item: None,
                processed: paths.len(),
                total: paths.len(),
                progress: 75,
                message: format!("已从本地缓存恢复 {} 个文件的元数据。", paths.len()),
            },
        );
        return resolved;
    }

    if Command::new("exiftool").arg("-ver").output().is_err() {
        emit_scan_progress(
            window,
            ScanProgressEvent {
                stage: "metadata".to_string(),
                current_item: None,
                processed: resolved.len(),
                total: paths.len(),
                progress: 70,
                message: if resolved.is_empty() {
                    "未检测到 ExifTool，回退到文件系统时间。".to_string()
                } else {
                    format!("未检测到 ExifTool，已使用缓存恢复 {} 个文件。", resolved.len())
                },
            },
        );
        return resolved;
    }
    let total = paths.len();
    let mut processed = resolved.len();

    for chunk in missing.chunks(100) {
        emit_scan_progress(
            window,
            ScanProgressEvent {
                stage: "metadata".to_string(),
                current_item: chunk
                    .first()
                    .and_then(|path| path.file_name())
                    .and_then(OsStr::to_str)
                    .map(ToOwned::to_owned),
                processed,
                total,
                progress: 25 + (((processed.saturating_mul(50)) / total).min(50) as u8),
                message: format!("正在读取 EXIF 元数据 {processed}/{total}。"),
            },
        );

        let output = Command::new("exiftool")
            .arg("-json")
            .arg("-DateTimeOriginal")
            .arg("-CreateDate")
            .arg("-Model")
            .arg("-Rating")
            .args(chunk)
            .output();

        let Ok(output) = output else {
            processed += chunk.len();
            continue;
        };

        if output.status.success() {
            if let Ok(rows) = serde_json::from_slice::<Vec<Value>>(&output.stdout) {
                for row in rows {
                    let Some(source_file) = row.get("SourceFile").and_then(Value::as_str) else {
                        continue;
                    };
                    let path = PathBuf::from(source_file);
                    let shot_at = row
                        .get("DateTimeOriginal")
                        .and_then(Value::as_str)
                        .and_then(parse_exif_datetime)
                        .or_else(|| {
                            row.get("CreateDate")
                                .and_then(Value::as_str)
                                .and_then(parse_exif_datetime)
                        });
                    let camera = row
                        .get("Model")
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned)
                        .filter(|value| !value.trim().is_empty());
                    let rating = row
                        .get("Rating")
                        .and_then(|value| value.as_u64().or_else(|| value.as_str()?.parse().ok()))
                        .map(|value| value.min(5) as u8);

                    let metadata = ExternalMetadata { shot_at, camera, rating };
                    update_metadata_cache(&mut cache, &path, &metadata);
                    resolved.insert(path, metadata);
                }
            }
        }

        processed += chunk.len();
        emit_scan_progress(
            window,
            ScanProgressEvent {
                stage: "metadata".to_string(),
                current_item: chunk
                    .last()
                    .and_then(|path| path.file_name())
                    .and_then(OsStr::to_str)
                    .map(ToOwned::to_owned),
                processed,
                total,
                progress: 25 + (((processed.saturating_mul(50)) / total).min(50) as u8),
                message: format!("EXIF 元数据读取中 {processed}/{total}。"),
            },
        );
    }

    let _ = write_metadata_cache(&cache);
    resolved
}

fn parse_exif_datetime(value: &str) -> Option<DateTime<Local>> {
    let formats = [
        "%Y:%m:%d %H:%M:%S%:z",
        "%Y:%m:%d %H:%M:%S%.f%:z",
        "%Y:%m:%d %H:%M:%S",
        "%Y:%m:%d %H:%M:%S%.f",
    ];

    for format in formats {
        if let Ok(datetime) = DateTime::parse_from_str(value, format) {
            return Some(datetime.with_timezone(&Local));
        }

        if let Ok(naive) = NaiveDateTime::parse_from_str(value, format) {
            return match Local.from_local_datetime(&naive) {
                LocalResult::Single(datetime) => Some(datetime),
                LocalResult::Ambiguous(datetime, _) => Some(datetime),
                LocalResult::None => None,
            };
        }
    }

    None
}

fn build_target_relative_path(file: &ScannedFile, template: &str) -> PathBuf {
    let camera = sanitize_path_component(file.camera.as_deref().unwrap_or("Unknown Camera"));
    let rating = file.rating.unwrap_or(0).to_string();
    let date = file.shot_at;

    let rendered = template
        .replace("{YYYY-MM-DD}", &date.format("%Y-%m-%d").to_string())
        .replace("{YYYY}", &date.format("%Y").to_string())
        .replace("{MM}", &date.format("%m").to_string())
        .replace("{DD}", &date.format("%d").to_string())
        .replace("{camera}", &camera)
        .replace("{rating}", &rating);

    let mut relative = PathBuf::new();
    for component in rendered.split('/') {
        let trimmed = component.trim();
        if !trimmed.is_empty() {
            relative.push(sanitize_path_component(trimmed));
        }
    }
    relative
}

fn build_target_filename(file: &ScannedFile, template: &str) -> String {
    let stem = file
        .path
        .file_stem()
        .and_then(OsStr::to_str)
        .unwrap_or("photo");
    let extension = file
        .path
        .extension()
        .and_then(OsStr::to_str)
        .unwrap_or_default();
    let camera = sanitize_path_component(file.camera.as_deref().unwrap_or("Unknown Camera"));
    let rating = file.rating.unwrap_or(0).to_string();
    let date = file.shot_at;
    let raw_template = template.trim();
    let base_template = if raw_template.is_empty() {
        "{original}"
    } else {
        raw_template
    };

    let rendered = base_template
        .replace("{original}", stem)
        .replace("{YYYYMMDD}", &date.format("%Y%m%d").to_string())
        .replace("{HHmmss}", &date.format("%H%M%S").to_string())
        .replace("{camera}", &camera)
        .replace("{rating}", &rating);
    let cleaned = sanitize_path_component(&rendered);

    if extension.is_empty() {
        cleaned
    } else {
        format!("{cleaned}.{}", extension)
    }
}

fn write_rating_to_targets(paths: &[PathBuf], rating: u8) -> Result<(), CommandError> {
    if paths.is_empty() {
        return Ok(());
    }

    let exiftool = Command::new("exiftool")
        .arg("-ver")
        .output()
        .map_err(|_| CommandError::Io("未检测到 ExifTool，无法写入 XMP 星级。".to_string()))?;
    if !exiftool.status.success() {
        return Err(CommandError::Io("ExifTool 不可用，无法写入 XMP 星级。".to_string()));
    }

    let rating_value = rating.min(5).to_string();
    let status = Command::new("exiftool")
        .arg("-overwrite_original")
        .arg(format!("-Rating={rating_value}"))
        .arg(format!("-XMP:Rating={rating_value}"))
        .args(paths)
        .status()
        .map_err(|error| CommandError::Io(format!("写入 XMP 星级失败：{error}")))?;

    if status.success() {
        Ok(())
    } else {
        Err(CommandError::Io("ExifTool 写入 XMP 星级失败。".to_string()))
    }
}

fn sanitize_path_component(value: &str) -> String {
    let cleaned: String = value
        .chars()
        .map(|ch| match ch {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            _ => ch,
        })
        .collect();

    let trimmed = cleaned.trim().trim_matches('.');
    if trimmed.is_empty() {
        "unknown".to_string()
    } else {
        trimmed.to_string()
    }
}

fn import_file_to_destinations(
    source: &Path,
    primary_target: &Path,
    backup_target: Option<&Path>,
    duplicate_strategy: DuplicateStrategy,
    verify_mode: VerifyMode,
) -> Result<ImportFileOutcome, CommandError> {
    let source_hash = hash_file(source, verify_mode)?;
    let primary_outcome = import_file_to_target(
        source,
        primary_target,
        duplicate_strategy,
        verify_mode,
        &source_hash,
    )
    .map_err(|error| CommandError::Io(format!("主目录导入失败：{}", localize_error_reason(&error))))?;

    if let Some(backup_target) = backup_target {
        let backup_outcome = import_file_to_target(
            source,
            backup_target,
            duplicate_strategy,
            verify_mode,
            &source_hash,
        )
        .map_err(|error| CommandError::Io(format!("备份目录导入失败：{}", localize_error_reason(&error))))?;

        let imported_any = matches!(primary_outcome.status, ImportFileStatus::Imported)
            || matches!(backup_outcome.status, ImportFileStatus::Imported);
        let mut written_paths = primary_outcome.written_paths;
        written_paths.extend(backup_outcome.written_paths);
        let mut renamed_paths = primary_outcome.renamed_paths;
        renamed_paths.extend(backup_outcome.renamed_paths);
        let mut skipped_targets = primary_outcome.skipped_targets;
        skipped_targets.extend(backup_outcome.skipped_targets);

        return Ok(ImportFileOutcome {
            status: if imported_any {
                ImportFileStatus::Imported
            } else {
                ImportFileStatus::Skipped
            },
            written_paths,
            renamed_paths,
            skipped_targets,
        });
    }

    Ok(primary_outcome)
}

fn import_file_to_target(
    source: &Path,
    preferred_target: &Path,
    duplicate_strategy: DuplicateStrategy,
    verify_mode: VerifyMode,
    source_hash: &str,
) -> Result<ImportFileOutcome, CommandError> {
    if let Some(parent) = preferred_target.parent() {
        fs::create_dir_all(parent)?;
    }

    if preferred_target.exists() {
        let target_hash = hash_file(preferred_target, verify_mode)?;
        if source_hash == target_hash {
            return Ok(ImportFileOutcome {
                status: ImportFileStatus::Skipped,
                written_paths: vec![preferred_target.to_path_buf()],
                renamed_paths: Vec::new(),
                skipped_targets: vec![(
                    preferred_target.to_path_buf(),
                    "目标已存在且内容相同，已跳过。".to_string(),
                )],
            });
        }
    }

    let target = match duplicate_strategy {
        DuplicateStrategy::Skip if preferred_target.exists() => {
            return Ok(ImportFileOutcome {
                status: ImportFileStatus::Skipped,
                written_paths: vec![preferred_target.to_path_buf()],
                renamed_paths: Vec::new(),
                skipped_targets: vec![(
                    preferred_target.to_path_buf(),
                    "目标已存在，按当前策略跳过。".to_string(),
                )],
            });
        }
        DuplicateStrategy::Rename | DuplicateStrategy::KeepBoth if preferred_target.exists() => {
            next_available_target(preferred_target)
        }
        DuplicateStrategy::Skip | DuplicateStrategy::Rename | DuplicateStrategy::KeepBoth => {
            preferred_target.to_path_buf()
        }
    };

    copy_with_verification(source, &target, verify_mode, source_hash)?;
    let renamed_paths = if target != preferred_target {
        vec![target.clone()]
    } else {
        Vec::new()
    };
    Ok(ImportFileOutcome {
        status: ImportFileStatus::Imported,
        written_paths: vec![target],
        renamed_paths,
        skipped_targets: Vec::new(),
    })
}

fn next_available_target(preferred_target: &Path) -> PathBuf {
    let stem = preferred_target
        .file_stem()
        .and_then(OsStr::to_str)
        .unwrap_or("file");
    let extension = preferred_target
        .extension()
        .and_then(OsStr::to_str)
        .map(ToOwned::to_owned);
    let parent = preferred_target.parent().unwrap_or_else(|| Path::new("."));

    let mut index = 1usize;
    loop {
        let candidate_name = match &extension {
            Some(ext) => format!("{stem}_{index}.{ext}"),
            None => format!("{stem}_{index}"),
        };
        let candidate = parent.join(candidate_name);
        if !candidate.exists() {
            return candidate;
        }
        index += 1;
    }
}

fn copy_with_verification(
    source: &Path,
    destination: &Path,
    verify_mode: VerifyMode,
    expected_hash: &str,
) -> Result<(), CommandError> {
    let temp_path = temporary_target_path(destination);

    if temp_path.exists() {
        fs::remove_file(&temp_path)?;
    }

    {
        let mut reader = BufReader::new(File::open(source)?);
        let mut writer = BufWriter::new(File::create(&temp_path)?);
        // Allocate the transfer buffer on the heap so release builds do not
        // overflow the smaller Tokio blocking thread stack on macOS.
        let mut buffer = vec![0u8; 1024 * 1024];

        loop {
            let read = reader.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            writer.write_all(&buffer[..read])?;
        }

        writer.flush()?;
    }

    let destination_hash = hash_file(&temp_path, verify_mode)?;
    if destination_hash != expected_hash {
        let _ = fs::remove_file(&temp_path);
        return Err(CommandError::HashMismatch(destination.display().to_string()));
    }

    fs::rename(&temp_path, destination)?;
    Ok(())
}

fn temporary_target_path(destination: &Path) -> PathBuf {
    let filename = destination
        .file_name()
        .and_then(OsStr::to_str)
        .unwrap_or("import");
    destination.with_file_name(format!("{filename}.part"))
}

fn hash_file(path: &Path, verify_mode: VerifyMode) -> Result<String, CommandError> {
    let mut reader = BufReader::new(File::open(path)?);
    // Keep hashing buffers off the stack. During import we can hash the source,
    // an existing target, and a temp file in nested calls; a 1 MB stack buffer
    // at each level is enough to crash the packaged macOS app.
    let mut buffer = vec![0u8; 1024 * 1024];

    match verify_mode {
        VerifyMode::Md5 => {
            let mut hasher = md5::Context::new();
            loop {
                let read = reader.read(&mut buffer)?;
                if read == 0 {
                    break;
                }
                hasher.consume(&buffer[..read]);
            }
            Ok(format!("{:x}", hasher.compute()))
        }
        VerifyMode::Blake3 => {
            let mut hasher = blake3::Hasher::new();
            loop {
                let read = reader.read(&mut buffer)?;
                if read == 0 {
                    break;
                }
                hasher.update(&buffer[..read]);
            }
            Ok(hasher.finalize().to_hex().to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn expands_template_with_date_and_camera() {
        let file = ScannedFile {
            path: PathBuf::from("/tmp/A001.CR3"),
            filename: "A001.CR3".to_string(),
            shot_at: Local
                .with_ymd_and_hms(2026, 3, 26, 9, 15, 30)
                .single()
                .expect("valid datetime"),
            camera: Some("Canon EOS R5".to_string()),
            rating: Some(4),
            size_bytes: 12,
        };

        let relative = build_target_relative_path(&file, "{YYYY}/{YYYY-MM-DD}/{camera}");
        assert_eq!(
            relative,
            PathBuf::from("2026").join("2026-03-26").join("Canon EOS R5")
        );
    }

    #[test]
    fn builds_target_filename_from_template() {
        let file = ScannedFile {
            path: PathBuf::from("/tmp/A001.CR3"),
            filename: "A001.CR3".to_string(),
            shot_at: Local
                .with_ymd_and_hms(2026, 3, 26, 9, 15, 30)
                .single()
                .expect("valid datetime"),
            camera: Some("Canon EOS R5".to_string()),
            rating: Some(4),
            size_bytes: 12,
        };

        let filename = build_target_filename(&file, "{YYYYMMDD}_{HHmmss}_{camera}");
        assert_eq!(filename, "20260326_091530_Canon EOS R5.CR3");
    }

    #[test]
    fn rename_strategy_finds_next_free_name() {
        let dir = tempdir().expect("temp dir");
        let original = dir.path().join("A001.CR3");
        File::create(&original).expect("create file");

        let candidate = next_available_target(&original);
        assert_eq!(candidate.file_name().and_then(OsStr::to_str), Some("A001_1.CR3"));
    }

    #[test]
    fn copies_and_verifies_md5() {
        let dir = tempdir().expect("temp dir");
        let source = dir.path().join("source.CR3");
        let target = dir.path().join("target.CR3");
        fs::write(&source, b"photo-bytes").expect("write source");

        let source_hash = hash_file(&source, VerifyMode::Md5).expect("hash source");
        copy_with_verification(&source, &target, VerifyMode::Md5, &source_hash)
            .expect("copy and verify");

        let copied = fs::read(&target).expect("read target");
        assert_eq!(copied, b"photo-bytes");
    }

    #[test]
    fn prefers_dcim_directory_when_present() {
        let dir = tempdir().expect("temp dir");
        let dcim = dir.path().join("DCIM");
        fs::create_dir_all(&dcim).expect("create dcim");

        let preferred = preferred_media_root(dir.path());
        assert_eq!(preferred, dcim);
    }

    #[test]
    fn summarizes_media_root_with_supported_files() {
        let dir = tempdir().expect("temp dir");
        fs::write(dir.path().join("A001.CR3"), b"a").expect("write raw");
        fs::write(dir.path().join("A001.JPG"), b"b").expect("write jpg");
        fs::write(dir.path().join("notes.txt"), b"c").expect("write txt");

        let summary = summarize_media_root(dir.path()).expect("summary");
        assert_eq!(summary.file_count, 2);
        assert!(summary.formats.contains(&"CR3".to_string()));
        assert!(summary.formats.contains(&"JPG".to_string()));
    }

    #[test]
    fn filters_files_by_date_range() {
        let file = ScannedFile {
            path: PathBuf::from("/tmp/A001.CR3"),
            filename: "A001.CR3".to_string(),
            shot_at: Local
                .with_ymd_and_hms(2026, 3, 26, 9, 15, 30)
                .single()
                .expect("valid datetime"),
            camera: Some("Canon EOS R5".to_string()),
            rating: Some(4),
            size_bytes: 12,
        };

        assert!(file_matches_filters(&file, 3, Some("2026-03-01"), Some("2026-03-31")));
        assert!(!file_matches_filters(
            &file,
            3,
            Some("2026-03-27"),
            Some("2026-03-31")
        ));
        assert!(!file_matches_filters(
            &file,
            3,
            Some("2026-03-01"),
            Some("2026-03-25")
        ));
    }

    #[test]
    fn pair_raw_jpeg_keeps_only_complete_pairs() {
        let shot_at = Local
            .with_ymd_and_hms(2026, 3, 26, 9, 15, 30)
            .single()
            .expect("valid datetime");
        let files = vec![
            ScannedFile {
                path: PathBuf::from("/tmp/DCIM/A001.CR3"),
                filename: "A001.CR3".to_string(),
                shot_at,
                camera: Some("Canon EOS R5".to_string()),
                rating: Some(4),
                size_bytes: 12,
            },
            ScannedFile {
                path: PathBuf::from("/tmp/DCIM/A001.JPG"),
                filename: "A001.JPG".to_string(),
                shot_at,
                camera: Some("Canon EOS R5".to_string()),
                rating: Some(4),
                size_bytes: 8,
            },
            ScannedFile {
                path: PathBuf::from("/tmp/DCIM/A002.CR3"),
                filename: "A002.CR3".to_string(),
                shot_at,
                camera: Some("Canon EOS R5".to_string()),
                rating: Some(4),
                size_bytes: 10,
            },
        ];

        let filtered = filter_files_for_import(files, 0, MediaSelection::Paired, None, None);
        assert_eq!(filtered.len(), 2);
        assert!(filtered.iter().any(|file| file.filename == "A001.CR3"));
        assert!(filtered.iter().any(|file| file.filename == "A001.JPG"));
        assert!(!filtered.iter().any(|file| file.filename == "A002.CR3"));
    }

    #[test]
    fn pair_raw_jpeg_respects_date_and_rating_filters_before_pairing() {
        let included_shot_at = Local
            .with_ymd_and_hms(2026, 3, 26, 9, 15, 30)
            .single()
            .expect("valid datetime");
        let excluded_shot_at = Local
            .with_ymd_and_hms(2026, 3, 20, 9, 15, 30)
            .single()
            .expect("valid datetime");
        let files = vec![
            ScannedFile {
                path: PathBuf::from("/tmp/DCIM/B001.CR3"),
                filename: "B001.CR3".to_string(),
                shot_at: included_shot_at,
                camera: Some("Canon EOS R5".to_string()),
                rating: Some(5),
                size_bytes: 12,
            },
            ScannedFile {
                path: PathBuf::from("/tmp/DCIM/B001.JPG"),
                filename: "B001.JPG".to_string(),
                shot_at: included_shot_at,
                camera: Some("Canon EOS R5".to_string()),
                rating: Some(5),
                size_bytes: 8,
            },
            ScannedFile {
                path: PathBuf::from("/tmp/DCIM/B002.CR3"),
                filename: "B002.CR3".to_string(),
                shot_at: excluded_shot_at,
                camera: Some("Canon EOS R5".to_string()),
                rating: Some(5),
                size_bytes: 10,
            },
            ScannedFile {
                path: PathBuf::from("/tmp/DCIM/B002.JPG"),
                filename: "B002.JPG".to_string(),
                shot_at: excluded_shot_at,
                camera: Some("Canon EOS R5".to_string()),
                rating: Some(2),
                size_bytes: 7,
            },
        ];

        let filtered = filter_files_for_import(
            files,
            3,
            MediaSelection::Paired,
            Some("2026-03-25"),
            Some("2026-03-31"),
        );
        assert_eq!(filtered.len(), 2);
        assert!(filtered.iter().all(|file| file.filename.starts_with("B001")));
    }

    #[test]
    fn raw_selection_keeps_only_raw_files() {
        let shot_at = Local
            .with_ymd_and_hms(2026, 3, 26, 9, 15, 30)
            .single()
            .expect("valid datetime");
        let files = vec![
            ScannedFile {
                path: PathBuf::from("/tmp/DCIM/C001.CR3"),
                filename: "C001.CR3".to_string(),
                shot_at,
                camera: None,
                rating: Some(4),
                size_bytes: 12,
            },
            ScannedFile {
                path: PathBuf::from("/tmp/DCIM/C001.JPG"),
                filename: "C001.JPG".to_string(),
                shot_at,
                camera: None,
                rating: Some(4),
                size_bytes: 8,
            },
        ];

        let filtered = filter_files_for_import(files, 0, MediaSelection::Raw, None, None);
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].filename, "C001.CR3");
    }

    #[test]
    fn jpeg_selection_keeps_only_jpeg_files() {
        let shot_at = Local
            .with_ymd_and_hms(2026, 3, 26, 9, 15, 30)
            .single()
            .expect("valid datetime");
        let files = vec![
            ScannedFile {
                path: PathBuf::from("/tmp/DCIM/D001.ARW"),
                filename: "D001.ARW".to_string(),
                shot_at,
                camera: None,
                rating: Some(4),
                size_bytes: 14,
            },
            ScannedFile {
                path: PathBuf::from("/tmp/DCIM/D001.JPEG"),
                filename: "D001.JPEG".to_string(),
                shot_at,
                camera: None,
                rating: Some(4),
                size_bytes: 8,
            },
            ScannedFile {
                path: PathBuf::from("/tmp/DCIM/D001.PNG"),
                filename: "D001.PNG".to_string(),
                shot_at,
                camera: None,
                rating: Some(4),
                size_bytes: 7,
            },
        ];

        let filtered = filter_files_for_import(files, 0, MediaSelection::Jpeg, None, None);
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].filename, "D001.JPEG");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_removable_parser_excludes_internal_disks() {
        let info = "\
Device Location:           Internal
Removable Media:           Fixed
";

        let parsed = parse_macos_volume_info(info);
        assert!(!macos_volume_is_removable(&parsed));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_removable_parser_accepts_internal_sd_cards() {
        let info = "\
Device Location:           Internal
Removable Media:           Removable
";

        let parsed = parse_macos_volume_info(info);
        assert!(macos_volume_is_removable(&parsed));
        assert_eq!(classify_macos_source_kind(&parsed), "removable-media");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_removable_parser_accepts_external_disks() {
        let info = "\
Device Location:           External
Removable Media:           Fixed
";

        let parsed = parse_macos_volume_info(info);
        assert!(macos_volume_is_removable(&parsed));
        assert_eq!(classify_macos_source_kind(&parsed), "external-disk");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_removable_parser_accepts_removable_media() {
        let info = "\
Device Location:           Unknown
Removable Media:           Removable
";

        let parsed = parse_macos_volume_info(info);
        assert!(macos_volume_is_removable(&parsed));
        assert_eq!(classify_macos_source_kind(&parsed), "removable-media");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_source_kind_marks_external_ssd() {
        let info = "\
Device Location:           External
Removable Media:           Fixed
Solid State:               Yes
";

        let parsed = parse_macos_volume_info(info);
        assert_eq!(classify_macos_source_kind(&parsed), "external-ssd");
    }
}
