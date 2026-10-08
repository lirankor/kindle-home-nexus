// GET /media/img?station=<catalog id>|item=<jellyfin id>&w=<px>  (no free-form URLs: SSRF)
// Returns a square grayscale PNG for <img src> on the e-ink panel (resized server-side, cached on disk).
import { createFileRoute } from "@tanstack/react-router";
import { imageFor } from "@/lib/media.server";

export const Route = createFileRoute("/media/img")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const q = new URL(request.url).searchParams;
        const width = parseInt(q.get("w") ?? "96", 10);
        const png = await imageFor({
          station: q.get("station"),
          item: q.get("item"),
          width: Number.isFinite(width) ? width : 96,
        });
        if (!png) return new Response(null, { status: 404 });
        return new Response(new Uint8Array(png), {
          headers: {
            "Content-Type": "image/png",
            "Cache-Control": "public, max-age=86400",
          },
        });
      },
    },
  },
});
