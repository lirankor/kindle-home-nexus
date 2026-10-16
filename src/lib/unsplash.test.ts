import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, panelView } from "./panel-config";

describe("Unsplash fallback photos", () => {
  const seen: { url: string; auth: string | null }[] = [];
  let jpeg: Buffer;
  let unsplashStatus = 200;

  beforeEach(async () => {
    seen.length = 0;
    unsplashStatus = 200;
    delete process.env["UNSPLASH_ACCESS_KEY"];
    jpeg = await sharp({ create: { width: 40, height: 60, channels: 3, background: "#888" } })
      .jpeg()
      .toBuffer();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        seen.push({ url, auth: new Headers(init?.headers).get("authorization") });
        if (url.startsWith("https://api.unsplash.com/photos/random")) {
          if (unsplashStatus !== 200) return new Response("{}", { status: unsplashStatus });
          return Response.json([
            {
              id: "u1",
              urls: { raw: "https://images.unsplash.com/photo-1?ixid=x" },
              user: { name: "Ansel A." },
              links: { download_location: "https://api.unsplash.com/photos/u1/download" },
            },
            {
              id: "evil",
              urls: { raw: "https://evil.example/photo" },
              user: { name: "x" },
              links: { download_location: "https://evil.example/dl" },
            },
          ]);
        }
        if (url.startsWith("https://picsum.photos/600/800"))
          return new Response(new Uint8Array(jpeg), { headers: { "picsum-id": "42" } });
        if (url === "https://picsum.photos/id/42/info") return Response.json({ author: "Pic Sum" });
        if (url.startsWith("https://images.unsplash.com/") || url.includes("/download"))
          return new Response(new Uint8Array(jpeg));
        return new Response("", { status: 404 });
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("uses the Unsplash API with a key, credits the photographer, and keeps the key to Unsplash's API", async () => {
    const { onlinePhoto, resetOnlinePhotos } = await import("./unsplash.server");
    resetOnlinePhotos();
    const p = await onlinePhoto({ key: "k1", query: "black and white art" });
    expect(p?.credit).toBe("Ansel A.");
    expect(p?.image.startsWith("data:image/jpeg;base64,")).toBe(true);
    const api = new URL(seen[0]!.url);
    expect(api.searchParams.get("query")).toBe("black and white art");
    expect(api.searchParams.get("orientation")).toBe("portrait");
    const img = seen.find((s) => s.url.startsWith("https://images.unsplash.com/"))!;
    expect(img.auth).toBeNull();
    expect(new URL(img.url).searchParams.get("w")).toBe("600");
    await vi.waitFor(() =>
      expect(seen.some((s) => s.url.endsWith("/photos/u1/download"))).toBe(true),
    );
    expect(
      seen.filter((s) => s.auth).every((s) => s.url.startsWith("https://api.unsplash.com/")),
    ).toBe(true);
    expect(seen.some((s) => s.url.includes("evil.example"))).toBe(false); // foreign hosts are dropped
  });

  it("without a key: grayscale Unsplash photos through Lorem Picsum", async () => {
    const { onlinePhoto, resetOnlinePhotos } = await import("./unsplash.server");
    resetOnlinePhotos();
    const p = await onlinePhoto({ query: "ignored" });
    expect(p?.credit).toBe("Pic Sum");
    expect(seen[0]!.url).toBe("https://picsum.photos/600/800?grayscale");
  });

  it("offline or rate-limited: null (the bundled sample), and no retry storm", async () => {
    const { onlinePhoto, resetOnlinePhotos } = await import("./unsplash.server");
    resetOnlinePhotos();
    unsplashStatus = 403;
    expect(await onlinePhoto({ key: "k1", query: "q" })).toBeNull();
    const calls = seen.length;
    expect(await onlinePhoto({ key: "k1", query: "q" })).toBeNull();
    expect(seen.length).toBe(calls); // cooling down
  });

  it("never sends the Unsplash key to the browser", () => {
    const c = structuredClone(DEFAULT_CONFIG);
    c.screensaver.unsplash_key = "secret";
    expect(JSON.stringify(panelView(c, "ha"))).not.toContain("secret");
  });
});
