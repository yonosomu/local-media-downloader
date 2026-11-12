export type Protocol = 'direct' | 'hls' | 'dash';
export type Container = 'mp4' | 'webm' | 'mkv' | 'm4a' | 'mp3' | 'original';
export type JobState = 'queued' | 'resolving' | 'downloading' | 'paused' | 'assembling' | 'awaiting_export' | 'exporting' | 'completed' | 'completed_with_warnings' | 'failed' | 'cancelled' | 'interrupted';
export type ErrorCode = 'PERMISSION_REQUIRED' | 'AUTH_REQUIRED' | 'URL_EXPIRED' | 'NETWORK_TIMEOUT' | 'NETWORK_OFFLINE' | 'HTTP_ERROR' | 'RATE_LIMITED' | 'INVALID_MANIFEST' | 'MANIFEST_LIMIT' | 'UNSUPPORTED_FORMAT' | 'ENCRYPTED_UNSUPPORTED' | 'DRM_UNSUPPORTED' | 'SEGMENT_MISSING' | 'RESOURCE_CHANGED' | 'QUOTA_EXCEEDED' | 'DISK_WRITE_FAILED' | 'MUX_FAILED' | 'EXPORT_CANCELLED' | 'BROWSER_UNSUPPORTED' | 'SOURCE_TAB_REQUIRED' | 'INVALID_REQUEST' | 'INVALID_STATE';
export interface SafeError { code: ErrorCode; message: string; retryable: boolean; action?: 'grant_permission' | 'open_source' | 'redetect' | 'choose_file' | 'clear_temp' }
export interface Variant { id: string; width?: number; height?: number; bitrate?: number; fps?: number; hdr?: string; codecs: string[]; hasAudio: boolean }
export interface Track { id: string; kind: 'audio' | 'subtitle'; language?: string; label: string; codec?: string; role?: string; channels?: number; bitrate?: number }
export interface MediaCandidate {
  id: string; tabId: number; frameId: number; documentKey: string; generation: number; revision: number;
  title: string; sourceOrigin: string; protocol: Protocol; isLive: boolean; variants: Variant[];
  audioTracks: Track[]; subtitleTracks: Track[]; sourceRef: string; detectedAt: number;
  support: 'supported' | 'unknown' | 'unsupported'; unsupportedReason?: string; duration?: number;
  size?: { bytes: number; estimated: boolean };
  capabilities: { pause: boolean; resume: boolean; requiresSourceTab: boolean; containers: Container[] };
}
export interface Selection { variantId?: string; audioTrackId?: string; subtitleTrackIds: string[]; audioOnly: boolean; container: Container }
export interface LiveLimits { durationSeconds?: number; bytes?: number }
export interface OutputRef { part: number; name: string; mime: string; bytes: number; browserDownloadId?: number; state: 'ready' | 'exporting' | 'saved' | 'cancelled' }
export interface DownloadJob {
  id: string; requestId: string; candidateId: string; state: JobState; selection: Selection;
  outputName: string; createdAt: number; updatedAt: number; bytesWritten: number; totalBytes?: number;
  segmentsDone?: number; segmentsTotal?: number; checkpointRef?: string; browserDownloadId?: number; attempt: number; error?: SafeError;
}
export interface JobSnapshot extends DownloadJob {
  schemaVersion: 1; revision: number; runEpoch: number; capabilities: { pause: boolean; resume: boolean };
  warnings: SafeError[]; outputs: OutputRef[]; stageProgress?: { stage: string; ratio?: number }; liveLimits?: LiveLimits;
}
export interface SettingsV1 {
  schemaVersion: 1; quality: { mode: 'best' | 'max_height' | 'manual'; maxHeight?: number };
  audioLanguages: string[]; subtitleLanguages: string[]; subtitlesEnabled: boolean; container: Container;
  filenameTemplate: string; relativeDirectory: string; siteDirectories: Record<string, string>;
  jobsConcurrency: number; segmentsConcurrency: number; retries: number; firstByteTimeoutMs: number; stallTimeoutMs: number;
  liveMaxDurationSeconds?: number; liveMaxBytes?: number; discoveryEnabled: boolean; siteDiscovery: Record<string, boolean>;
  permissionMode: 'selected_sites' | 'all_http_https'; historyEnabled: boolean; historyMaxEntries: number; historyMaxDays: number;
}
export interface ResourceIdentity { etag?: string; lastModified?: string; length?: number }
export interface AuthorizedSource { sourceRef: string; exactUrl: string; allowedOrigins: string[]; localModeOrigins: string[]; identity?: ResourceIdentity }
export interface RuntimeSource { sourceRef: string; exactUrl: string; tabId: number; frameId: number; documentKey: string; generation: number; discoveredOrigins: string[]; expiresAt?: number }
export interface PlannedTrack { id: string; kind: 'video' | 'audio' | 'subtitle'; codec: string; language?: string; role?: string }
export interface PlannedSegment {
  id: string; trackId: string; resourceRef: string; initRef?: string; range?: { offset: number; length: number };
  sequence?: number; start: number; duration: number; discontinuity: number;
}
export interface PlannedPart { id: string; periodId?: string; configurationId: string; segments: PlannedSegment[] }
export interface DownloadPlan {
  schemaVersion: 1; id: string; protocol: Protocol; isLive: boolean; selection: Selection; container: Container;
  tracks: PlannedTrack[]; parts: PlannedPart[]; sourceRef: string;
}
export interface ResolvedMedia { protocol: Protocol; isLive: boolean; variants: Variant[]; audioTracks: Track[]; subtitleTracks: Track[]; containers: Container[]; duration?: number }
export interface CheckpointV1 {
  schemaVersion: 1; jobId: string; attempt: number; runEpoch: number; planId: string; revision: number;
  completedSegments: { segmentId: string; path: string; length: number; checksum?: string; identity: ResourceIdentity }[];
  outputs: { path: string; committedBytes: number }[]; updatedAt: number;
}
export type CheckpointRef = string;
export interface RunLease { jobId: string; attempt: number; runEpoch: number; hostId: string }
export interface EngineStore {
  readJob(id: string): Promise<JobSnapshot | undefined>;
  compareAndSwapJob(id: string, expectedRevision: number, next: JobSnapshot): Promise<boolean>;
  putPlan(plan: DownloadPlan): Promise<void>; readPlan(id: string): Promise<DownloadPlan | undefined>;
  commitCheckpoint(checkpoint: CheckpointV1): Promise<void>; readCheckpoint(ref: CheckpointRef): Promise<CheckpointV1 | undefined>;
  listRecoverable(): Promise<JobSnapshot[]>; deleteTemporary(jobId: string, attempt: number): Promise<void>;
  listOrphans(): Promise<{ jobId: string; attempt: number; updatedAt: number }[]>;
  acquireLease(lease: RunLease): Promise<boolean>; releaseLease(lease: RunLease): Promise<void>;
}
export interface AuthorizedFetcher {
  request(source: AuthorizedSource, url: string, options: { signal: AbortSignal; range?: { offset: number; length: number }; identity?: ResourceIdentity; policy?: Pick<SettingsV1, 'retries' | 'firstByteTimeoutMs' | 'stallTimeoutMs'> }): Promise<Response>;
}
export interface RuntimeLimits { globalRequests: number; manifestBytes: number; segments: number; playlistDepth: number; redirects: number }
export interface EngineRun { jobId: string; attempt: number; runEpoch: number; plan: DownloadPlan; source: AuthorizedSource; settingsSnapshot: SettingsV1 }
export interface EngineEvent { jobId: string; attempt: number; runEpoch: number; revision: number; type: 'PROGRESS' | 'CHECKPOINT' | 'EXPORT_READY' | 'WARNING' | 'FAILED' | 'STOPPED'; payload: object }
export interface EngineDeps { store: EngineStore; fetcher: AuthorizedFetcher; onEvent: (event: EngineEvent) => Promise<void>; limits: RuntimeLimits }
export interface EngineSnapshot { hostId: string; runs: { jobId: string; attempt: number; runEpoch: number; revision: number; state: JobState }[] }
export interface Engine {
  inspect(source: AuthorizedSource, signal: AbortSignal): Promise<ResolvedMedia>;
  plan(source: AuthorizedSource, selection: Selection, signal: AbortSignal): Promise<DownloadPlan>;
  start(run: EngineRun): Promise<void>; pause(jobId: string, runEpoch: number): Promise<CheckpointRef>;
  resume(run: EngineRun, checkpoint: CheckpointRef): Promise<void>;
  stopLiveAndSave(jobId: string, runEpoch: number): Promise<void>; cancel(jobId: string, runEpoch: number): Promise<void>;
  snapshot(): Promise<EngineSnapshot>;
}
export const DEFAULT_LIMITS: RuntimeLimits = { globalRequests: 16, manifestBytes: 8 * 1024 * 1024, segments: 100000, playlistDepth: 5, redirects: 10 };
export const DEFAULT_SETTINGS: SettingsV1 = {
  schemaVersion: 1, quality: { mode: 'best' }, audioLanguages: ['ru', 'en'], subtitleLanguages: ['ru'], subtitlesEnabled: false,
  container: 'mp4', filenameTemplate: '{title} [{height}p] [{audioLang}]', relativeDirectory: '', siteDirectories: {},
  jobsConcurrency: 2, segmentsConcurrency: 4, retries: 3, firstByteTimeoutMs: 30000, stallTimeoutMs: 60000,
  discoveryEnabled: true, siteDiscovery: {}, permissionMode: 'selected_sites', historyEnabled: true, historyMaxEntries: 100, historyMaxDays: 30,
};
