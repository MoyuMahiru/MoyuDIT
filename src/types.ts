export type Rating = 0 | 1 | 2 | 3 | 4 | 5;

export interface MediaFile {
  id: string;
  filename: string;
  shotAt: string;
  shotAtRaw: string | null;
  camera: string;
  format: string;
  sizeMb: number;
  md5Status: "pending" | "verified" | "failed";
  rating: Rating;
}

export interface SourceCard {
  id: string;
  label: string;
  mountPath: string;
  capacityGb?: number;
  usedGb?: number;
  formats: string[];
  fileCount: number;
  status: "ready" | "scanning" | "offline";
}

export interface ImportPreset {
  targetRoot: string;
  backupTargetRoot: string;
  archiveMode: "year" | "month" | "date" | "date-camera";
  pathTemplate: string;
  filenameTemplate: string;
  importMode: "all" | "rated";
  minRating: Rating;
  mediaSelection: "all" | "raw" | "jpeg" | "paired";
  dateFilterEnabled: boolean;
  datePreset: "today" | "yesterday" | "last7" | "custom";
  dateFrom: string;
  dateTo: string;
  duplicateStrategy: "skip" | "rename" | "keep-both";
  verifyMode: "md5" | "blake3";
  writeXmp: boolean;
  openPrimaryAfterImport: boolean;
  openBackupAfterImport: boolean;
  recursive: boolean;
}

export interface SelectedImportFile {
  sourcePath: string;
  rating: Rating;
}

export interface SpaceCheckTarget {
  path: string;
  requiredBytes: number;
  availableBytes: number;
  enough: boolean;
}

export interface SpaceCheckResult {
  plannedFiles: number;
  totalBytes: number;
  primary: SpaceCheckTarget;
  backup: SpaceCheckTarget | null;
  warnings: string[];
}

export interface SavedImportPreset {
  id: string;
  name: string;
  preset: ImportPreset;
  updatedAt: string;
}

export interface ImportStat {
  label: string;
  value: string;
  tone?: "neutral" | "success" | "warning";
}

export interface ImportTask {
  step: string;
  detail: string;
  progress: number;
}

export interface BackendMediaEntry {
  filename: string;
  sourcePath: string;
  shotAt: string | null;
  camera: string | null;
  rating: number | null;
  sizeBytes: number;
}

export interface BackendPreviewEntry {
  filename: string;
  sourcePath: string;
  targetPath: string;
  exists: boolean;
}

export interface BackendSourceEntry {
  label: string;
  rootPath: string;
  fileCount: number;
  formats: string[];
  sourceKind: string;
}

export interface BackendImportResult {
  imported: number;
  skipped: number;
  failed: number;
  verified: number;
  renamed: number;
  cancelled: boolean;
  failureDetails: ImportFailureDetail[];
  renamedDetails: ImportRenameDetail[];
  skippedDetails: ImportSkipDetail[];
  primaryTargetRoot: string;
  backupTargetRoot: string | null;
  duplicateWarning: DuplicateImportWarning | null;
  startedAt: string;
  finishedAt: string;
}

export interface ImportFailureDetail {
  filename: string;
  sourcePath: string;
  category: "permission" | "space" | "verification" | "duplicate" | "missing" | "io";
  reason: string;
}

export interface ImportRenameDetail {
  filename: string;
  sourcePath: string;
  targetPath: string;
}

export interface ImportSkipDetail {
  filename: string;
  sourcePath: string;
  targetPath: string;
  reason: string;
}

export interface ImportHistoryEntry {
  id: string;
  sourceRoot: string;
  sourceFingerprint: string;
  sourceLabel: string;
  targetRoot: string;
  backupTargetRoot: string | null;
  imported: number;
  skipped: number;
  failed: number;
  verified: number;
  startedAt: string;
  finishedAt: string;
}

export interface DuplicateImportWarning {
  sourceFingerprint: string;
  sourceLabel: string;
  latestImportAt: string;
  latestTargetRoot: string;
  latestBackupTargetRoot: string | null;
  timesImported: number;
}

export interface PendingImportResume {
  id: string;
  sourceRoot: string;
  sourceLabel: string;
  targetRoot: string;
  backupTargetRoot: string | null;
  total: number;
  remaining: number;
  imported: number;
  skipped: number;
  failed: number;
  lastProcessedFile: string | null;
  remainingRaw: number;
  remainingJpeg: number;
  topFailureCategory: string | null;
  remainingFiles: string[];
  startedAt: string;
  updatedAt: string;
}

export interface ImportProgressEvent {
  stage: "started" | "processing" | "finished";
  currentFile: string | null;
  processed: number;
  total: number;
  imported: number;
  skipped: number;
  failed: number;
  progress: number;
  message: string;
  latestError: ImportFailureDetail | null;
}

export interface DetectSourcesProgressEvent {
  stage: "started" | "processing" | "finished";
  currentItem: string | null;
  processed: number;
  total: number;
  found: number;
  progress: number;
  message: string;
}

export interface ScanProgressEvent {
  stage: "discovering" | "metadata" | "finished";
  currentItem: string | null;
  processed: number;
  total: number;
  progress: number;
  message: string;
}
