// Bus task 022: the picker hides what cannot be chosen, shows sync groups, and a refused move keeps the music and the
// output where they were (the 2026-10-18 16:52 case: the receiver was held, MA had already cleared AirPlay).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AMP, syncActionFor } from "./media";
import type { OutputRow } from "./media";
import type { HaState } from "./home.server";
import { DEFAULT_CONFIG } from "./panel-config";

const loaded = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("./panel-config.server", () => ({
  panelConfigNow: () => loaded.current,
  invalidatePanelConfig: vi.fn(),
  setMusicOutput: vi.fn(),
}));

const { groupOrder, moveOutputHa, moveReasonText, outputView, syncOutputHa } =
  await import("./media-ha.server");

const AIRPLAY = "media_player.ma_amp_airplay";
const DLNA = "media_player.ma_amp_dlna";
const TV = "media_player.tv_3";
const PIXEL = "media_player.pixel_phone";
const GONE = "media_player.ma_gone";

function panel(over: { show?: boolean; output?: string } = {}) {
  loaded.current = {
    config: {
      ...DEFAULT_CONFIG,
      media: {
        ...DEFAULT_CONFIG.media,
        music_backend: "ha",
        ...(over.show ? { show_unavailable_outputs: true } : {}),
      },
    },
    source: "ha",
    at: Date.now(),
    musicOutput: over.output ?? AIRPLAY,
    musicOutputValid: true,
    outputs: [
      { entity_id: DLNA, name: "R-N500 DLNA", state: "idle", group_with: [] },
      { entity_id: AIRPLAY, name: "R-N500 AirPlay", state: "playing", group_with: [TV, PIXEL] },
      { entity_id: TV, name: "TV", state: "idle", group_with: [AIRPLAY, PIXEL] },
      { entity_id: PIXEL, name: "Pixel phone", state: "idle", group_with: [AIRPLAY, TV] },
      { entity_id: GONE, name: "Gone speaker", state: "unavailable", group_with: [] },
    ],
    outputsUnexposed: [
      { player_id: "web1", name: "Web (Chrome on Android)", state: "unavailable", kind: "player" },
    ],
  };
}
const st = (entity_id: string, state: string, attributes: Record<string, unknown> = {}): HaState =>
  ({ entity_id, state, attributes }) as HaState;

describe("picker rows (bus task 022)", () => {
  beforeEach(() => panel());
  it("hides unavailable and not-in-HA players by default; the option brings them back", () => {
    const v = outputView(null)!;
    expect(v.outputs.map((o) => o.entity_id)).not.toContain(GONE);
    expect(v.unexposed).toEqual([]);
    // a player that went unavailable since the last get_config hides too, but never the panel's own output
    const live = new Map([
      [PIXEL, st(PIXEL, "unavailable")],
      [AIRPLAY, st(AIRPLAY, "unavailable")],
    ]);
    const ids = outputView(live)!.outputs.map((o) => o.entity_id);
    expect(ids).toContain(AIRPLAY);
    expect(ids).not.toContain(PIXEL);
    panel({ show: true });
    const all = outputView(null)!;
    expect(all.outputs.map((o) => o.entity_id)).toContain(GONE);
    expect(all.unexposed?.map((u) => u.name)).toEqual(["Web (Chrome on Android)"]);
    expect(all.showUnavailable).toBe(true);
  });
  it("a sync group: members under their leader, the output's label names the group", () => {
    const live = new Map([
      [AIRPLAY, st(AIRPLAY, "playing", { group_members: [AIRPLAY, TV] })],
      // HA reports the leader-first list on the member too (live 2026-10-18)
      [TV, st(TV, "playing", { group_members: [AIRPLAY, TV] })],
    ]);
    const v = outputView(live)!;
    expect(v.outputs.map((o) => o.name)).toEqual([
      "Pixel phone",
      "R-N500 AirPlay",
      "TV", // under its leader, not in name order
      "R-N500 DLNA",
    ]);
    expect(v.outputs.find((o) => o.entity_id === TV)?.syncedTo).toBe(AIRPLAY);
    expect(v.groupName).toBe("R-N500 AirPlay + TV");
    expect(
      syncActionFor(
        v.outputs,
        v.entity,
        v.outputs.find((o) => o.entity_id === TV),
      ),
    ).toBe("unjoin");
    expect(
      syncActionFor(
        v.outputs,
        v.entity,
        v.outputs.find((o) => o.entity_id === PIXEL),
      ),
    ).toBe("join");
    // DLNA cannot sync with AirPlay (MA: can_group_with empty); the leader itself has no sync key
    expect(
      syncActionFor(
        v.outputs,
        v.entity,
        v.outputs.find((o) => o.entity_id === DLNA),
      ),
    ).toBe(null);
    expect(
      syncActionFor(
        v.outputs,
        v.entity,
        v.outputs.find((o) => o.entity_id === AIRPLAY),
      ),
    ).toBe(null);
  });
  it("groupOrder keeps a member whose leader is not listed in name order", () => {
    const rows: OutputRow[] = [
      { entity_id: "b", name: "B", state: "idle", syncedTo: "zz" },
      { entity_id: "a", name: "A", state: "idle" },
    ];
    expect(groupOrder(rows).map((r) => r.entity_id)).toEqual(["a", "b"]);
  });
  it("volume: one 5-way press is one 1 dB step", () => {
    expect(AMP.volumeStepDb).toBe(1);
  });
});

describe("HA calls: move and sync (bus task 022)", () => {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  let moveAnswer: Record<string, unknown> = { ok: true, music_output: DLNA };
  beforeEach(() => {
    panel();
    calls.length = 0;
    process.env["HA_TOKEN"] = "t";
    process.env["HA_BASE_URL"] = "http://ha.test";
    process.env["UI_LANGUAGE"] = "he";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const path = url.replace("http://ha.test", "");
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ path, body });
        let payload: unknown = [];
        if (path.startsWith("/api/services/kindle_panel/move_queue"))
          payload = { changed_states: [], service_response: moveAnswer };
        else if (path === "/api/states")
          payload = [
            { entity_id: AIRPLAY, state: "playing", attributes: { group_members: [AIRPLAY, TV] } },
            { entity_id: TV, state: "playing", attributes: {} },
            { entity_id: PIXEL, state: "idle", attributes: {} },
          ];
        return new Response(JSON.stringify(payload), { status: 200 });
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("a refused move keeps the output, shows HA's reason on the music screen and asks for a response", async () => {
    moveAnswer = {
      ok: false,
      reason: "held",
      error: "the receiver is held by another owner (media_player.r_n500: a hold entity is on)",
      music_output: AIRPLAY,
    };
    await expect(moveOutputHa(DLNA)).rejects.toThrow("לא ניתן להעביר: המקלט תפוס (מצב סרט)");
    const call = calls.find((c) => c.path.startsWith("/api/services/kindle_panel/move_queue"))!;
    expect(call.path).toContain("return_response");
    expect(call.body).toEqual({ entity_id: DLNA, source_player: AIRPLAY });
    const v = outputView(null)!;
    expect(v.entity).toBe(AIRPLAY); // the label did not switch
    expect(v.moving).toBeNull();
    expect(v.moveError?.error).toContain("המקלט תפוס");
    expect(v.moveError?.error).toContain("media_player.r_n500");
  });
  it("a move MA undid: the error text from HA, the music back on the source", () => {
    expect(
      moveReasonText(
        {
          ok: false,
          reason: "failed",
          error: "Player R-N500 DLNA refused",
          restored: "moved_back",
        },
        "R-N500 DLNA",
      ),
    ).toBe("לא ניתן להעביר: Player R-N500 DLNA refused");
    process.env["UI_LANGUAGE"] = "en";
    expect(moveReasonText({ ok: false, reason: "unavailable" }, "TV")).toBe(
      "Cannot move: TV is not available",
    );
  });
  it("a successful move switches the output and says moving…", async () => {
    moveAnswer = { ok: true, music_output: DLNA, moved_from: AIRPLAY, items: 26 };
    await moveOutputHa(DLNA);
    const v = outputView(null)!;
    expect(v.entity).toBe(DLNA);
    expect(v.moving?.entity).toBe(DLNA);
    expect(v.moveError).toBeNull();
  });
  it("sync: join targets the output (leader) with the new member; unjoin takes a member out", async () => {
    await syncOutputHa(PIXEL, true);
    expect(calls.find((c) => c.path === "/api/services/media_player/join")?.body).toEqual({
      entity_id: AIRPLAY,
      group_members: [PIXEL],
    });
    await syncOutputHa(TV, false);
    expect(calls.find((c) => c.path === "/api/services/media_player/unjoin")?.body).toEqual({
      entity_id: TV,
    });
    // DLNA cannot sync with AirPlay: refused before any HA call
    const before = calls.length;
    await expect(syncOutputHa(DLNA, true)).rejects.toThrow();
    expect(calls.slice(before).some((c) => c.path.includes("/media_player/join"))).toBe(false);
  });
});
