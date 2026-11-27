import type { FilterName, Quad } from './imaging';

export interface OcrWord {
  text: string;
  /** x0, y0, x1, y1 in processed-image pixels */
  bbox: [number, number, number, number];
  conf: number;
}

export interface OcrResult {
  text: string;
  words: OcrWord[];
  lang: string;
  width: number;
  height: number;
  confidence: number;
  at: number;
}

export interface Page {
  id: string;
  /** Original captured photo (downscaled to a sane max size). */
  original: Blob;
  originalWidth: number;
  originalHeight: number;
  /** Document corners in original-image pixels. */
  quad: Quad;
  filter: FilterName;
  /** Clockwise quarter turns applied after cropping. */
  rotation: number;
  /** Result of crop + filter + rotation, JPEG. */
  processed: Blob;
  width: number;
  height: number;
  thumb: string;
  ocr?: OcrResult;
}

export type UploadStatus = 'queued' | 'uploading' | 'uploaded' | 'failed';

export interface UploadState {
  status: UploadStatus;
  remoteDocId: string;
  includeText: boolean;
  /** Stable per upload request; sent as Idempotency-Key so retries never duplicate. */
  attemptId: string;
  attempts: number;
  updatedAt: number;
  nextRetryAt?: number;
  error?: string;
  receipt?: { uploadId: string; sha256: string; bytes: number; receivedAt: number };
}

export interface Folder {
  id: string;
  name: string;
  parentId: string | null;
  color: string;
  createdAt: number;
  updatedAt: number;
}

export type DocKind = 'scan' | 'word';

export interface Doc {
  id: string;
  name: string;
  /** 'scan' (camera pages) or 'word' (rich-text document). Missing = scan. */
  kind?: DocKind;
  /** Containing folder; null/undefined = library root */
  folderId?: string | null;
  createdAt: number;
  updatedAt: number;
  pageIds: string[];
  /** Cached for list view */
  thumb?: string;
  /** Cached concatenated OCR text for search */
  text?: string;
  /** Doc-ID last used to upload this document to the server */
  remoteDocId?: string;
  upload?: UploadState;
  uploadHistory?: (NonNullable<UploadState['receipt']> & { remoteDocId: string })[];
}

export type PageSize = 'auto' | 'a4' | 'letter';

export interface ServerSettings {
  enabled: boolean;
  url: string;
  authMethod: 'token' | 'password';
  username: string;
  docIdPattern: string;
  includeText: boolean;
  deleteAfterUpload: boolean;
  serverName?: string;
}

export interface SecuritySettings {
  lockEnabled: boolean;
  /** Minutes in background before re-locking (0 = immediately) */
  autoLockMinutes: number;
  blockScreenshots: boolean;
}

export type PrinterBrand = 'toshiba' | 'canon' | 'other';
export type PrintProtocol = 'ipp' | 'ipps' | 'raw';
export type PrintSides = 'one-sided' | 'two-sided-long-edge' | 'two-sided-short-edge';
export type PrintMedia = 'iso_a4_210x297mm' | 'na_letter_8.5x11in' | 'iso_a3_297x420mm' | 'na_legal_8.5x14in';

export interface PrintOptions {
  copies: number;
  color: 'color' | 'monochrome';
  sides: PrintSides;
  media: PrintMedia;
}

export interface PrinterConfig {
  id: string;
  name: string;
  brand: PrinterBrand;
  host: string;
  protocol: PrintProtocol;
  port: number;
  path: string;
  model?: string;
  /** document-format-supported reported by the printer */
  formats?: string[];
  colorSupported?: boolean;
  duplexSupported?: boolean;
  /** SHA-256 of the printer's TLS certificate, pinned on first trusted connection (IPPS) */
  certSha256?: string;
  /** Sent as requesting-user-name (job owner shown on the printer panel) */
  jobOwner?: string;
  /** Department / account ID for printers with job accounting (IPP job-account-id) */
  accountId?: string;
  defaults: PrintOptions;
}

export interface PrintSettings {
  printers: PrinterConfig[];
  defaultPrinterId: string | null;
}

export interface Settings {
  server: ServerSettings;
  printing: PrintSettings;
  security: SecuritySettings;
  ocrLangs: string[];
  autoOcr: boolean;
  autoCapture: boolean;
  defaultFilter: FilterName;
  pageSize: PageSize;
  jpegQuality: number;
}
