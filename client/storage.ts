/**
 * Browser client for storage.kbn.one (stamp images).
 *
 * Both directions talk to the storage service directly from the browser with
 * the user's id.kbn.one identity: requests carry `Authorization: Bearer <jws>`
 * (the IdP session token) plus the DPoP proof that `fetchDpop` adds — the
 * same scheme its `/upload` and `/download` endpoints verify. home portal's
 * server never proxies the bytes; it only stores the object key.
 *
 * Downloaded images are exposed as `blob:` object URLs and memoized per
 * object key for the lifetime of the page (stamps are small and reused a
 * lot, so one fetch per key is enough).
 */

import type { FetchDpop } from "./session.ts";

/** スタンプ画像の上限（DESIGN.md: 2MB・一般的な画像形式）。 */
export const MAX_STAMP_IMAGE_BYTES = 2 * 1024 * 1024;

export interface StorageSession {
  fetchDpop: FetchDpop;
  accessToken: string;
  storageOrigin: string;
}

function authHeaders(accessToken: string, extra?: HeadersInit): Headers {
  const headers = new Headers(extra);
  headers.set("authorization", `Bearer ${accessToken}`);
  return headers;
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
  const url = new URL("/upload", session.storageOrigin);
  url.searchParams.set("filename", file.name);
  const response = await session.fetchDpop(url.toString(), {
    method: "POST",
    headers: authHeaders(session.accessToken, { "content-type": file.type }),
    body: file,
  });
  if (!response.ok) {
    throw new Error(`アップロードに失敗しました (${response.status})`);
  }
  const data = await response.json() as { key?: string };
  if (!data.key) throw new Error("アップロード結果に key がありません");
  return data.key;
}

// key → object URL (or the in-flight fetch for it). Never evicted: entries
// are tiny and the page holds at most a few dozen distinct stamps.
const imageUrls = new Map<string, Promise<string>>();

/**
 * The `blob:` object URL for a stored stamp image, downloading it (once) via
 * `GET /download?key=…`. Concurrent callers share the same promise; a failed
 * download is forgotten so a later call can retry.
 */
export function stampImageUrl(
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
      throw new Error(`スタンプ画像の取得に失敗しました (${response.status})`);
    }
    return URL.createObjectURL(await response.blob());
  })();
  imageUrls.set(key, promise);
  promise.catch(() => imageUrls.delete(key));
  return promise;
}
