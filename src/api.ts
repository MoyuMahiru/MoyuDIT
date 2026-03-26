import type { InvokeArgs } from "@tauri-apps/api/core";
import type {
  BackendImportResult,
  DuplicateImportWarning,
  ImportHistoryEntry,
  BackendMediaEntry,
  BackendPreviewEntry,
  BackendSourceEntry,
  DetectSourcesProgressEvent,
  ImportProgressEvent,
  PendingImportResume,
  ImportPreset,
  SpaceCheckResult,
  SelectedImportFile,
  ScanProgressEvent
} from "./types";

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function invokeCommand<T>(command: string, payload: object): Promise<T> {
  if (!isTauriRuntime()) {
    throw new Error("当前是浏览器预览模式，请使用 `npm run tauri dev` 运行桌面版。");
  }

  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, payload as InvokeArgs);
}

export async function resolveMediaPreviewUrl(path: string): Promise<string | null> {
  if (!isTauriRuntime()) {
    return null;
  }

  return invokeCommand<string>("load_media_preview", { path });
}

export async function chooseDirectory(defaultPath?: string): Promise<string | null> {
  if (!isTauriRuntime()) {
    return null;
  }

  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({
    directory: true,
    multiple: false,
    defaultPath
  });

  return typeof selected === "string" ? selected : null;
}

export async function chooseSaveFile(
  defaultPath?: string,
  suggestedName?: string
): Promise<string | null> {
  if (!isTauriRuntime()) {
    return null;
  }

  const { save } = await import("@tauri-apps/plugin-dialog");
  const selected = await save({
    defaultPath: defaultPath && suggestedName ? `${defaultPath}/${suggestedName}` : defaultPath,
    filters: [{ name: "JSON", extensions: ["json"] }]
  });

  return typeof selected === "string" ? selected : null;
}

export async function detectSources(): Promise<BackendSourceEntry[]> {
  return invokeCommand("detect_sources", {});
}

export async function getImportHistory(): Promise<ImportHistoryEntry[]> {
  return invokeCommand("get_import_history", {});
}

export async function getPendingImportResume(): Promise<PendingImportResume | null> {
  return invokeCommand("get_pending_import_resume", {});
}

export async function dismissPendingImportResume(): Promise<void> {
  return invokeCommand("dismiss_pending_import_resume", {});
}

export async function getDuplicateImportWarning(
  sourceRoot: string
): Promise<DuplicateImportWarning | null> {
  return invokeCommand("get_duplicate_import_warning", { sourceRoot });
}

export async function openInFileManager(path: string): Promise<void> {
  return invokeCommand("open_in_file_manager", { path });
}

export async function cancelImport(): Promise<void> {
  return invokeCommand("cancel_import", {});
}

export async function exportImportReport(path: string, report: object): Promise<void> {
  return invokeCommand("export_import_report", { request: { path, report } });
}

export async function checkTargetSpace(
  sourceRoot: string,
  preset: ImportPreset,
  selectedFiles?: SelectedImportFile[]
): Promise<SpaceCheckResult> {
  return invokeCommand("check_target_space", {
    request: {
      sourceRoot,
      targetRoot: preset.targetRoot,
      backupTargetRoot: preset.backupTargetRoot || null,
      minRating: preset.minRating,
      mediaSelection: preset.mediaSelection,
      startDate: preset.dateFilterEnabled ? preset.dateFrom || null : null,
      endDate: preset.dateFilterEnabled ? preset.dateTo || null : null,
      recursive: preset.recursive,
      selectedFiles: selectedFiles ?? null
    }
  });
}

export async function subscribeImportProgress(
  handler: (event: ImportProgressEvent) => void
): Promise<() => void> {
  if (!isTauriRuntime()) {
    return () => {};
  }

  const { listen } = await import("@tauri-apps/api/event");
  const unlisten = await listen<ImportProgressEvent>("import-progress", (event) => {
    handler(event.payload);
  });

  return unlisten;
}

export async function subscribeDetectSourcesProgress(
  handler: (event: DetectSourcesProgressEvent) => void
): Promise<() => void> {
  if (!isTauriRuntime()) {
    return () => {};
  }

  const { listen } = await import("@tauri-apps/api/event");
  const unlisten = await listen<DetectSourcesProgressEvent>("detect-sources-progress", (event) => {
    handler(event.payload);
  });

  return unlisten;
}

export async function subscribeScanProgress(
  handler: (event: ScanProgressEvent) => void
): Promise<() => void> {
  if (!isTauriRuntime()) {
    return () => {};
  }

  const { listen } = await import("@tauri-apps/api/event");
  const unlisten = await listen<ScanProgressEvent>("scan-progress", (event) => {
    handler(event.payload);
  });

  return unlisten;
}

export async function scanCard(root: string, recursive: boolean): Promise<BackendMediaEntry[]> {
  return invokeCommand("scan_card", {
    request: {
      root,
      recursive
    }
  });
}

export async function previewImport(
  sourceRoot: string,
  preset: ImportPreset,
  selectedFiles?: SelectedImportFile[]
): Promise<BackendPreviewEntry[]> {
  return invokeCommand("preview_import", {
    request: {
      sourceRoot,
      targetRoot: preset.targetRoot,
      backupTargetRoot: preset.backupTargetRoot || null,
      pathTemplate: preset.pathTemplate,
      filenameTemplate: preset.filenameTemplate,
      minRating: preset.minRating,
      mediaSelection: preset.mediaSelection,
      startDate: preset.dateFilterEnabled ? preset.dateFrom || null : null,
      endDate: preset.dateFilterEnabled ? preset.dateTo || null : null,
      recursive: preset.recursive,
      selectedFiles: selectedFiles ?? null
    }
  });
}

export async function runImport(
  sourceRoot: string,
  preset: ImportPreset,
  selectedFiles?: SelectedImportFile[]
): Promise<BackendImportResult> {
  return invokeCommand("run_import", {
    request: {
      sourceRoot,
      targetRoot: preset.targetRoot,
      backupTargetRoot: preset.backupTargetRoot || null,
      pathTemplate: preset.pathTemplate,
      filenameTemplate: preset.filenameTemplate,
      minRating: preset.minRating,
      mediaSelection: preset.mediaSelection,
      startDate: preset.dateFilterEnabled ? preset.dateFrom || null : null,
      endDate: preset.dateFilterEnabled ? preset.dateTo || null : null,
      recursive: preset.recursive,
      verifyMode: preset.verifyMode === "md5" ? "md5" : "blake3",
      duplicateStrategy: preset.duplicateStrategy,
      writeXmp: preset.writeXmp,
      selectedFiles: selectedFiles ?? null
    }
  });
}

export async function resumePendingImport(): Promise<BackendImportResult> {
  return invokeCommand("resume_pending_import", {});
}
