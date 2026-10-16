import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("screensaver photos through Home Assistant", () => {
  const seen: { url: string; auth: string | null }[] = [];
  let photoUrl = "/immich/u1/a1/preview/image/jpeg";

  beforeEach(() => {
    seen.length = 0;
    process.env["HA_TOKEN"] = "secret-token";
    process.env["HA_BASE_URL"] = "http://ha.test:8123";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const auth = new Headers(init?.headers).get("authorization");
        seen.push({ url, auth });
        if (url.includes("/api/services/kindle_panel/pick_photo"))
          return Response.json({
            service_response: {
              photo: { id: "a1", url: photoUrl, title: "a1", source: "s", kept: false },
              kept: 3,
            },
          });
        return new Response(new Uint8Array([1, 2, 3]), {
          headers: { "content-type": "image/jpeg" },
        });
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("fetches an HA-relative photo from HA with the token", async () => {
    const { haPickPhoto } = await import("./photo-ha.server");
    const r = await haPickPhoto(null);
    expect(r.assetId).toBe("a1");
    expect(seen[1]).toEqual({
      url: "http://ha.test:8123/immich/u1/a1/preview/image/jpeg",
      auth: "Bearer secret-token",
    });
  });

  it("never sends the HA token to another host", async () => {
    photoUrl = "https://photos.example.com/x.jpg";
    const { haPickPhoto } = await import("./photo-ha.server");
    await haPickPhoto(null);
    expect(seen[1]).toEqual({ url: "https://photos.example.com/x.jpg", auth: null });
  });

  it("refuses other URL schemes and protocol-relative URLs", async () => {
    const { photoUrl: toUrl } = await import("./photo-ha.server");
    expect(() => toUrl("file:///etc/passwd")).toThrow();
    expect(() => toUrl("//evil.example/x")).toThrow();
  });
});
