import sharp from "sharp";

export const IMAGE_THUMBNAIL_WIDTH = 56;
export const IMAGE_THUMBNAIL_HEIGHT = 32;
const IMAGE_THUMBNAIL_CACHE_ENTRIES = 256;
const IMAGE_THUMBNAIL_MAX_INPUT_PIXELS = 40_000_000;

type CachedThumbnail = {
  fingerprint: string;
  body: Buffer;
};

export class ImageThumbnailService {
  private readonly cache = new Map<string, CachedThumbnail>();
  private readonly inFlight = new Map<string, Promise<Buffer>>();

  async render(fileId: string, absolutePath: string, fingerprint: string): Promise<Buffer> {
    const cached = this.cache.get(fileId);
    if (cached?.fingerprint === fingerprint) {
      this.cache.delete(fileId);
      this.cache.set(fileId, cached);
      return cached.body;
    }

    const inFlightKey = `${fileId}:${fingerprint}`;
    const existing = this.inFlight.get(inFlightKey);
    if (existing) return existing;

    const rendering = sharp(absolutePath, {
      animated: false,
      failOn: "warning",
      limitInputPixels: IMAGE_THUMBNAIL_MAX_INPUT_PIXELS,
      sequentialRead: true,
    })
      .rotate()
      .resize(IMAGE_THUMBNAIL_WIDTH, IMAGE_THUMBNAIL_HEIGHT, { fit: "cover", position: "centre" })
      .webp({ quality: 64, effort: 2, smartSubsample: true })
      .toBuffer();
    this.inFlight.set(inFlightKey, rendering);
    try {
      const body = await rendering;
      this.cache.set(fileId, { fingerprint, body });
      while (this.cache.size > IMAGE_THUMBNAIL_CACHE_ENTRIES) {
        const oldest = this.cache.keys().next().value as string | undefined;
        if (!oldest) break;
        this.cache.delete(oldest);
      }
      return body;
    } finally {
      this.inFlight.delete(inFlightKey);
    }
  }
}
