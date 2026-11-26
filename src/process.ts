import { applyFilter, outputSize, rotate, warpPerspective, type FilterName, type Quad } from './imaging';
import { blobToImg, imgToBlob, thumbnail } from './raster';

export interface ProcessRequest {
  original: Blob;
  quad: Quad;
  filter: FilterName;
  rotation: number;
  quality: number;
}

export interface ProcessResult {
  processed: Blob;
  width: number;
  height: number;
  thumb: string;
}

/** Crop (perspective-correct) + filter + rotate + encode. */
export async function processPage(req: ProcessRequest): Promise<ProcessResult> {
  const src = await blobToImg(req.original);
  const { width, height } = outputSize(req.quad);
  let img = warpPerspective(src, req.quad, width, height);
  img = applyFilter(img, req.filter);
  img = rotate(img, req.rotation);
  const processed = await imgToBlob(img, req.quality);
  return { processed, width: img.width, height: img.height, thumb: await thumbnail(img) };
}
