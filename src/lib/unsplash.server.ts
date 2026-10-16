// Screensaver photos when no picture library is connected: black-and-white art from Unsplash.
// * With an Unsplash access key (free at unsplash.com/developers; set in HA → Kindle Panel → Screensaver, or
//   UNSPLASH_ACCESS_KEY) the photos come from the Unsplash API for the configured search (default "black and white
//   art"), portrait, in batches of 20 (well inside the 50 requests/hour of a demo key).
// * Without a key: random Unsplash photos in grayscale through Lorem Picsum (picsum.photos, no key needed), not
//   picked by subject.
// Every photo is credited on the screen ("Photo: <name> · Unsplash"), as Unsplash asks.
import { cropToScreen } from "./photo.server";

export type OnlinePhoto = { image: string; credit: string };

type UnsplashPhoto = {
  id: string;
  urls: { raw: string };
  user: { name: string };
  links: { download_location: string };
};

const FAIL_COOLDOWN_MS = 5 * 60_000;
let batch: UnsplashPhoto[] = [];
let batchKey = "";
let failedUntil = 0;

const isHost = (url: string, host: string) => {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname === host;
  } catch {
    return false;
  }
};

async function bytes(url: string): Promise<Buffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`photo ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function fromUnsplash(key: string, query: string): Promise<{ raw: Buffer; name: string }> {
  const auth = { Authorization: `Client-ID ${key}`, "Accept-Version": "v1" };
  if (batchKey !== `${key}|${query}`) {
    batch = [];
    batchKey = `${key}|${query}`;
  }
  if (!batch.length) {
    const u = new URL("https://api.unsplash.com/photos/random");
    u.searchParams.set("query", query);
    u.searchParams.set("orientation", "portrait");
    u.searchParams.set("content_filter", "high");
    u.searchParams.set("count", "20");
    const res = await fetch(u, { headers: auth, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`Unsplash ${res.status}`);
    batch = ((await res.json()) as UnsplashPhoto[]).filter((p) =>
      isHost(p.urls?.raw ?? "", "images.unsplash.com"),
    );
  }
  const p = batch.shift();
  if (!p) throw new Error("Unsplash: no photos for this search");
  const img = new URL(p.urls.raw);
  for (const [k, v] of Object.entries({ w: "600", h: "800", fit: "crop", fm: "jpg", q: "85" }))
    img.searchParams.set(k, v);
  const raw = await bytes(img.toString());
  // Unsplash counts a use like this one (a wallpaper) as a download; the key only goes to Unsplash's own API.
  if (isHost(p.links?.download_location ?? "", "api.unsplash.com"))
    void fetch(p.links.download_location, {
      headers: auth,
      signal: AbortSignal.timeout(10_000),
    }).catch(() => undefined);
  return { raw, name: p.user?.name || "Unsplash" };
}

async function fromPicsum(): Promise<{ raw: Buffer; name: string }> {
  const res = await fetch("https://picsum.photos/600/800?grayscale", {
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Lorem Picsum ${res.status}`);
  const raw = Buffer.from(await res.arrayBuffer());
  // The image is served after a redirect to …/id/<n>/600/800…; the id names the photographer.
  const id = res.headers.get("picsum-id") ?? /\/id\/(\d+)\//.exec(res.url)?.[1] ?? null;
  let name = "Unsplash";
  if (id && /^\d+$/.test(id)) {
    const info = await fetch(`https://picsum.photos/id/${id}/info`, {
      signal: AbortSignal.timeout(5_000),
    })
      .then((r) => (r.ok ? (r.json() as Promise<{ author?: string }>) : null))
      .catch(() => null);
    if (info?.author) name = info.author;
  }
  return { raw, name };
}

/** A black-and-white photo from Unsplash, cropped for the screen; null while offline (then the bundled sample). */
export async function onlinePhoto(opts: {
  key?: string | null | undefined;
  query: string;
}): Promise<OnlinePhoto | null> {
  if (Date.now() < failedUntil) return null;
  const key = (opts.key ?? "").trim() || (process.env["UNSPLASH_ACCESS_KEY"] ?? "").trim();
  try {
    const { raw, name } = key
      ? await fromUnsplash(key, opts.query || "black and white art")
      : await fromPicsum();
    return {
      image: `data:image/jpeg;base64,${(await cropToScreen(raw)).toString("base64")}`,
      credit: name,
    };
  } catch (e) {
    console.warn("[screensaver] no photo from Unsplash:", e instanceof Error ? e.message : e);
    failedUntil = Date.now() + FAIL_COOLDOWN_MS;
    return null;
  }
}

/** For tests. */
export function resetOnlinePhotos() {
  batch = [];
  batchKey = "";
  failedUntil = 0;
}
