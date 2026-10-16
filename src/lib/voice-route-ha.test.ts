import { afterEach, describe, expect, it } from "vitest";
import { Route } from "@/routes/api/voice.$";

type Handler = (ctx: { request: Request }) => Promise<Response>;
const post = (Route.options as unknown as { server: { handlers: { POST: Handler } } }).server
  .handlers.POST;

describe("voice API with MUSIC_BACKEND=ha", () => {
  afterEach(() => {
    delete process.env["MUSIC_BACKEND"];
    delete process.env["VOICE_TOKEN"];
  });
  it("refuses play/action/radio so the legacy queue never drives the amp", async () => {
    process.env["VOICE_TOKEN"] = "tok";
    process.env["MUSIC_BACKEND"] = "ha";
    for (const path of ["play", "action", "radio"]) {
      const res = await post({
        request: new Request(`http://app/api/voice/${path}`, {
          method: "POST",
          headers: { Authorization: "Bearer tok", "Content-Type": "application/json" },
          body: JSON.stringify({ query: "eagles", op: "next", station: "WDR 5" }),
        }),
      });
      expect(res.status).toBe(409);
    }
  });
});
