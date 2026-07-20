/**
 * Browser client for storage.kbn.one (stamp images and post image attachments).
 *
 * Both directions talk to the storage service directly from the browser with
 * the user's id.kbn.one identity: requests carry `Authorization: Bearer <jws>`
 * (the IdP session token) plus the DPoP proof that `fetchDpop` adds — the
 * same scheme its `/upload` and `/download` endpoints verify. home portal's
 * server never proxies the bytes; it only stores the object key.
 *
 * Downloaded images are exposed as `blob:` object URLs and memoized per
 * object key for the lifetime of the page (one fetch per key is enough).
 */

import type { FetchDpop } from "./session.ts";

/** スタンプ画像の上限（DESIGN.md: 2MB・一般的な画像形式）。 */
export const MAX_STAMP_IMAGE_BYTES = 2 * 1024 * 1024;
/** 添付画像の上限（DESIGN.md: 10MB・最大辺 4096px）。 */
export const MAX_POST_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGE_EDGE = 4096;

export interface StorageSession {
  fetchDpop: FetchDpop;
  accessToken: string;
  storageOrigin: string;
}

/** An uploaded image: the storage key plus what the message needs to render. */
export interface UploadedImage {
  key: string;
  contentType: string;
  width: number;
  height: number;
}

function authHeaders(accessToken: string, extra?: HeadersInit): Headers {
  const headers = new Headers(extra);
  headers.set("authorization", `Bearer ${accessToken}`);
  return headers;
}

/** Stream a blob/file to `POST /upload`, returning the stored object key. */
async function uploadBlob(
  session: StorageSession,
  blob: Blob,
  filename: string,
): Promise<string> {
  const url = new URL("/upload", session.storageOrigin);
  url.searchParams.set("filename", filename);
  const response = await session.fetchDpop(url.toString(), {
    method: "POST",
    headers: authHeaders(session.accessToken, {
      "content-type": blob.type || "application/octet-stream",
    }),
    body: blob,
  });
  if (!response.ok) {
    throw new Error(`アップロードに失敗しました (${response.status})`);
  }
  const data = await response.json() as { key?: string };
  if (!data.key) throw new Error("アップロード結果に key がありません");
  return data.key;
}

/**
 * Upload a stamp image. Validates type/size locally, streams the file to
 * `POST /upload`, and returns the object key to register with home portal.
 */
export async function uploadStampImage(
  session: StorageSession,
  file: File,
): Promise<string> {
  if (!file.type.startsWith("image/")) {
    throw new Error("画像ファイルを選択してください");
  }
  if (file.size > MAX_STAMP_IMAGE_BYTES) {
    throw new Error("画像が大きすぎます（2MB まで）");
  }
  return await uploadBlob(session, file, file.name);
}

/** Read an image's natural dimensions, or (0,0) if the format won't decode. */
async function imageSize(
  file: Blob,
): Promise<{ width: number; height: number }> {
  try {
    const bitmap = await createImageBitmap(file);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  } catch {
    return { width: 0, height: 0 };
  }
}

/**
 * Downscale a raster image so its longest edge is at most `maxEdge`, via a
 * canvas re-encode. PNG sources keep transparency (re-encoded as PNG); others
 * become JPEG. Re-encoding flattens animation, so callers must not run this on
 * animated formats (see {@link uploadPostImage}).
 */
async function downscale(
  file: File,
  maxEdge: number,
): Promise<{ blob: Blob; width: number; height: number }> {
  const bitmap = await createImageBitmap(file);
  const scale = maxEdge / Math.max(bitmap.width, bitmap.height);
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("画像を処理できませんでした");
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const outType = file.type === "image/png" ? "image/png" : "image/jpeg";
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, outType, 0.9)
  );
  if (!blob) throw new Error("画像の変換に失敗しました");
  return { blob, width, height };
}

/**
 * Upload a post image attachment. Enforces the 10MB / {@link MAX_IMAGE_EDGE}
 * rules locally: an image already within the edge limit is uploaded as-is (so
 * animation is preserved); a larger raster is downscaled first (which flattens
 * animation, so oversized GIFs are rejected rather than silently flattened).
 * Returns the stored key plus the content type and dimensions to record.
 */
export async function uploadPostImage(
  session: StorageSession,
  file: File,
): Promise<UploadedImage> {
  if (!file.type.startsWith("image/")) {
    throw new Error("画像ファイルを選択してください");
  }
  const { width, height } = await imageSize(file);
  const longest = Math.max(width, height);

  if (longest <= MAX_IMAGE_EDGE) {
    if (file.size > MAX_POST_IMAGE_BYTES) {
      throw new Error("画像が大きすぎます（10MB まで）");
    }
    const key = await uploadBlob(session, file, file.name);
    return { key, contentType: file.type, width, height };
  }

  // Oversized. Animated GIFs can't be downscaled without flattening.
  if (file.type === "image/gif") {
    throw new Error("GIF は最大辺 4096px 以内にしてください");
  }
  const scaled = await downscale(file, MAX_IMAGE_EDGE);
  if (scaled.blob.size > MAX_POST_IMAGE_BYTES) {
    throw new Error("画像が大きすぎます（10MB まで）");
  }
  const name = file.name.replace(/\.[^.]+$/, "") +
    (scaled.blob.type === "image/png" ? ".png" : ".jpg");
  const key = await uploadBlob(session, scaled.blob, name);
  return {
    key,
    contentType: scaled.blob.type,
    width: scaled.width,
    height: scaled.height,
  };
}

// key → object URL (or the in-flight fetch for it). Never evicted: entries
// are tiny and the page holds at most a few dozen distinct images.
const imageUrls = new Map<string, Promise<string>>();

/**
 * The `blob:` object URL for a stored image (stamp or post attachment),
 * downloading it (once) via `GET /download?key=…`. Concurrent callers share
 * the same promise; a failed download is forgotten so a later call can retry.
 */
export function storageImageUrl(
  session: StorageSession,
  key: string,
): Promise<string> {
  const cached = imageUrls.get(key);
  if (cached) return cached;
  const promise = (async () => {
    const url = new URL("/download", session.storageOrigin);
    url.searchParams.set("key", key);
    const response = await session.fetchDpop(url.toString(), {
      headers: authHeaders(session.accessToken),
    });
    if (!response.ok) {
      throw new Error(`画像の取得に失敗しました (${response.status})`);
    }
    return URL.createObjectURL(await response.blob());
  })();
  imageUrls.set(key, promise);
  promise.catch(() => imageUrls.delete(key));
  return promise;
}
