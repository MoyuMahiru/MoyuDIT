import { startTransition, useEffect, useMemo, useState } from "react";
import {
  cancelImport,
  checkTargetSpace,
  chooseDirectory,
  detectSources,
  dismissPendingImportResume,
  getDuplicateImportWarning,
  getImportHistory,
  getPendingImportResume,
  openInFileManager,
  previewImport,
  resolveMediaPreviewUrl,
  resumePendingImport,
  runImport,
  scanCard,
  subscribeDetectSourcesProgress,
  subscribeImportProgress,
  subscribeScanProgress
} from "./api";
import type {
  BackendImportResult,
  BackendMediaEntry,
  BackendPreviewEntry,
  BackendSourceEntry,
  DetectSourcesProgressEvent,
  DuplicateImportWarning,
  ImportHistoryEntry,
  ImportPreset,
  ImportStat,
  ImportProgressEvent,
  PendingImportResume,
  SelectedImportFile,
  SavedImportPreset,
  ScanProgressEvent,
  SpaceCheckResult,
  ImportTask,
  MediaFile,
  Rating
} from "./types";

const ratingLabel = ["未评", "1 星", "2 星", "3 星", "4 星", "5 星"];
const archiveModeTemplates = {
  year: "{YYYY}",
  month: "{YYYY}/{MM}",
  date: "{YYYY}/{YYYY-MM-DD}",
  "date-camera": "{YYYY}/{YYYY-MM-DD}/{camera}"
} as const;
const archiveModeLabels = {
  year: "按年份",
  month: "按年月",
  date: "按日期",
  "date-camera": "按日期 + 机型"
} as const;
const datePresetLabels = {
  today: "今天",
  yesterday: "昨天",
  last7: "最近 7 天",
  custom: "自定义"
} as const;
const sourceKindLabels: Record<string, string> = {
  "external-ssd": "外置 SSD",
  "external-ssd-dcim": "外置 SSD · DCIM",
  "external-disk": "外置硬盘",
  "external-disk-dcim": "外置硬盘 · DCIM",
  "removable-media": "可移动介质",
  "removable-media-dcim": "可移动介质 · DCIM",
  "removable-volume": "可移动卷",
  dcim: "DCIM 目录"
};
const rawFormats = new Set([
  "3FR",
  "ARW",
  "CR2",
  "CR3",
  "DNG",
  "ERF",
  "KDC",
  "MEF",
  "MOS",
  "MRW",
  "NEF",
  "NRW",
  "ORF",
  "PEF",
  "RAF",
  "RAW",
  "RW2",
  "SR2",
  "SRF"
]);
const imageFormats = new Set(["JPG", "JPEG", "PNG", "TIFF", "TIF", "HEIC", "GIF"]);
const jpegFormats = new Set(["JPG", "JPEG"]);
const directPreviewFormats = new Set(["JPG", "JPEG", "PNG", "GIF", "WEBP", "BMP"]);
const presetStorageKey = "photo-ingest-studio.saved-presets.v1";

const initialPreset: ImportPreset = {
  targetRoot: "",
  backupTargetRoot: "",
  archiveMode: "date",
  pathTemplate: archiveModeTemplates.date,
  filenameTemplate: "{original}",
  importMode: "rated",
  minRating: 3,
  mediaSelection: "all",
  dateFilterEnabled: false,
  datePreset: "custom",
  dateFrom: "",
  dateTo: "",
  duplicateStrategy: "skip",
  verifyMode: "md5",
  writeXmp: true,
  openPrimaryAfterImport: false,
  openBackupAfterImport: false,
  recursive: true
};

function stars(rating: Rating): string {
  return "★".repeat(rating) + "☆".repeat(5 - rating);
}

function formatShotAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString("zh-CN", { hour12: false });
}

function formatShortDate(value: string | null): string {
  if (!value) {
    return "未知";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleDateString("zh-CN");
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  let current = value;
  let index = 0;
  while (current >= 1024 && index < units.length - 1) {
    current /= 1024;
    index += 1;
  }
  const digits = current >= 10 || index === 0 ? 0 : 1;
  return `${current.toFixed(digits)} ${units[index]}`;
}

function failureCategoryLabel(category: string): string {
  switch (category) {
    case "permission":
      return "权限";
    case "space":
      return "空间";
    case "verification":
      return "校验";
    case "duplicate":
      return "重复";
    case "missing":
      return "丢失";
    default:
      return "读写";
  }
}

function destinationStatusLabel(hasPath: boolean, failed: number): string {
  if (!hasPath) {
    return "未启用";
  }
  if (failed > 0) {
    return "有异常";
  }
  return "已写入";
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function toDateInputValue(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addDays(base: Date, days: number): Date {
  const next = new Date(base);
  next.setDate(next.getDate() + days);
  return next;
}

function resolveDatePreset(
  preset: ImportPreset["datePreset"]
): { dateFrom: string; dateTo: string } {
  const today = new Date();
  const todayValue = toDateInputValue(today);

  switch (preset) {
    case "today":
      return { dateFrom: todayValue, dateTo: todayValue };
    case "yesterday": {
      const yesterday = toDateInputValue(addDays(today, -1));
      return { dateFrom: yesterday, dateTo: yesterday };
    }
    case "last7":
      return { dateFrom: toDateInputValue(addDays(today, -6)), dateTo: todayValue };
    case "custom":
      return { dateFrom: "", dateTo: "" };
  }
}

function extensionOf(filename: string): string {
  const extension = filename.split(".").pop();
  return extension ? extension.toUpperCase() : "FILE";
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function waitForNextPaint(): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(() => {
      window.requestAnimationFrame(() => resolve());
    }, 0);
  });
}

function sourceFingerprint(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  if (normalized.endsWith("/DCIM")) {
    return normalized.slice(0, -5);
  }
  if (normalized.endsWith("/PRIVATE/M4ROOT")) {
    return normalized.slice(0, -"/PRIVATE/M4ROOT".length);
  }
  return normalized;
}

function sourceKindLabel(kind: string): string {
  return sourceKindLabels[kind] ?? "可导入来源";
}

function toMediaFile(entry: BackendMediaEntry): MediaFile {
  const rating = Math.max(0, Math.min(5, entry.rating ?? 0)) as Rating;

  return {
    id: entry.sourcePath,
    filename: entry.filename,
    shotAt: entry.shotAt ? formatShotAt(entry.shotAt) : "未找到拍摄时间",
    shotAtRaw: entry.shotAt,
    camera: entry.camera ?? "Unknown Camera",
    format: extensionOf(entry.filename),
    sizeMb: Number((entry.sizeBytes / 1024 / 1024).toFixed(1)),
    md5Status: "pending",
    rating
  };
}

function effectiveMinRating(preset: ImportPreset): Rating {
  return (preset.importMode === "all" ? 0 : preset.minRating) as Rating;
}

function matchesDateRange(file: MediaFile, preset: ImportPreset): boolean {
  if (!preset.dateFilterEnabled || !file.shotAtRaw) {
    return true;
  }

  const shotDate = file.shotAtRaw.slice(0, 10);
  if (preset.dateFrom && shotDate < preset.dateFrom) {
    return false;
  }
  if (preset.dateTo && shotDate > preset.dateTo) {
    return false;
  }
  return true;
}

function importGroupKey(file: MediaFile): string {
  const normalized = file.id.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  const directory = slash >= 0 ? normalized.slice(0, slash) : "";
  const dot = file.filename.lastIndexOf(".");
  const stem = (dot >= 0 ? file.filename.slice(0, dot) : file.filename).toLowerCase();
  return `${directory}::${stem}`;
}

function filterFilesForPreset(files: MediaFile[], preset: ImportPreset): MediaFile[] {
  const filtered = files.filter(
    (file) => file.rating >= effectiveMinRating(preset) && matchesDateRange(file, preset)
  );
  return applyMediaSelection(filtered, preset);
}

function applyMediaSelection(files: MediaFile[], preset: ImportPreset): MediaFile[] {
  if (preset.mediaSelection === "raw") {
    return files.filter((file) => rawFormats.has(file.format));
  }
  if (preset.mediaSelection === "jpeg") {
    return files.filter((file) => jpegFormats.has(file.format));
  }
  if (preset.mediaSelection !== "paired") {
    return files;
  }

  const pairState = new Map<string, { hasRaw: boolean; hasJpeg: boolean }>();
  for (const file of files) {
    const key = importGroupKey(file);
    const current = pairState.get(key) ?? { hasRaw: false, hasJpeg: false };
    if (rawFormats.has(file.format)) {
      current.hasRaw = true;
    }
    if (jpegFormats.has(file.format)) {
      current.hasJpeg = true;
    }
    pairState.set(key, current);
  }

  return files.filter((file) => {
    const state = pairState.get(importGroupKey(file));
    return Boolean(state?.hasRaw && state?.hasJpeg);
  });
}

function buildSelectedImportFiles(files: MediaFile[]): SelectedImportFile[] {
  return files.map((file) => ({
    sourcePath: file.id,
    rating: file.rating
  }));
}

function findPreviewSourcePath(file: MediaFile, files: MediaFile[]): string | null {
  if (directPreviewFormats.has(file.format)) {
    return file.id;
  }

  if (!rawFormats.has(file.format)) {
    return null;
  }

  const key = importGroupKey(file);
  const pairedJpeg = files.find(
    (candidate) => candidate.id !== file.id && importGroupKey(candidate) === key && jpegFormats.has(candidate.format)
  );
  return pairedJpeg?.id ?? null;
}

function hasInvalidDateRange(preset: ImportPreset): boolean {
  return Boolean(
    preset.dateFilterEnabled &&
      preset.dateFrom &&
      preset.dateTo &&
      preset.dateFrom > preset.dateTo
  );
}

function buildStats(
  files: MediaFile[],
  previews: BackendPreviewEntry[],
  preset: ImportPreset,
  result: BackendImportResult | null
): ImportStat[] {
  const eligible = filterFilesForPreset(files, preset).length;
  const filtered = files.length - eligible;
  const duplicateCount = previews.filter((entry) => entry.exists).length;

  return [
    { label: "本次可导入", value: `${eligible} 张` },
    {
      label: "已被筛掉",
      value: `${Math.max(filtered, 0)} 张`,
      tone: filtered > 0 ? "warning" : "neutral"
    },
    { label: "可能重复", value: `${duplicateCount} 张` },
    {
      label: "最近一次导入",
      value: result ? `${result.imported} 成功 / ${result.failed} 失败` : "尚未执行",
      tone: result && result.failed === 0 ? "success" : "neutral"
    }
  ];
}

function buildTasks(
  files: MediaFile[],
  previews: BackendPreviewEntry[],
  preset: ImportPreset,
  isAnalyzing: boolean,
  isPlanning: boolean,
  isImporting: boolean,
  progressEvent: ImportProgressEvent | null,
  result: BackendImportResult | null
): ImportTask[] {
  return [
    {
      step: "读取素材",
      detail: files.length > 0 ? `${files.length} 个文件` : "选择来源后开始读取",
      progress: isAnalyzing ? 45 : files.length > 0 ? 100 : 0
    },
    {
      step: "导入设置",
      detail: previews.length > 0
        ? `方案已更新，${previews.length} 个文件进入导入计划`
        : "等待生成导入计划",
      progress: isPlanning ? 50 : previews.length > 0 ? 100 : 0
    },
    {
      step: "执行拷贝与校验",
      detail: isImporting
        ? progressEvent?.message ?? "正在拷贝文件并校验哈希"
        : result
          ? `最近一次已校验 ${result.verified} 个文件`
          : "等待导入",
      progress: isImporting ? (progressEvent?.progress ?? 5) : result ? 100 : 0
    },
    {
      step: "星级筛选",
      detail:
        preset.importMode === "all"
          ? "当前为全部导入，不使用星级门槛"
          : `仅导入 ${ratingLabel[preset.minRating]} 及以上的已有评级`,
      progress: files.length > 0 ? 100 : 0
    },
    {
      step: "素材类型",
      detail:
        preset.mediaSelection === "raw"
          ? "当前仅导入 RAW 文件"
          : preset.mediaSelection === "jpeg"
            ? "当前仅导入 JPG/JPEG 文件"
            : preset.mediaSelection === "paired"
              ? "仅导入同时存在 RAW 和 JPG/JPEG 的成对素材"
              : "当前不限制素材类型",
      progress: files.length > 0 ? 100 : 0
    }
  ];
}

function analyzeFiles(files: MediaFile[]) {
  const totalSizeMb = files.reduce((sum, file) => sum + file.sizeMb, 0);
  const rawCount = files.filter((file) => rawFormats.has(file.format)).length;
  const imageCount = files.filter((file) => imageFormats.has(file.format)).length;
  const dates = files
    .map((file) => file.shotAtRaw)
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => new Date(left).getTime() - new Date(right).getTime());
  const cameras = Array.from(new Set(files.map((file) => file.camera))).slice(0, 4);

  return {
    totalSizeMb: Number(totalSizeMb.toFixed(1)),
    rawCount,
    imageCount,
    cameras,
    from: dates[0] ?? null,
    to: dates[dates.length - 1] ?? null
  };
}

async function generatePlan(
  sourceRoot: string,
  preset: ImportPreset,
  selectedFiles: SelectedImportFile[],
  setPreviewEntries: (entries: BackendPreviewEntry[]) => void
): Promise<BackendPreviewEntry[]> {
  const entries = await previewImport(sourceRoot, {
    ...preset,
    minRating: effectiveMinRating(preset)
  }, selectedFiles);
  setPreviewEntries(entries);
  return entries;
}

function readSavedPresets(): SavedImportPreset[] {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    const raw = window.localStorage.getItem(presetStorageKey);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as SavedImportPreset[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeSavedPresets(entries: SavedImportPreset[]) {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(presetStorageKey, JSON.stringify(entries));
}

function App() {
  const [sourceRoot, setSourceRoot] = useState("");
  const [sourceCandidates, setSourceCandidates] = useState<BackendSourceEntry[]>([]);
  const [preset, setPreset] = useState<ImportPreset>(initialPreset);
  const [mediaFiles, setMediaFiles] = useState<MediaFile[]>([]);
  const [previewEntries, setPreviewEntries] = useState<BackendPreviewEntry[]>([]);
  const [importResult, setImportResult] = useState<BackendImportResult | null>(null);
  const [importProgress, setImportProgress] = useState<ImportProgressEvent | null>(null);
  const [detectProgress, setDetectProgress] = useState<DetectSourcesProgressEvent | null>(null);
  const [scanProgress, setScanProgress] = useState<ScanProgressEvent | null>(null);
  const [isDetectingSources, setIsDetectingSources] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isPlanning, setIsPlanning] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [analysisSourceRoot, setAnalysisSourceRoot] = useState("");
  const [importHistory, setImportHistory] = useState<ImportHistoryEntry[]>([]);
  const [pendingResume, setPendingResume] = useState<PendingImportResume | null>(null);
  const [savedPresets, setSavedPresets] = useState<SavedImportPreset[]>([]);
  const [presetName, setPresetName] = useState("");
  const [activePresetId, setActivePresetId] = useState("");
  const [duplicateWarning, setDuplicateWarning] = useState<DuplicateImportWarning | null>(null);
  const [error, setError] = useState("");
  const [latestImportError, setLatestImportError] = useState<string>("");
  const [isExportingReport, setIsExportingReport] = useState(false);
  const [isResumingImport, setIsResumingImport] = useState(false);
  const [isCheckingSpace, setIsCheckingSpace] = useState(false);
  const [isCancellingImport, setIsCancellingImport] = useState(false);
  const [spaceCheck, setSpaceCheck] = useState<SpaceCheckResult | null>(null);
  const [previewUrls, setPreviewUrls] = useState<Record<string, string>>({});
  const [brokenPreviewIds, setBrokenPreviewIds] = useState<Record<string, boolean>>({});
  const [activePreviewId, setActivePreviewId] = useState<string | null>(null);
  const [activePreviewUrl, setActivePreviewUrl] = useState<string | null>(null);
  const [isActivePreviewLoading, setIsActivePreviewLoading] = useState(false);
  const [ratingOverrides, setRatingOverrides] = useState<Record<string, Rating>>({});
  const [selectionOverrides, setSelectionOverrides] = useState<Record<string, boolean>>({});
  const [statusMessage, setStatusMessage] = useState("先插卡，或手动选择一张储存卡目录。");

  const adjustedMediaFiles = useMemo(
    () =>
      mediaFiles.map((file) => ({
        ...file,
        rating: ratingOverrides[file.id] ?? file.rating
      })),
    [mediaFiles, ratingOverrides]
  );
  const fileAnalysis = useMemo(() => analyzeFiles(adjustedMediaFiles), [adjustedMediaFiles]);
  const autoFilteredFiles = useMemo(
    () => filterFilesForPreset(adjustedMediaFiles, preset),
    [adjustedMediaFiles, preset]
  );
  const autoFilteredFileIds = useMemo(
    () => new Set(autoFilteredFiles.map((file) => file.id)),
    [autoFilteredFiles]
  );
  const filteredFiles = useMemo(() => {
    return applyMediaSelection(
      adjustedMediaFiles.filter((file) => {
        const manual = selectionOverrides[file.id];
        if (manual === true) {
          return true;
        }
        if (manual === false) {
          return false;
        }
        return autoFilteredFileIds.has(file.id);
      }),
      { ...preset, mediaSelection: "all" }
    );
  }, [adjustedMediaFiles, autoFilteredFileIds, selectionOverrides, preset]);
  const filteredFileIds = useMemo(
    () => new Set(filteredFiles.map((file) => file.id)),
    [filteredFiles]
  );
  const selectedImportFiles = useMemo(
    () => buildSelectedImportFiles(filteredFiles),
    [filteredFiles]
  );
  const visiblePreviewFiles = useMemo(() => adjustedMediaFiles.slice(0, 24), [adjustedMediaFiles]);
  const previewSourcePaths = useMemo(
    () =>
      Object.fromEntries(
        adjustedMediaFiles.map((file) => [file.id, findPreviewSourcePath(file, adjustedMediaFiles)])
      ) as Record<string, string | null>,
    [adjustedMediaFiles]
  );
  const activePreviewIndex = useMemo(
    () => visiblePreviewFiles.findIndex((file) => file.id === activePreviewId),
    [activePreviewId, visiblePreviewFiles]
  );
  const activePreviewFile =
    activePreviewIndex >= 0 ? visiblePreviewFiles[activePreviewIndex] : null;
  const previewSample = previewEntries[0]?.targetPath ?? "生成计划后显示目标路径";
  const stats = useMemo(
    () => buildStats(mediaFiles, previewEntries, preset, importResult),
    [importResult, mediaFiles, preset, previewEntries]
  );
  const failureSummary = useMemo(() => {
    if (!importResult) {
      return [];
    }
    const counts = new Map<string, number>();
    for (const detail of importResult.failureDetails) {
      counts.set(detail.category, (counts.get(detail.category) ?? 0) + 1);
    }
    return Array.from(counts.entries()).sort((left, right) => right[1] - left[1]);
  }, [importResult]);
  const tasks = useMemo(
    () =>
      buildTasks(
        mediaFiles,
        previewEntries,
        preset,
        isAnalyzing,
        isPlanning,
        isImporting,
        importProgress,
        importResult
      ),
    [
      importProgress,
      importResult,
      isAnalyzing,
      isImporting,
      isPlanning,
      mediaFiles,
      preset,
      previewEntries
    ]
  );

  useEffect(() => {
    let active = true;
    const candidates = visiblePreviewFiles
      .map((file) => ({ file, sourcePath: previewSourcePaths[file.id] }))
      .filter(
        (entry) =>
          entry.sourcePath &&
          !previewUrls[entry.file.id] &&
          !brokenPreviewIds[entry.file.id]
      );

    if (candidates.length === 0) {
      return () => {
        active = false;
      };
    }

    void Promise.all(
      candidates.map(async ({ file, sourcePath }) => ({
        id: file.id,
        url: await resolveMediaPreviewUrl(sourcePath!)
      }))
    ).then((entries) => {
      if (!active) {
        return;
      }
      setPreviewUrls((current) => {
        const next = { ...current };
        for (const entry of entries) {
          if (entry.url) {
            next[entry.id] = entry.url;
          }
        }
        return next;
      });
    });

    return () => {
      active = false;
    };
  }, [visiblePreviewFiles, previewUrls, brokenPreviewIds, previewSourcePaths]);

  useEffect(() => {
    if (!activePreviewFile) {
      setActivePreviewUrl(null);
      setIsActivePreviewLoading(false);
      return;
    }

    const sourcePath = previewSourcePaths[activePreviewFile.id];

    if (!sourcePath || brokenPreviewIds[activePreviewFile.id]) {
      setActivePreviewUrl(null);
      setIsActivePreviewLoading(false);
      return;
    }

    if (previewUrls[activePreviewFile.id]) {
      setActivePreviewUrl(previewUrls[activePreviewFile.id]);
      setIsActivePreviewLoading(false);
      return;
    }

    let active = true;
    setIsActivePreviewLoading(true);

    void resolveMediaPreviewUrl(sourcePath)
      .then((url) => {
        if (!active) {
          return;
        }
        if (url) {
          setPreviewUrls((current) => ({ ...current, [activePreviewFile.id]: url }));
          setActivePreviewUrl(url);
        } else {
          setActivePreviewUrl(null);
        }
      })
      .finally(() => {
        if (active) {
          setIsActivePreviewLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [activePreviewFile, previewUrls, brokenPreviewIds, previewSourcePaths]);

  useEffect(() => {
    if (!activePreviewFile) {
      return;
    }

    const handleKeydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setActivePreviewId(null);
        return;
      }

      if (event.key === " ") {
        event.preventDefault();
        const currentlyIncluded = filteredFiles.some((file) => file.id === activePreviewFile.id);
        setSelectionOverrides((current) => ({
          ...current,
          [activePreviewFile.id]: !currentlyIncluded
        }));
        return;
      }

      if (["0", "1", "2", "3", "4", "5"].includes(event.key)) {
        const rating = Number(event.key) as Rating;
        setRatingOverrides((current) => ({ ...current, [activePreviewFile.id]: rating }));
        return;
      }

      if (event.key === "ArrowRight" && activePreviewIndex < visiblePreviewFiles.length - 1) {
        setActivePreviewId(visiblePreviewFiles[activePreviewIndex + 1].id);
      }

      if (event.key === "ArrowLeft" && activePreviewIndex > 0) {
        setActivePreviewId(visiblePreviewFiles[activePreviewIndex - 1].id);
      }
    };

    window.addEventListener("keydown", handleKeydown);
    return () => {
      window.removeEventListener("keydown", handleKeydown);
    };
  }, [activePreviewFile, activePreviewIndex, visiblePreviewFiles, filteredFiles]);

  useEffect(() => {
    let mounted = true;
    let teardown: (() => void) | null = null;
    let teardownDetect: (() => void) | null = null;
    let teardownScan: (() => void) | null = null;

    void subscribeImportProgress((event) => {
      if (!mounted) {
        return;
      }
      setImportProgress(event);
      setStatusMessage(event.message);
      if (event.latestError) {
        setLatestImportError(`${event.latestError.filename}: ${event.latestError.reason}`);
      }
    }).then((unlisten) => {
      teardown = unlisten;
    });

    void subscribeDetectSourcesProgress((event) => {
      if (!mounted) {
        return;
      }
      setDetectProgress(event);
    }).then((unlisten) => {
      teardownDetect = unlisten;
    });

    void subscribeScanProgress((event) => {
      if (!mounted) {
        return;
      }
      setScanProgress(event);
    }).then((unlisten) => {
      teardownScan = unlisten;
    });

    return () => {
      mounted = false;
      if (teardown) {
        teardown();
      }
      if (teardownDetect) {
        teardownDetect();
      }
      if (teardownScan) {
        teardownScan();
      }
    };
  }, []);

  useEffect(() => {
    setSavedPresets(readSavedPresets());
  }, []);

  useEffect(() => {
    let active = true;
    void getImportHistory()
      .then((entries) => {
        if (active) {
          setImportHistory(entries);
        }
      })
      .catch(() => {});

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    void getPendingImportResume()
      .then((resume) => {
        if (active) {
          setPendingResume(resume);
        }
      })
      .catch(() => {});

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!sourceRoot.trim()) {
      setDuplicateWarning(null);
      return;
    }

    let active = true;
    void getDuplicateImportWarning(sourceRoot)
      .then((warning) => {
        if (active) {
          setDuplicateWarning(warning);
        }
      })
      .catch(() => {
        if (active) {
          setDuplicateWarning(null);
        }
      });

    return () => {
      active = false;
    };
  }, [sourceRoot]);

  useEffect(() => {
    if (!sourceRoot.trim() || mediaFiles.length === 0) {
      return;
    }

    if (!preset.targetRoot.trim()) {
      startTransition(() => {
        setPreviewEntries([]);
      });
      return;
    }

    if (hasInvalidDateRange(preset) || isAnalyzing || isImporting) {
      return;
    }

    const timer = window.setTimeout(() => {
      setIsPlanning(true);
      setError("");
      void generatePlan(sourceRoot, preset, selectedImportFiles, setPreviewEntries)
        .then((plan) => {
          setStatusMessage(`导入计划已自动更新，当前计划导入 ${plan.length} 个文件。`);
        })
        .catch((planError) => {
          const message = planError instanceof Error ? planError.message : "导入方案生成失败。";
          setError(message);
          setStatusMessage("导入方案未更新。");
        })
        .finally(() => {
          setIsPlanning(false);
        });
    }, 240);

    return () => {
      window.clearTimeout(timer);
    };
  }, [
    sourceRoot,
    mediaFiles.length,
    preset.targetRoot,
    preset.pathTemplate,
    preset.filenameTemplate,
    preset.importMode,
    preset.minRating,
    preset.mediaSelection,
    preset.dateFilterEnabled,
    preset.dateFrom,
    preset.dateTo,
    preset.recursive,
    selectedImportFiles,
    isAnalyzing,
    isImporting
  ]);

  useEffect(() => {
    if (!sourceRoot.trim() || !preset.targetRoot.trim() || mediaFiles.length === 0) {
      setSpaceCheck(null);
      return;
    }

    if (isAnalyzing || isImporting || hasInvalidDateRange(preset)) {
      return;
    }

    let active = true;
    const timer = window.setTimeout(() => {
      setIsCheckingSpace(true);
      void checkTargetSpace(
        sourceRoot,
        { ...preset, minRating: effectiveMinRating(preset) },
        selectedImportFiles
      )
        .then((result) => {
          if (active) {
            setSpaceCheck(result);
          }
        })
        .catch(() => {
          if (active) {
            setSpaceCheck(null);
          }
        })
        .finally(() => {
          if (active) {
            setIsCheckingSpace(false);
          }
        });
    }, 220);

    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [
    sourceRoot,
    preset.targetRoot,
    preset.backupTargetRoot,
    preset.importMode,
    preset.minRating,
    preset.mediaSelection,
    preset.dateFilterEnabled,
    preset.dateFrom,
    preset.dateTo,
    preset.recursive,
    mediaFiles.length,
    selectedImportFiles,
    isAnalyzing,
    isImporting
  ]);

  const updatePreset = <K extends keyof ImportPreset>(key: K, value: ImportPreset[K]) => {
    setPreset((current) => {
      if (key === "archiveMode") {
        const archiveMode = value as ImportPreset["archiveMode"];
        return {
          ...current,
          archiveMode,
          pathTemplate: archiveModeTemplates[archiveMode]
        };
      }
      if (key === "datePreset") {
        const datePreset = value as ImportPreset["datePreset"];
        const range = resolveDatePreset(datePreset);
        return {
          ...current,
          datePreset,
          dateFrom: datePreset === "custom" ? current.dateFrom : range.dateFrom,
          dateTo: datePreset === "custom" ? current.dateTo : range.dateTo
        };
      }
      return { ...current, [key]: value };
    });
  };

  const analyzeSource = async (nextSourceRoot: string) => {
    if (!nextSourceRoot.trim()) {
      setError("请先选择来源目录。");
      return;
    }

    setSourceRoot(nextSourceRoot);
    setIsAnalyzing(true);
    setAnalysisSourceRoot(nextSourceRoot);
    setError("");
    setScanProgress(null);
    setMediaFiles([]);
    setPreviewEntries([]);
    setSpaceCheck(null);
    setPreviewUrls({});
    setBrokenPreviewIds({});
    setActivePreviewId(null);
    setRatingOverrides({});
    setSelectionOverrides({});
    setImportResult(null);
    setImportProgress(null);
    setStatusMessage(`已选择 ${basename(nextSourceRoot)}，正在读取卡内文件和元数据。`);

    await waitForNextPaint();

    try {
      const entries = await scanCard(nextSourceRoot, preset.recursive);
      const files = entries.map(toMediaFile);
      startTransition(() => {
        setMediaFiles(files);
      });

      if (preset.targetRoot.trim() && !hasInvalidDateRange(preset)) {
        setStatusMessage(`分析完成，识别到 ${files.length} 个文件，正在自动生成导入计划。`);
      } else {
        startTransition(() => {
          setPreviewEntries([]);
        });
        setStatusMessage(
          hasInvalidDateRange(preset)
            ? `分析完成，识别到 ${files.length} 个文件。请先修正日期范围。`
            : `分析完成，识别到 ${files.length} 个文件。下一步请确认目标目录和导入规则。`
        );
      }
    } catch (analysisError) {
      const message = analysisError instanceof Error ? analysisError.message : "分析失败。";
      setError(message);
      setStatusMessage("素材分析未完成。");
    } finally {
      setIsPlanning(false);
      setIsAnalyzing(false);
      setAnalysisSourceRoot("");
    }
  };

  const handleChooseSource = async () => {
    const selected = await chooseDirectory(sourceRoot || undefined);
    if (selected) {
      void analyzeSource(selected);
    } else if (!sourceRoot) {
      setStatusMessage("浏览器预览模式下不能弹出系统目录选择器，请手动填写路径。");
    }
  };

  const handleChooseTarget = async () => {
    const selected = await chooseDirectory(preset.targetRoot || undefined);
    if (selected) {
      updatePreset("targetRoot", selected);
      setError("");
      setStatusMessage("目标目录已设置。");
    } else if (!preset.targetRoot) {
      setStatusMessage("浏览器预览模式下请手动填写目标目录。");
    }
  };

  const handleChooseBackupTarget = async () => {
    const selected = await chooseDirectory(preset.backupTargetRoot || undefined);
    if (selected) {
      updatePreset("backupTargetRoot", selected);
      setError("");
      setStatusMessage("备份目录已设置。");
    }
  };

  const handleDetectSources = async () => {
    setIsDetectingSources(true);
    setError("");
    setDetectProgress(null);
    setStatusMessage("正在查找可导入来源。");

    try {
      const entries = await detectSources();
      setSourceCandidates(entries);
      setStatusMessage(
        entries.length > 0
          ? `发现 ${entries.length} 个可导入来源。`
          : "没有发现明确的储存卡来源，仍可手动选择目录。"
      );
    } catch (detectError) {
      const message = detectError instanceof Error ? detectError.message : "来源检测失败。";
      setError(message);
      setStatusMessage("自动识别来源失败，请手动选择目录。");
    } finally {
      setIsDetectingSources(false);
    }
  };

  const handleAnalyze = async () => {
    void analyzeSource(sourceRoot);
  };

  const handleRefreshPlan = async () => {
    if (!sourceRoot.trim() || mediaFiles.length === 0) {
      setError("请先完成素材分析。");
      return;
    }

    if (!preset.targetRoot.trim()) {
      setError("请先设置目标目录。");
      return;
    }

    if (hasInvalidDateRange(preset)) {
      setError("结束日期不能早于开始日期。");
      return;
    }

    setIsPlanning(true);
    setError("");
      setStatusMessage("正在生成导入计划。");

    try {
      const plan = await generatePlan(sourceRoot, preset, selectedImportFiles, setPreviewEntries);
      setStatusMessage(`导入方案已更新，当前计划导入 ${plan.length} 个文件。`);
    } catch (planError) {
      const message = planError instanceof Error ? planError.message : "导入方案生成失败。";
      setError(message);
      setStatusMessage("导入方案未更新。");
    } finally {
      setIsPlanning(false);
    }
  };

  const handleImport = async () => {
    if (!sourceRoot.trim() || !preset.targetRoot.trim()) {
      setError("导入前需要先选好来源目录和目标目录。");
      return;
    }

    if (hasInvalidDateRange(preset)) {
      setError("结束日期不能早于开始日期。");
      return;
    }

    if (spaceCheck && (!spaceCheck.primary.enough || (spaceCheck.backup && !spaceCheck.backup.enough))) {
      setError("目标目录空间不足。");
      setStatusMessage("空间检查未通过。");
      return;
    }

    const currentFingerprint = sourceFingerprint(sourceRoot);
    const duplicateHistoryEntry = importHistory.find(
      (entry) => entry.sourceFingerprint === currentFingerprint
    );
    if (duplicateHistoryEntry) {
      const shouldContinue = window.confirm(
        `这张卡之前导入过 ${duplicateHistoryEntry.sourceLabel}。\n上次导入时间：${new Date(
          duplicateHistoryEntry.finishedAt
        ).toLocaleString("zh-CN", { hour12: false })}\n目标目录：${
          duplicateHistoryEntry.targetRoot
        }\n\n仍然继续导入吗？`
      );

      if (!shouldContinue) {
        setStatusMessage("已取消导入。");
        return;
      }
    }

    setIsImporting(true);
    setError("");
    setImportResult(null);
    setImportProgress(null);
    setLatestImportError("");
    setStatusMessage("正在导入文件，请不要移除储存卡。");

    try {
      const result = await runImport(sourceRoot, {
        ...preset,
        minRating: effectiveMinRating(preset)
      }, selectedImportFiles);
      setImportResult(result);
      const resume = await getPendingImportResume();
      setPendingResume(resume);
      const history = await getImportHistory();
      setImportHistory(history);
      if (!result.cancelled && preset.openPrimaryAfterImport) {
        void openInFileManager(result.primaryTargetRoot).catch(() => {});
      }
      if (!result.cancelled && preset.openBackupAfterImport && result.backupTargetRoot) {
        void openInFileManager(result.backupTargetRoot).catch(() => {});
      }
      setStatusMessage(
        result.cancelled
          ? `导入已取消，成功 ${result.imported}，跳过 ${result.skipped}，失败 ${result.failed}。`
          : `导入完成，成功 ${result.imported}，跳过 ${result.skipped}，失败 ${result.failed}。`
      );
    } catch (importError) {
      const message = importError instanceof Error ? importError.message : "导入失败。";
      setError(message);
      setStatusMessage("导入执行失败。");
    } finally {
      setIsImporting(false);
      setIsCancellingImport(false);
    }
  };

  const handleCancelImport = async () => {
    setIsCancellingImport(true);
    setStatusMessage("正在取消导入，会在当前文件处理完成后停止。");
    try {
      await cancelImport();
    } catch {
      setIsCancellingImport(false);
      setStatusMessage("取消导入失败，当前任务仍在继续。");
    }
  };

  const applySavedPreset = (entry: SavedImportPreset) => {
    setPreset(entry.preset);
    setPresetName(entry.name);
    setActivePresetId(entry.id);
    setError("");
    setStatusMessage(`已套用预设“${entry.name}”。`);
  };

  const handleSavePreset = () => {
    const trimmedName = presetName.trim();
    if (!trimmedName) {
      setError("请先填写预设名称。");
      return;
    }

    const nextPreset: SavedImportPreset = {
      id: activePresetId || `preset-${Date.now()}`,
      name: trimmedName,
      preset: { ...preset },
      updatedAt: new Date().toISOString()
    };

    const nextEntries = [nextPreset, ...savedPresets.filter((entry) => entry.id !== nextPreset.id)]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    setSavedPresets(nextEntries);
    writeSavedPresets(nextEntries);
    setActivePresetId(nextPreset.id);
    setError("");
    setStatusMessage(`导入预设“${trimmedName}”已保存。`);
  };

  const handleDeletePreset = (presetId: string) => {
    const target = savedPresets.find((entry) => entry.id === presetId);
    if (!target) {
      return;
    }

    const shouldDelete = window.confirm(`删除预设“${target.name}”吗？`);
    if (!shouldDelete) {
      return;
    }

    const nextEntries = savedPresets.filter((entry) => entry.id !== presetId);
    setSavedPresets(nextEntries);
    writeSavedPresets(nextEntries);
    if (activePresetId === presetId) {
      setActivePresetId("");
      setPresetName("");
    }
    setStatusMessage(`已删除预设“${target.name}”。`);
  };

  const handleBatchIncludeVisible = () => {
    setSelectionOverrides((current) => ({
      ...current,
      ...Object.fromEntries(visiblePreviewFiles.map((file) => [file.id, true]))
    }));
    setStatusMessage(`已将当前页 ${visiblePreviewFiles.length} 张素材纳入导入。`);
  };

  const handleBatchExcludeVisible = () => {
    setSelectionOverrides((current) => ({
      ...current,
      ...Object.fromEntries(visiblePreviewFiles.map((file) => [file.id, false]))
    }));
    setStatusMessage(`已将当前页 ${visiblePreviewFiles.length} 张素材排除出导入。`);
  };

  const handleKeepAutoFilter = () => {
    setSelectionOverrides({});
    setStatusMessage("已恢复自动筛选。");
  };

  const handleClearPreviewAdjustments = () => {
    setSelectionOverrides({});
    setRatingOverrides({});
    setStatusMessage("已清空临时星级和手动纳入/排除设置。");
  };

  const handleResumeImport = async () => {
    setIsResumingImport(true);
    setError("");
    setImportResult(null);
    setImportProgress(null);
    setLatestImportError("");
    setIsImporting(true);
    if (pendingResume) {
      setSourceRoot(pendingResume.sourceRoot);
    }
    setStatusMessage("正在恢复上次未完成的导入。");

    try {
      const result = await resumePendingImport();
      setImportResult(result);
      const resume = await getPendingImportResume();
      setPendingResume(resume);
      const history = await getImportHistory();
      setImportHistory(history);
      setStatusMessage(
        result.cancelled
          ? `恢复导入后再次取消，成功 ${result.imported}，跳过 ${result.skipped}，失败 ${result.failed}。`
          : `恢复导入完成，成功 ${result.imported}，跳过 ${result.skipped}，失败 ${result.failed}。`
      );
    } catch (resumeError) {
      const message = resumeError instanceof Error ? resumeError.message : "恢复导入失败。";
      setError(message);
      setStatusMessage("恢复导入失败。");
    } finally {
      setIsResumingImport(false);
      setIsImporting(false);
      setIsCancellingImport(false);
    }
  };

  const handleDismissPendingResume = async () => {
    try {
      await dismissPendingImportResume();
      setPendingResume(null);
      setStatusMessage("已删除恢复记录。");
    } catch (dismissError) {
      const message = dismissError instanceof Error ? dismissError.message : "无法删除恢复记录。";
      setError(message);
    }
  };

  const handleExportReport = async () => {
    if (!importResult) {
      return;
    }

    setIsExportingReport(true);
    setError("");

    try {
      const durationMs =
        new Date(importResult.finishedAt).getTime() - new Date(importResult.startedAt).getTime();
      const coverFile = filteredFiles.find((file) => previewSourcePaths[file.id]);
      const coverUrl =
        coverFile && previewSourcePaths[coverFile.id]
          ? previewUrls[coverFile.id] ??
            (await resolveMediaPreviewUrl(previewSourcePaths[coverFile.id] as string))
          : null;

      const printWindow = window.open("", "_blank", "width=1200,height=900");
      if (!printWindow) {
        throw new Error("无法打开打印窗口，请检查系统是否拦截了新窗口。");
      }

      const failureSummaryHtml = failureSummary
        .map(
          ([category, count]) =>
            `<span class="chip">${escapeHtml(failureCategoryLabel(category))} ${count}</span>`
        )
        .join("");
      const renamedHtml =
        importResult.renamedDetails.length > 0
          ? importResult.renamedDetails
              .slice(0, 12)
              .map(
                (detail) => `
                  <div class="list-item">
                    <strong>${escapeHtml(detail.filename)}</strong>
                    <span>${escapeHtml(detail.targetPath)}</span>
                  </div>`
              )
              .join("")
          : `<div class="list-item muted-row"><span>没有自动改名文件。</span></div>`;
      const skippedHtml =
        importResult.skippedDetails.length > 0
          ? importResult.skippedDetails
              .slice(0, 12)
              .map(
                (detail) => `
                  <div class="list-item">
                    <strong>${escapeHtml(detail.filename)}</strong>
                    <span>${escapeHtml(detail.reason)}</span>
                  </div>`
              )
              .join("")
          : `<div class="list-item muted-row"><span>没有跳过的文件。</span></div>`;
      const failuresHtml =
        importResult.failureDetails.length > 0
          ? importResult.failureDetails
              .slice(0, 12)
              .map(
                (detail) => `
                  <div class="list-item">
                    <strong>${escapeHtml(detail.filename)}</strong>
                    <span>${escapeHtml(failureCategoryLabel(detail.category))} · ${escapeHtml(detail.reason)}</span>
                  </div>`
              )
              .join("")
          : `<div class="list-item muted-row"><span>没有失败文件。</span></div>`;
      const coverHtml = coverUrl
        ? `<div class="cover-frame"><img src="${coverUrl}" alt="导入报告封面" /></div>`
        : `<div class="cover-fallback">
            <div>
              <span>导入结果</span>
              <strong>${importResult.imported} 成功 / ${importResult.failed} 失败</strong>
            </div>
            <div>
              <span>素材规模</span>
              <strong>${selectedImportFiles.length} 个文件</strong>
            </div>
          </div>`;

      const printableHtml = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>导入报告 ${escapeHtml(importResult.finishedAt.slice(0, 10))}</title>
  <style>
    @page { size: A4; margin: 16mm; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: #1d2140;
      background: #eef1ff;
      font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    }
    .page {
      padding: 28px;
      background:
        radial-gradient(circle at top right, rgba(93,72,255,0.14), transparent 24%),
        linear-gradient(180deg, #f7f8ff, #eef1ff);
    }
    .hero, .section, .metric, .list-item, .status-card, .cover-frame, .cover-fallback {
      border-radius: 18px;
      background: rgba(255,255,255,0.92);
      border: 1px solid rgba(93,72,255,0.12);
      box-shadow: 0 10px 24px rgba(40,12,255,0.08);
    }
    .hero { padding: 24px; margin-bottom: 18px; }
    .eyebrow { color: #5d48ff; font-size: 12px; letter-spacing: 0.14em; text-transform: uppercase; margin: 0 0 8px; }
    h1, h2, h3, p { margin: 0; }
    h1 { font-size: 30px; margin-bottom: 8px; }
    h2 { font-size: 18px; margin-bottom: 12px; }
    .muted { color: #66709c; line-height: 1.6; }
    .cover-frame, .cover-fallback { margin: 0 0 18px; overflow: hidden; min-height: 220px; }
    .cover-frame img { display: block; width: 100%; height: 320px; object-fit: cover; }
    .cover-fallback {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
      padding: 22px;
      background:
        radial-gradient(circle at top right, rgba(93,72,255,0.16), transparent 32%),
        linear-gradient(135deg, rgba(247,248,255,0.96), rgba(236,240,255,0.96));
    }
    .cover-fallback span { color: #66709c; font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; }
    .cover-fallback strong { display: block; margin-top: 8px; font-size: 28px; color: #1d2140; }
    .grid { display: grid; gap: 12px; }
    .metrics { grid-template-columns: repeat(4, minmax(0, 1fr)); margin-bottom: 18px; }
    .metric { padding: 16px; }
    .metric span, .status-card span, .list-item span { color: #66709c; font-size: 12px; }
    .metric strong, .status-card strong { display: block; margin-top: 8px; font-size: 20px; }
    .section { padding: 18px; margin-bottom: 16px; }
    .status-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); margin-top: 12px; }
    .status-card { padding: 16px; }
    .chip-row { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
    .chip {
      display: inline-flex; align-items: center; padding: 6px 10px; border-radius: 999px;
      background: rgba(93,72,255,0.12); color: #3f37c9; font-size: 12px; font-weight: 600;
    }
    .two-col { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .list-stack { display: flex; flex-direction: column; gap: 8px; }
    .list-item { padding: 12px 14px; }
    .list-item strong { display: block; margin-bottom: 4px; font-size: 14px; }
    .muted-row { background: rgba(255,255,255,0.7); }
    .footer-note { margin-top: 8px; color: #66709c; font-size: 12px; }
    @media print {
      body { background: #fff; }
      .page { padding: 0; background: #fff; }
      .hero, .section, .metric, .list-item, .status-card { box-shadow: none; }
    }
  </style>
</head>
<body>
  <div class="page">
    <section class="hero">
      <p class="eyebrow">Photo Ingest Studio</p>
      <h1>摄影导入报告</h1>
      <p class="muted">来源 ${escapeHtml(sourceRoot ? basename(sourceRoot) : "未知来源")} · 导出时间 ${escapeHtml(
        new Date().toLocaleString("zh-CN", { hour12: false })
      )}</p>
    </section>

    ${coverHtml}

    <section class="grid metrics">
      <div class="metric"><span>成功导入</span><strong>${importResult.imported}</strong></div>
      <div class="metric"><span>跳过文件</span><strong>${importResult.skipped}</strong></div>
      <div class="metric"><span>失败文件</span><strong>${importResult.failed}</strong></div>
      <div class="metric"><span>校验通过</span><strong>${importResult.verified}</strong></div>
    </section>

    <section class="section">
      <h2>摘要</h2>
      <p class="muted">主目录：${escapeHtml(importResult.primaryTargetRoot)}</p>
      <p class="muted">备份目录：${escapeHtml(importResult.backupTargetRoot ?? "未启用")}</p>
      <p class="muted">导入耗时：${escapeHtml(
        `${Math.max(1, Math.round(durationMs / 1000))} 秒`
      )} · 自动改名保留 ${importResult.renamed} 个 · 计划导入 ${selectedImportFiles.length} 个</p>
      ${
        failureSummaryHtml
          ? `<div class="chip-row">${failureSummaryHtml}</div>`
          : ""
      }
    </section>

    <section class="section">
      <h2>校验结果</h2>
      <div class="grid status-grid">
        <div class="status-card">
          <span>主目录状态</span>
          <strong>${escapeHtml(destinationStatusLabel(true, importResult.failed))}</strong>
        </div>
        <div class="status-card">
          <span>备份目录状态</span>
          <strong>${escapeHtml(destinationStatusLabel(Boolean(importResult.backupTargetRoot), importResult.failed))}</strong>
        </div>
        <div class="status-card">
          <span>校验方式</span>
          <strong>${escapeHtml(preset.verifyMode.toUpperCase())}</strong>
        </div>
      </div>
      <p class="footer-note">本次报告基于导入完成后的主目录 / 备份目录写入结果生成。</p>
    </section>

    <section class="grid two-col">
      <div class="section">
        <h2>自动改名保留</h2>
        <div class="list-stack">${renamedHtml}</div>
      </div>
      <div class="section">
        <h2>已跳过文件</h2>
        <div class="list-stack">${skippedHtml}</div>
      </div>
    </section>

    <section class="section">
      <h2>失败明细</h2>
      <div class="list-stack">${failuresHtml}</div>
    </section>
  </div>
</body>
</html>`;

      printWindow.document.open();
      printWindow.document.write(printableHtml);
      printWindow.document.close();
      window.setTimeout(() => {
        printWindow.focus();
        printWindow.print();
      }, 250);
      setStatusMessage("已打开打印窗口，请在系统面板里保存为 PDF。");
    } catch (reportError) {
      const message =
        reportError instanceof Error ? reportError.message : "导出 PDF 失败。";
      setError(message);
      setStatusMessage("PDF 未导出。");
    } finally {
      setIsExportingReport(false);
    }
  };

  return (
    <div className="shell">
      <aside className="sidebar">
        <div>
          <p className="eyebrow">Photo Ingest Studio</p>
          <h1>摄影导入台</h1>
          <p className="byline">摸鱼开发</p>
          <p className="muted">把卡里的文件拷到电脑，按规则整理并校验。</p>
        </div>

        <nav className="workflow">
          <button className="workflow-item active">1. 选择来源</button>
          <button className="workflow-item">2. 读取素材</button>
          <button className="workflow-item">3. 导入设置</button>
          <button className="workflow-item">4. 开始导入</button>
        </nav>

        <section className="side-panel">
          <h2>导入概览</h2>
          <div className="stat-list">
            {stats.map((stat) => (
              <div className={`stat-card ${stat.tone ?? "neutral"}`} key={stat.label}>
                <span>{stat.label}</span>
                <strong>{stat.value}</strong>
              </div>
            ))}
          </div>
        </section>

        <section className="side-panel">
          <h2>导入历史</h2>
          <div className="history-list">
            {importHistory.length === 0 ? (
              <div className="empty-state compact">还没有导入历史。</div>
            ) : (
              importHistory.slice(0, 4).map((entry) => (
                <div className="history-item" key={entry.id}>
                  <strong>{entry.sourceLabel}</strong>
                  <span>
                    {new Date(entry.finishedAt).toLocaleString("zh-CN", { hour12: false })}
                  </span>
                  <small>
                    {entry.imported} 成功 / {entry.failed} 失败
                  </small>
                </div>
              ))
            )}
          </div>
        </section>
      </aside>

      <main className="content">
        <div className="mac-topbar" data-tauri-drag-region>
          <div className="mac-topbar-copy">
            <span>Photo Ingest Studio</span>
            <strong>{sourceRoot ? basename(sourceRoot) : "未选择来源"}</strong>
          </div>
          <div className="mac-topbar-status">
            <span>{isImporting ? "正在导入" : isAnalyzing ? "正在分析" : "准备就绪"}</span>
          </div>
        </div>

        {pendingResume ? (
          <section className="resume-banner">
            <div>
              <p className="eyebrow">恢复导入</p>
              <strong>{pendingResume.sourceLabel}</strong>
              <p className="muted">
                上次导入还剩 {pendingResume.remaining} / {pendingResume.total} 个文件未完成。
                主目录是 {pendingResume.targetRoot}
                {pendingResume.backupTargetRoot ? `，备份目录是 ${pendingResume.backupTargetRoot}` : ""}。
              </p>
              <div className="resume-summary">
                {pendingResume.lastProcessedFile ? (
                  <span>上次停在 {pendingResume.lastProcessedFile}</span>
                ) : null}
                <span>剩余 RAW {pendingResume.remainingRaw}</span>
                <span>剩余 JPEG {pendingResume.remainingJpeg}</span>
                {pendingResume.topFailureCategory ? (
                  <span>最多失败原因 {failureCategoryLabel(pendingResume.topFailureCategory)}</span>
                ) : null}
              </div>
              {pendingResume.remainingFiles.length > 0 ? (
                <div className="resume-files">
                  {pendingResume.remainingFiles.map((filename) => (
                    <span key={filename} className="resume-file-chip">
                      {filename}
                    </span>
                  ))}
                  {pendingResume.remaining > pendingResume.remainingFiles.length ? (
                    <span className="resume-file-chip">
                      还有 {pendingResume.remaining - pendingResume.remainingFiles.length} 个文件
                    </span>
                  ) : null}
                </div>
              ) : null}
            </div>
            <div className="completion-actions">
              <button
                className="primary-button"
                onClick={handleResumeImport}
                disabled={isImporting || isResumingImport}
              >
                {isResumingImport ? "恢复中..." : "继续上次导入"}
              </button>
              <button className="ghost-button" onClick={handleDismissPendingResume}>
                删除记录
              </button>
            </div>
          </section>
        ) : null}

        <section className="hero-card">
          <div>
            <p className="eyebrow">当前来源</p>
            <h2>{sourceRoot ? basename(sourceRoot) : "未选择来源"}</h2>
            <p className="muted">{sourceRoot || "手动输入路径或从上方列表选择。"}</p>
          </div>
          <div className="hero-meta">
            <div>
              <span>导入方式</span>
              <strong>{preset.importMode === "all" ? "全部导入" : `仅导入 ${ratingLabel[preset.minRating]} 及以上`}</strong>
            </div>
            <div>
              <span>归档规则</span>
              <strong>{archiveModeLabels[preset.archiveMode]}</strong>
            </div>
            <div>
              <span>日期范围</span>
              <strong>
                {preset.dateFilterEnabled
                  ? `${
                      preset.datePreset !== "custom"
                        ? `${datePresetLabels[preset.datePreset]} · `
                        : ""
                    }${preset.dateFrom || "最早"} 到 ${preset.dateTo || "最晚"}`
                  : "不过滤日期"}
              </strong>
            </div>
            <div>
              <span>校验</span>
              <strong>{preset.verifyMode.toUpperCase()}</strong>
            </div>
          </div>
        </section>

        <section className="grid-two">
          <article className="panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">第一步</p>
                <h3>插卡或选择来源</h3>
              </div>
              <div className="action-row">
                <button className="ghost-button" onClick={handleDetectSources} disabled={isDetectingSources}>
                  {isDetectingSources ? "读取中..." : "刷新来源"}
                </button>
                <button className="primary-button" onClick={handleAnalyze} disabled={isAnalyzing}>
                  {isAnalyzing ? "读取中..." : "读取素材"}
                </button>
              </div>
            </div>
            <div className="field-stack">
              {sourceCandidates.length > 0 ? (
                <div className="candidate-list">
                  {sourceCandidates.map((candidate) => (
                    <button
                      key={candidate.rootPath}
                      className={`candidate-card ${candidate.rootPath === sourceRoot ? "selected" : ""}`}
                      onClick={() => {
                        setError("");
                        void analyzeSource(candidate.rootPath);
                      }}
                    >
                      <div className="candidate-card-main">
                        <div>
                          <strong>{candidate.label}</strong>
                          <p>
                            {sourceKindLabel(candidate.sourceKind)} · {candidate.rootPath}
                          </p>
                        </div>
                        <span>
                          {candidate.fileCount} 张 · {candidate.formats.slice(0, 3).join(" / ")}
                        </span>
                      </div>
                      {isAnalyzing && analysisSourceRoot === candidate.rootPath && scanProgress ? (
                        <div className="candidate-progress">
                          <div className="candidate-progress-head">
                            <strong>分析中</strong>
                            <span>{scanProgress.progress}%</span>
                          </div>
                          <div className="progress-track compact">
                            <div className="progress-bar" style={{ width: `${scanProgress.progress}%` }} />
                          </div>
                          <small>{scanProgress.message}</small>
                        </div>
                      ) : null}
                    </button>
                  ))}
                </div>
              ) : null}
              <label className="field">
                <span>来源目录</span>
                <div className="field-inline">
                  <input
                    value={sourceRoot}
                    onChange={(event) => setSourceRoot(event.target.value)}
                    placeholder="/Volumes/SD_CARD/DCIM 或 D:\\Photos\\Card"
                  />
                  <button className="ghost-button" onClick={handleChooseSource}>
                    选择目录
                  </button>
                </div>
              </label>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={preset.recursive}
                  onChange={(event) => updatePreset("recursive", event.target.checked)}
                />
                <span>递归扫描子目录</span>
              </label>
              <div className="status-line">{statusMessage}</div>

              {duplicateWarning ? (
                <div className="status-line warning-line">
                  这张卡之前已导入过 {duplicateWarning.timesImported} 次，最近一次导入到{" "}
                  {duplicateWarning.latestTargetRoot}
                  {duplicateWarning.latestBackupTargetRoot
                    ? `，备份到 ${duplicateWarning.latestBackupTargetRoot}`
                    : ""}
                </div>
              ) : null}

              {detectProgress && isDetectingSources ? (
                <div className="inline-progress">
                  <div className="inline-progress-head">
                    <strong>来源列表</strong>
                    <span>{detectProgress.progress}%</span>
                  </div>
                  <p>{detectProgress.message}</p>
                  <div className="progress-track">
                    <div className="progress-bar" style={{ width: `${detectProgress.progress}%` }} />
                  </div>
                  <div className="inline-progress-meta">
                    <span>已检查 {detectProgress.processed} / {detectProgress.total || "?"}</span>
                    <span>已发现 {detectProgress.found} 个来源</span>
                  </div>
                </div>
              ) : null}

              {scanProgress && isAnalyzing ? (
                <div className="inline-progress">
                  <div className="inline-progress-head">
                    <strong>读取素材</strong>
                    <span>{scanProgress.progress}%</span>
                  </div>
                  <p>{scanProgress.message}</p>
                  <div className="progress-track">
                    <div className="progress-bar" style={{ width: `${scanProgress.progress}%` }} />
                  </div>
                  <div className="inline-progress-meta">
                    <span>阶段 {scanProgress.stage}</span>
                    <span>
                      {scanProgress.total > 0
                        ? `${scanProgress.processed} / ${scanProgress.total}`
                        : `已发现 ${scanProgress.processed} 个文件`}
                    </span>
                  </div>
                </div>
              ) : null}
            </div>
          </article>

          <article className="panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">第二步</p>
                <h3>素材信息</h3>
              </div>
            </div>
            <div className="summary-grid">
              <div className="summary-card">
                <span>文件总数</span>
                <strong>{mediaFiles.length}</strong>
              </div>
              <div className="summary-card">
                <span>RAW 数量</span>
                <strong>{fileAnalysis.rawCount}</strong>
              </div>
              <div className="summary-card">
                <span>普通图片</span>
                <strong>{fileAnalysis.imageCount}</strong>
              </div>
              <div className="summary-card">
                <span>预计体积</span>
                <strong>{fileAnalysis.totalSizeMb} MB</strong>
              </div>
            </div>
            <div className="insight-list">
              <div className="insight-item">
                <span>拍摄日期</span>
                <strong>
                  {formatShortDate(fileAnalysis.from)} - {formatShortDate(fileAnalysis.to)}
                </strong>
              </div>
              <div className="insight-item">
                <span>相机机型</span>
                <strong>{fileAnalysis.cameras.length > 0 ? fileAnalysis.cameras.join(" / ") : "待分析"}</strong>
              </div>
            </div>
          </article>
        </section>

        <section className="panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">第三步</p>
              <h3>导入设置</h3>
            </div>
            <button className="ghost-button" onClick={handleRefreshPlan} disabled={isPlanning}>
              {isPlanning ? "更新中..." : "更新计划"}
            </button>
          </div>

          <div className="preset-strip">
            <label className="field">
              <span>导入预设</span>
              <div className="field-inline">
                <input
                  value={presetName}
                  onChange={(event) => setPresetName(event.target.value)}
                  placeholder="例如：婚礼双备份 / 日常街拍"
                />
                <button className="ghost-button" onClick={handleSavePreset}>
                  {activePresetId ? "覆盖保存" : "保存预设"}
                </button>
              </div>
            </label>

            {savedPresets.length > 0 ? (
              <div className="saved-preset-list">
                {savedPresets.map((entry) => (
                  <div
                    className={`saved-preset-card ${entry.id === activePresetId ? "active" : ""}`}
                    key={entry.id}
                  >
                    <button className="saved-preset-main" onClick={() => applySavedPreset(entry)}>
                      <strong>{entry.name}</strong>
                      <span>
                        {archiveModeLabels[entry.preset.archiveMode]} ·{" "}
                        {entry.preset.mediaSelection === "raw"
                          ? "仅 RAW"
                          : entry.preset.mediaSelection === "jpeg"
                            ? "仅 JPEG"
                            : entry.preset.mediaSelection === "paired"
                              ? "RAW+JPEG 成对"
                              : "全部素材"}
                      </span>
                      <small>
                        {entry.preset.targetRoot || "未设置目标目录"} ·{" "}
                        {new Date(entry.updatedAt).toLocaleString("zh-CN", { hour12: false })}
                      </small>
                    </button>
                    <button
                      className="ghost-button danger-button"
                      onClick={() => handleDeletePreset(entry.id)}
                    >
                      删除
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty-state compact">还没有保存的导入预设。</div>
            )}
          </div>

          <div className="rule-grid wide">
            <label className="field">
              <span>目标目录</span>
              <div className="field-inline">
                <input
                  value={preset.targetRoot}
                  onChange={(event) => updatePreset("targetRoot", event.target.value)}
                  placeholder="/Users/you/Pictures/Photo Library"
                />
                <button className="ghost-button" onClick={handleChooseTarget}>
                  选择目录
                </button>
              </div>
            </label>

            <label className="field">
              <span>备份目录</span>
              <div className="field-inline">
                <input
                  value={preset.backupTargetRoot}
                  onChange={(event) => updatePreset("backupTargetRoot", event.target.value)}
                  placeholder="/Volumes/BackupSSD/Photo Backup"
                />
                <button className="ghost-button" onClick={handleChooseBackupTarget}>
                  选择目录
                </button>
              </div>
            </label>

            <label className="field">
              <span>归档方式</span>
              <select
                value={preset.archiveMode}
                onChange={(event) =>
                  updatePreset("archiveMode", event.target.value as ImportPreset["archiveMode"])
                }
              >
                <option value="year">按年份建文件夹</option>
                <option value="month">按年月建文件夹</option>
                <option value="date">按日期建文件夹</option>
                <option value="date-camera">按日期 + 机型建文件夹</option>
              </select>
            </label>

            <label className="field">
              <span>文件名模板</span>
              <input
                value={preset.filenameTemplate}
                onChange={(event) => updatePreset("filenameTemplate", event.target.value)}
                placeholder="{original} / {YYYYMMDD}_{HHmmss}_{camera}"
              />
            </label>

            <label className="field">
              <span>导入范围</span>
              <select
                value={preset.importMode}
                onChange={(event) =>
                  updatePreset("importMode", event.target.value as ImportPreset["importMode"])
                }
              >
                <option value="all">全部导入</option>
                <option value="rated">只导入已有评级照片</option>
              </select>
            </label>

            <label className="field">
              <span>素材类型</span>
              <select
                value={preset.mediaSelection}
                onChange={(event) =>
                  updatePreset("mediaSelection", event.target.value as ImportPreset["mediaSelection"])
                }
              >
                <option value="all">全部素材</option>
                <option value="raw">仅导入 RAW</option>
                <option value="jpeg">仅导入 JPEG</option>
                <option value="paired">仅导入 RAW + JPEG 成对素材</option>
              </select>
            </label>

            <label className="field">
              <span>按日期筛选</span>
              <select
                value={preset.dateFilterEnabled ? "enabled" : "disabled"}
                onChange={(event) =>
                  updatePreset("dateFilterEnabled", event.target.value === "enabled")
                }
              >
                <option value="disabled">不过滤日期</option>
                <option value="enabled">按拍摄日期过滤</option>
              </select>
            </label>

            {preset.dateFilterEnabled ? (
              <label className="field">
                <span>日期范围快捷方式</span>
                <select
                  value={preset.datePreset}
                  onChange={(event) =>
                    updatePreset("datePreset", event.target.value as ImportPreset["datePreset"])
                  }
                >
                  <option value="today">今天</option>
                  <option value="yesterday">昨天</option>
                  <option value="last7">最近 7 天</option>
                  <option value="custom">自定义</option>
                </select>
              </label>
            ) : null}

            <label className="field">
              <span>重复文件处理</span>
              <select
                value={preset.duplicateStrategy}
                onChange={(event) =>
                  updatePreset(
                    "duplicateStrategy",
                    event.target.value as ImportPreset["duplicateStrategy"]
                  )
                }
              >
                <option value="skip">跳过重复文件</option>
                <option value="rename">自动改名保留</option>
                <option value="keep-both">保留两份</option>
              </select>
            </label>

            <label className="field">
              <span>校验方式</span>
              <select
                value={preset.verifyMode}
                onChange={(event) =>
                  updatePreset("verifyMode", event.target.value as ImportPreset["verifyMode"])
                }
              >
                <option value="md5">MD5</option>
                <option value="blake3">BLAKE3</option>
              </select>
            </label>

            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={preset.writeXmp}
                onChange={(event) => updatePreset("writeXmp", event.target.checked)}
              />
              <span>导入后用 ExifTool 写入 XMP 星级</span>
            </label>

            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={preset.openPrimaryAfterImport}
                onChange={(event) => updatePreset("openPrimaryAfterImport", event.target.checked)}
              />
              <span>导入完成后自动打开主目录</span>
            </label>

            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={preset.openBackupAfterImport}
                onChange={(event) => updatePreset("openBackupAfterImport", event.target.checked)}
                disabled={!preset.backupTargetRoot.trim()}
              />
              <span>导入完成后自动打开备份目录</span>
            </label>

            {preset.dateFilterEnabled && preset.datePreset === "custom" ? (
              <>
                <label className="field">
                  <span>开始日期</span>
                  <input
                    type="date"
                    value={preset.dateFrom}
                    onChange={(event) => updatePreset("dateFrom", event.target.value)}
                  />
                </label>
                <label className="field">
                  <span>结束日期</span>
                  <input
                    type="date"
                    value={preset.dateTo}
                    onChange={(event) => updatePreset("dateTo", event.target.value)}
                  />
                </label>
              </>
            ) : null}

            {preset.importMode === "rated" ? (
              <label className="field">
                <span>最低星级</span>
                <select
                  value={preset.minRating}
                  onChange={(event) =>
                    updatePreset("minRating", Number(event.target.value) as Rating)
                  }
                >
                  {ratingLabel.map((label, index) => (
                    <option key={label} value={index}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </div>

          <div className="plan-strip">
            <div className="plan-item">
              <span>当前模板</span>
              <strong>{preset.pathTemplate}</strong>
            </div>
            <div className="plan-item">
              <span>文件名</span>
              <strong>{preset.filenameTemplate}</strong>
            </div>
            <div className="plan-item">
              <span>预计进入导入</span>
              <strong>{filteredFiles.length} 张</strong>
            </div>
            <div className="plan-item">
              <span>写入目标</span>
              <strong>{preset.backupTargetRoot.trim() ? "主目录 + 备份目录" : "仅主目录"}</strong>
            </div>
            <div className="plan-item">
              <span>配对规则</span>
              <strong>
                {preset.mediaSelection === "raw"
                  ? "仅 RAW"
                  : preset.mediaSelection === "jpeg"
                    ? "仅 JPEG"
                    : preset.mediaSelection === "paired"
                      ? "仅导入成对 RAW/JPEG"
                      : "不限制类型"}
              </strong>
            </div>
            <div className="plan-item">
              <span>星级写回</span>
              <strong>{preset.writeXmp ? "导入后写入 XMP" : "不写入 XMP"}</strong>
            </div>
            <div className="plan-item">
              <span>日期筛选</span>
              <strong>
                {preset.dateFilterEnabled
                  ? `${
                      preset.datePreset !== "custom"
                        ? `${datePresetLabels[preset.datePreset]} · `
                        : ""
                    }${preset.dateFrom || "最早"} 到 ${preset.dateTo || "最晚"}`
                  : "不过滤日期"}
              </strong>
            </div>
            <div className="plan-item">
              <span>空间检查</span>
              <strong>
                {isCheckingSpace
                  ? "检查中..."
                  : spaceCheck
                    ? `${formatBytes(spaceCheck.totalBytes)} 素材`
                    : "等待目标目录"}
              </strong>
            </div>
          </div>

          {spaceCheck ? (
            <div className="space-check-grid">
              <div className={`space-card ${spaceCheck.primary.enough ? "ok" : "danger"}`}>
                <span>主目录空间</span>
                <strong>{spaceCheck.primary.path}</strong>
                <small>
                  需要 {formatBytes(spaceCheck.primary.requiredBytes)}，可用{" "}
                  {formatBytes(spaceCheck.primary.availableBytes)}
                </small>
              </div>
              {spaceCheck.backup ? (
                <div className={`space-card ${spaceCheck.backup.enough ? "ok" : "danger"}`}>
                  <span>备份目录空间</span>
                  <strong>{spaceCheck.backup.path}</strong>
                  <small>
                    需要 {formatBytes(spaceCheck.backup.requiredBytes)}，可用{" "}
                    {formatBytes(spaceCheck.backup.availableBytes)}
                  </small>
                </div>
              ) : null}
              {spaceCheck.warnings.length > 0 ? (
                <div className="space-card warning">
                  <span>提示</span>
                  <strong>导入前先处理这些问题</strong>
                  <small>{spaceCheck.warnings.join(" ")}</small>
                </div>
              ) : (
                <div className="space-card ok">
                  <span>提示</span>
                  <strong>空间足够</strong>
                  <small>主目录{spaceCheck.backup ? "和备份目录" : ""}都有足够空间。</small>
                </div>
              )}
            </div>
          ) : null}

          <div className="path-preview">
            <span>示例路径</span>
            <code>{previewSample}</code>
          </div>
        </section>

        <section className="grid-two">
          <article className="panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">导入清单</p>
                <h3>筛选结果</h3>
              </div>
            </div>

            {mediaFiles.length === 0 ? (
              <div className="empty-state">分析完成后，这里会显示本次会被纳入导入计划的文件概览。</div>
            ) : (
              <>
                <div className="preview-toolbar">
                  <span className="summary-chip">
                    当前页 {visiblePreviewFiles.length} 张 · 已纳入 {visiblePreviewFiles.filter((file) => filteredFileIds.has(file.id)).length} 张
                  </span>
                  <div className="preview-toolbar-actions">
                    <button className="ghost-button" onClick={handleBatchIncludeVisible}>
                      当前页全选
                    </button>
                    <button className="ghost-button" onClick={handleBatchExcludeVisible}>
                      当前页全部排除
                    </button>
                    <button className="ghost-button" onClick={handleKeepAutoFilter}>
                      恢复自动筛选
                    </button>
                    <button className="ghost-button" onClick={handleClearPreviewAdjustments}>
                      清空调整
                    </button>
                  </div>
                </div>

                <div className="preview-grid">
                {visiblePreviewFiles.map((file) => {
                  const included = filteredFileIds.has(file.id);
                  const previewUrl = previewUrls[file.id];
                  const showImage = Boolean(previewUrl) && !brokenPreviewIds[file.id];
                  const manualSelection = selectionOverrides[file.id];
                  const displayRating = ratingOverrides[file.id] ?? file.rating;

                  return (
                    <button
                      key={file.id}
                      className={`preview-card ${included ? "selected" : "dimmed"}`}
                      onClick={() => setActivePreviewId(file.id)}
                    >
                      <div className="preview-media">
                        <div className={`preview-badge ${included ? "included" : "excluded"}`}>
                          {included ? "纳入" : "排除"}
                        </div>
                        {manualSelection !== undefined ? (
                          <div className="preview-manual-flag">
                            {manualSelection ? "手动纳入" : "手动排除"}
                          </div>
                        ) : null}
                        {showImage ? (
                          <img
                            src={previewUrl}
                            alt={file.filename}
                            onError={() =>
                              setBrokenPreviewIds((current) => ({ ...current, [file.id]: true }))
                            }
                          />
                        ) : (
                          <div className="preview-fallback">
                            <strong>{file.format}</strong>
                            <span>{included ? "进入导入计划" : "当前被筛掉"}</span>
                          </div>
                        )}
                      </div>
                      <div className="preview-copy">
                        <strong>{file.filename}</strong>
                        <small>
                          {file.shotAt} · {file.camera}
                        </small>
                        <small>
                          {file.sizeMb} MB · {stars(displayRating)}
                        </small>
                        <small>{included ? "已选中" : "未选中"}</small>
                      </div>
                    </button>
                  );
                })}
                </div>
              </>
            )}
          </article>

          <article className="panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">第四步</p>
                <h3>导入</h3>
              </div>
              <button
                className="primary-button"
                onClick={handleImport}
                disabled={
                  isImporting ||
                  mediaFiles.length === 0 ||
                  Boolean(
                    spaceCheck &&
                      (!spaceCheck.primary.enough ||
                        (spaceCheck.backup && !spaceCheck.backup.enough))
                  )
                }
              >
                {isImporting ? "导入中..." : "开始"}
              </button>
              {isImporting ? (
                <button
                  className="ghost-button"
                  onClick={handleCancelImport}
                  disabled={isCancellingImport}
                >
                  {isCancellingImport ? "取消中..." : "取消导入"}
                </button>
              ) : null}
            </div>

            {error ? <div className="error-banner">{error}</div> : null}

            {latestImportError ? <div className="error-banner">{latestImportError}</div> : null}

            {importProgress ? (
              <div className="live-progress">
                <div className="live-progress-head">
                  <strong>{importProgress.currentFile ?? "准备导入"}</strong>
                  <span>{importProgress.progress}%</span>
                </div>
                <p>{importProgress.message}</p>
                <div className="progress-track">
                  <div className="progress-bar" style={{ width: `${importProgress.progress}%` }} />
                </div>
                <div className="live-progress-meta">
                  <span>已完成 {importProgress.processed} / {importProgress.total}</span>
                  <span>成功 {importProgress.imported}</span>
                  <span>跳过 {importProgress.skipped}</span>
                  <span>失败 {importProgress.failed}</span>
                </div>
              </div>
            ) : null}

            {importResult && importResult.failureDetails.length > 0 ? (
              <div className="failure-list">
                <strong>失败原因</strong>
                {failureSummary.length > 0 ? (
                  <div className="failure-summary">
                    {failureSummary.map(([category, count]) => (
                      <span key={category} className="failure-summary-chip">
                        {failureCategoryLabel(category)} {count}
                      </span>
                    ))}
                  </div>
                ) : null}
                {importResult.failureDetails.slice(0, 6).map((detail) => (
                  <div key={`${detail.sourcePath}-${detail.reason}`} className="failure-item">
                    <span>
                      {detail.filename}
                      <small className="failure-category-tag">
                        {failureCategoryLabel(detail.category)}
                      </small>
                    </span>
                    <small>{detail.reason}</small>
                  </div>
                ))}
              </div>
            ) : null}

            {importResult ? (
              <div className="completion-card">
                <div className="completion-head">
                  <div>
                    <span>{importResult.cancelled ? "导入已取消" : "导入完成"}</span>
                    <strong>
                      成功 {importResult.imported} / 跳过 {importResult.skipped} / 失败{" "}
                      {importResult.failed}
                    </strong>
                  </div>
                  <div className="completion-actions">
                    <button
                      className="ghost-button"
                      onClick={handleExportReport}
                      disabled={isExportingReport}
                    >
                      {isExportingReport ? "生成中..." : "导出 PDF"}
                    </button>
                    <button
                      className="ghost-button"
                      onClick={() => void openInFileManager(importResult.primaryTargetRoot)}
                    >
                      打开目标文件夹
                    </button>
                    <button className="ghost-button" onClick={() => setImportResult(null)}>
                      收起结果
                    </button>
                  </div>
                </div>
                <p>
                  目标目录：{importResult.primaryTargetRoot}
                  {importResult.duplicateWarning
                    ? ` · 这张卡此前已导入过 ${importResult.duplicateWarning.timesImported} 次`
                    : ""}
                </p>
                {importResult.backupTargetRoot ? (
                  <p>备份目录：{importResult.backupTargetRoot}</p>
                ) : null}
                <div className="report-summary-grid">
                  <div className="summary-card">
                    <span>校验通过</span>
                    <strong>{importResult.verified} 个文件</strong>
                  </div>
                  <div className="summary-card">
                    <span>导入耗时</span>
                    <strong>
                      {Math.max(
                        1,
                        Math.round(
                          (new Date(importResult.finishedAt).getTime() -
                            new Date(importResult.startedAt).getTime()) /
                            1000
                        )
                      )}{" "}
                      秒
                    </strong>
                  </div>
                  <div className="summary-card">
                    <span>计划导入</span>
                    <strong>{selectedImportFiles.length} 个文件</strong>
                  </div>
                  <div className="summary-card">
                    <span>重复候选</span>
                    <strong>{previewEntries.filter((entry) => entry.exists).length} 个</strong>
                  </div>
                  <div className="summary-card">
                    <span>自动改名保留</span>
                    <strong>{importResult.renamed} 个</strong>
                  </div>
                </div>
                <div className="verification-report">
                  <div className="verification-report-head">
                    <strong>校验报告</strong>
                    <span>{importResult.cancelled ? "已取消" : "已完成"}</span>
                  </div>
                  <div className="verification-report-grid">
                    <div className="space-card ok">
                      <span>主目录状态</span>
                      <strong>{destinationStatusLabel(true, importResult.failed)}</strong>
                      <small>{importResult.primaryTargetRoot}</small>
                    </div>
                    <div className={`space-card ${importResult.backupTargetRoot ? "ok" : "warning"}`}>
                      <span>备份目录状态</span>
                      <strong>
                        {destinationStatusLabel(Boolean(importResult.backupTargetRoot), importResult.failed)}
                      </strong>
                      <small>{importResult.backupTargetRoot ?? "未启用备份目录"}</small>
                    </div>
                    <div className="space-card ok">
                      <span>哈希校验</span>
                      <strong>{importResult.verified} 个文件通过</strong>
                      <small>
                        使用 {preset.verifyMode.toUpperCase()} 完成写入后校验
                      </small>
                    </div>
                  </div>
                  {importResult.renamedDetails.length > 0 ? (
                    <div className="report-list">
                      <strong>已自动改名保留</strong>
                      {importResult.renamedDetails.slice(0, 6).map((detail) => (
                        <div className="report-item" key={`${detail.sourcePath}-${detail.targetPath}`}>
                          <span>{detail.filename}</span>
                          <small>{detail.targetPath}</small>
                        </div>
                      ))}
                    </div>
                  ) : null}
                  {importResult.skippedDetails.length > 0 ? (
                    <div className="report-list">
                      <strong>已跳过文件</strong>
                      {importResult.skippedDetails.slice(0, 6).map((detail) => (
                        <div className="report-item" key={`${detail.sourcePath}-${detail.targetPath}`}>
                          <span>{detail.filename}</span>
                          <small>{detail.reason}</small>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
                <div className="completion-note">现在可以回看目标目录，确认无误后安全移除储存卡。</div>
              </div>
            ) : null}

            <div className="task-list">
              {tasks.map((task) => (
                <article className="task-card" key={task.step}>
                  <div className="task-head">
                    <strong>{task.step}</strong>
                    <span>{task.progress}%</span>
                  </div>
                  <p>{task.detail}</p>
                  <div className="progress-track">
                    <div className="progress-bar" style={{ width: `${task.progress}%` }} />
                  </div>
                </article>
              ))}
            </div>
          </article>
        </section>

        {activePreviewFile ? (
          <div className="lightbox" onClick={() => setActivePreviewId(null)}>
            <div className="lightbox-panel" onClick={(event) => event.stopPropagation()}>
              <div className="lightbox-head">
                <div>
                  <span>单张预览</span>
                  <strong>{activePreviewFile.filename}</strong>
                </div>
                <button className="ghost-button" onClick={() => setActivePreviewId(null)}>
                  关闭
                </button>
              </div>
              <div className="lightbox-body">
                <button
                  className="ghost-button lightbox-nav"
                  onClick={() =>
                    activePreviewIndex > 0 &&
                    setActivePreviewId(visiblePreviewFiles[activePreviewIndex - 1].id)
                  }
                  disabled={activePreviewIndex <= 0}
                >
                  上一张
                </button>
                <div className="lightbox-media">
                  {isActivePreviewLoading ? (
                    <div className="preview-loading">正在加载预览...</div>
                  ) : activePreviewUrl && !brokenPreviewIds[activePreviewFile.id] ? (
                    <img
                      src={activePreviewUrl}
                      alt={activePreviewFile.filename}
                      onError={() =>
                        setBrokenPreviewIds((current) => ({ ...current, [activePreviewFile.id]: true }))
                      }
                    />
                  ) : (
                    <div className="preview-fallback large">
                      <strong>{activePreviewFile.format}</strong>
                      <span>{activePreviewFile.camera}</span>
                    </div>
                  )}
                </div>
                <button
                  className="ghost-button lightbox-nav"
                  onClick={() =>
                    activePreviewIndex < visiblePreviewFiles.length - 1 &&
                    setActivePreviewId(visiblePreviewFiles[activePreviewIndex + 1].id)
                  }
                  disabled={activePreviewIndex >= visiblePreviewFiles.length - 1}
                >
                  下一张
                </button>
              </div>
              <div className="lightbox-meta">
                <span>{activePreviewFile.shotAt}</span>
                <span>{activePreviewFile.camera}</span>
                <span>{activePreviewFile.sizeMb} MB</span>
                <span>{stars(activePreviewFile.rating)}</span>
                <span>
                  {filteredFiles.some((file) => file.id === activePreviewFile.id) ? "已选中" : "未选中"}
                </span>
              </div>
              <div className="completion-actions">
                <button
                  className="ghost-button"
                  onClick={() =>
                    setSelectionOverrides((current) => ({
                      ...current,
                      [activePreviewFile.id]: !filteredFiles.some((file) => file.id === activePreviewFile.id)
                    }))
                  }
                >
                  {filteredFiles.some((file) => file.id === activePreviewFile.id) ? "排除这张" : "纳入这张"}
                </button>
                {[0, 1, 2, 3, 4, 5].map((rating) => (
                  <button
                    key={rating}
                    className="ghost-button"
                    onClick={() =>
                      setRatingOverrides((current) => ({
                        ...current,
                        [activePreviewFile.id]: rating as Rating
                      }))
                    }
                  >
                    {rating} 星
                  </button>
                ))}
                <span className="shortcut-hint">空格切换导入，数字键 0-5 临时打星</span>
              </div>
            </div>
          </div>
        ) : null}
      </main>
    </div>
  );
}

export default App;
