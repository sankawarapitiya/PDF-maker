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

export interface Doc {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  pageIds: string[];
  /** Cached for list view */
  thumb?: string;
  /** Cached concatenated OCR text for search */
  text?: string;
}

export type PageSize = 'auto' | 'a4' | 'letter';

export interface Settings {
  ocrLangs: string[];
  autoOcr: boolean;
  autoCapture: boolean;
  defaultFilter: FilterName;
  pageSize: PageSize;
  jpegQuality: number;
}
