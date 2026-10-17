// Media tab nodes (bus task 014): each configured device (receiver, TV, …) read and controlled generically through its
// own HA entities. Table-driven by node type: what a node's state looks like and what each control calls. The legacy
// amp machinery (power-on routine, the music screen's amp) is not involved: a node is "the device", music is MA.
import { HomeError, service } from "./home.server";
import type { HaState } from "./home.server";
import { AMP, MEDIA_NODES } from "./media";
import type { InputName, MediaAction, NodeView } from "./media";
import { nodeEntity } from "./panel-config";
import type { MediaNode } from "./panel-config";

type Attrs = Record<string, unknown>;
const attrs = (s: HaState | undefined): Attrs => (s?.attributes ?? {}) as Attrs;
const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" ? parseFloat(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const strList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
/** yamaha_netbridge's media_player (it reports the receiver's dB volume and its power-on steps). */
export const isNetbridge = (s: HaState | undefined) =>
  s !== undefined && "volume_db" in attrs(s) && "power_on_step" in attrs(s);

/** The node's input list: its entity's source_list in the device's order, minus the inputs its rows hide, and the
 *  names its rows give (pure; unit tested). No row: the device's own title. */
export function nodeInputs(
  n: MediaNode,
  sourceList: string[],
): { sources: string[]; inputNames: Record<string, InputName> } {
  const rows = (n.inputs ?? []).filter((r) => r && typeof r.input === "string");
  const hidden = new Set(rows.filter((r) => r.hidden).map((r) => r.input));
  const inputNames: Record<string, InputName> = {};
  for (const r of rows) {
    const name: InputName = {};
    if (r.name) name.name = r.name;
    if (r.name_he) name.name_he = r.name_he;
    if (name.name || name.name_he) inputNames[r.input] = name;
  }
  return { sources: sourceList.filter((s) => !hidden.has(s)), inputNames };
}

/** A node's live state from the HA states (pure; unit tested). */
export function nodeView(n: MediaNode, states: Map<string, HaState>): NodeView {
  const st = states.get(nodeEntity(n));
  const a = attrs(st);
  const state = st?.state ?? "unavailable";
  const available = state !== "unavailable" && state !== "unknown";
  const plugOff = !!n.plug && states.get(n.plug)?.state === "off";
  const vol = n.volume ? states.get(n.volume) : undefined;
  const sel = n.stream_output ? states.get(n.stream_output) : undefined;
  return {
    id: n.id,
    type: n.type,
    name: n.name,
    available: available || plugOff,
    on: available && !plugOff && state !== "off" && state !== "standby",
    state: plugOff ? "off" : state,
    source: typeof a["source"] === "string" ? a["source"] : null,
    ...nodeInputs(n, strList(a["source_list"])),
    volumeDb: num(a["volume_db"]) ?? (vol && vol.state !== "unavailable" ? num(vol.state) : null),
    volume: num(a["volume_level"]),
    muted: a["is_volume_muted"] === true,
    stream: sel && sel.state !== "unavailable" && sel.state !== "unknown" ? sel.state : null,
    streams: strList(attrs(sel)["options"]),
    movie: !!n.movie_on,
    movieActive: !!n.movie_active && states.get(n.movie_active)?.state === "on",
  };
}

export const nodeViews = (states: Map<string, HaState>, nodes: MediaNode[] = MEDIA_NODES) =>
  nodes.map((n) => nodeView(n, states));

/** The HA calls behind one node control (pure; unit tested). `states` = the current HA states. */
export function nodeCalls(
  n: MediaNode,
  a: Extract<MediaAction, { type: "node" }>,
  states: Map<string, HaState>,
): { domain: string; service: string; data: Record<string, unknown>; background?: boolean }[] {
  const entity = nodeEntity(n);
  const st = states.get(entity);
  switch (a.op) {
    case "power": {
      if (!a.on)
        return [{ domain: "media_player", service: "turn_off", data: { entity_id: entity } }];
      const calls: ReturnType<typeof nodeCalls> = [];
      if (n.plug && states.get(n.plug)?.state === "off")
        calls.push({ domain: "switch", service: "turn_on", data: { entity_id: n.plug } });
      // a receiver's turn_on can block until it is up (yamaha_netbridge: up to a minute): never wait for it
      calls.push({
        domain: "media_player",
        service: "turn_on",
        data: { entity_id: entity },
        background: true,
      });
      return calls;
    }
    case "volume": {
      if (isNetbridge(st))
        return [
          {
            domain: "yamaha_netbridge",
            service: "step_volume_db",
            data: { entity_id: entity, delta_db: a.delta * AMP.volumeStepDb },
          },
        ];
      const v = n.volume ? states.get(n.volume) : undefined;
      const cur = v ? num(v.state) : null;
      if (n.volume && cur !== null) {
        const va = attrs(v);
        const step = va["unit_of_measurement"] === "dB" ? AMP.volumeStepDb : (num(va["step"]) ?? 1);
        const lo = num(va["min"]) ?? -Infinity;
        const hi = num(va["max"]) ?? Infinity;
        return [
          {
            domain: "number",
            service: "set_value",
            data: { entity_id: n.volume, value: Math.max(lo, Math.min(hi, cur + a.delta * step)) },
          },
        ];
      }
      return [
        {
          domain: "media_player",
          service: a.delta > 0 ? "volume_up" : "volume_down",
          data: { entity_id: entity },
        },
      ];
    }
    case "source":
      return [
        {
          domain: "media_player",
          service: "select_source",
          data: { entity_id: entity, source: a.source },
        },
      ];
    case "stream":
      if (!n.stream_output) throw new HomeError("This device has no stream output");
      return [
        {
          domain: "select",
          service: "select_option",
          data: { entity_id: n.stream_output, option: a.option },
        },
      ];
    case "movie": {
      const script = a.on ? n.movie_on : n.movie_off;
      if (!script) throw new HomeError("No movie mode script for this device");
      return [{ domain: "script", service: "turn_on", data: { entity_id: script } }];
    }
  }
}

export async function performNodeAction(
  a: Extract<MediaAction, { type: "node" }>,
  states: Map<string, HaState>,
): Promise<void> {
  const n = MEDIA_NODES.find((x) => x.id === a.id);
  if (!n) throw new HomeError("Unknown device");
  for (const c of nodeCalls(n, a, states)) {
    if (c.background)
      void service(c.domain, c.service, c.data).catch((e: unknown) =>
        console.warn(`[node] ${n.id} ${c.domain}.${c.service} failed:`, e),
      );
    else await service(c.domain, c.service, c.data);
  }
}
