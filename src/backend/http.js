/**
 * HTTP 适配层（零依赖 node:http）。
 * 身份以请求头模拟：x-role = organizer | participant | host；x-actor-id 为其标识。
 * 生产部署应替换为网关注入的认证主体；授权矩阵在此处显式声明。
 */
import { createServer } from "node:http";
import { DomainRuleError, FulfillmentService } from "./service.js";
import { departureBoard, funnel, hostPacket, publicStats, ReadModelDenied } from "./read-models.js";

const ROLES = new Set(["organizer", "participant", "host"]);

/** 命令授权表：未列出的动作默认仅 organizer。值为对调用者的额外约束。 */
const PERMISSIONS = {
  "POST /participants": ["organizer"],
  "POST /participants/:id/preferences": ["organizer", "participant:self"],
  "POST /participants/:id/withdraw": ["organizer", "participant:self"],
  "POST /participants/:id/revoke-followup": ["organizer", "participant:self"],
  "POST /participants/:id/disclosures": ["organizer", "participant:self"],
  "DELETE /participants/:id/disclosures": ["organizer", "participant:self"],
  "DELETE /participants/:id/disclosures": ["organizer", "participant:self"],
  "POST /hosts": ["organizer"],
  "POST /hosts/:id/cancel": ["organizer"],
  "POST /slots/offer": ["organizer"],
  "POST /slots/:id/respond": ["organizer", "participant:owner"],
  "POST /slots/:id/transport": ["organizer"],
  "POST /slots/:id/accommodation": ["organizer"],
  "POST /slots/:id/change-request": ["organizer"],
  "POST /slots/:id/change-decision": ["organizer", "participant:owner"],
  "POST /slots/:id/logistics-change": ["organizer"],
  "POST /slots/:id/checkin": ["organizer"],
  "POST /slots/:id/late-review": ["organizer"],
  "POST /slots/:id/acknowledge": ["organizer", "participant:owner", "host:owner"],
  "POST /outcomes/intention": ["organizer"],
  "POST /outcomes/employment": ["organizer"],
};

function authorize(key, role, actorId, ctx) {
  const allow = PERMISSIONS[key] ?? ["organizer"];
  for (const a of allow) {
    if (a === role) return true;
    if (a === "participant:self" && role === "participant" && ctx.participantId === actorId) return true;
    if (a === "participant:owner" && role === "participant" && ctx.ownerParticipantId === actorId) return true;
    if (a === "host:owner" && role === "host" && ctx.hostId === actorId) return true;
  }
  return false;
}

export function createApp(service = new FulfillmentService()) {
  return createServer(async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(body));
    };
    try {
      const role = req.headers["x-role"] ?? "organizer";
      const actorId = req.headers["x-actor-id"] ?? null;
      if (!ROLES.has(role)) return send(400, { error: "BAD_ROLE" });

      const url = new URL(req.url, "http://localhost");
      let path = url.pathname.replace(/\/+$/, "") || "/";
      try { path = decodeURIComponent(path); } catch { /* 非法编码保持原样 */ }
      const method = req.method;
      const body = method === "GET" || method === "DELETE" ? Object.fromEntries(url.searchParams) : await readJson(req);

      // ── 读端点 ─────────────────────────────────────────────────────────
      if (method === "GET" && path.startsWith("/programs/") && path.endsWith("/departure-board")) {
        if (role !== "organizer") return send(403, { error: "FORBIDDEN" });
        return send(200, departureBoard(service, path.split("/")[2]));
      }
      if (method === "GET" && path.startsWith("/programs/") && path.endsWith("/funnel")) {
        if (role !== "organizer") return send(403, { error: "FORBIDDEN" });
        return send(200, funnel(service, path.split("/")[2]));
      }
      if (method === "GET" && path.startsWith("/programs/") && path.endsWith("/public-stats")) {
        const k = Number(url.searchParams.get("k") ?? "5");
        // 公共统计不加角色限制，但匿名阈值由发布方控制。
        return send(200, publicStats(service, path.split("/")[2], { k }));
      }
      if (method === "GET" && path.startsWith("/hosts/") && path.endsWith("/packet")) {
        const hostId = path.split("/")[2];
        if (role !== "host" || actorId !== hostId) return send(403, { error: "FORBIDDEN", detail: "接待方只能领取本方资料包" });
        return send(200, hostPacket(service, { host_id: hostId, slot_id: url.searchParams.get("slot_id") }));
      }
      if (method === "GET" && path === "/events") {
        if (role !== "organizer") return send(403, { error: "FORBIDDEN" });
        return send(200, { events: service.store.allEvents() });
      }

      // ── 命令端点 ───────────────────────────────────────────────────────
      const segs = path.split("/").filter(Boolean);
      const result = await dispatch(service, method, segs, body, role, actorId);
      if (result?.forbidden) return send(403, { error: "FORBIDDEN", detail: result.forbidden });
      return send(200, result ?? { ok: true });
    } catch (err) {
      if (err instanceof SyntaxError) return send(400, { error: "BAD_JSON", detail: err.message });
      if (err instanceof DomainRuleError || err instanceof ReadModelDenied) {
        const status = {
          ALREADY_REGISTERED: 409, ALREADY_CLAIMED: 409, CONCURRENCY: 409,
          SLOT_OVERLAP: 409, HOST_FULL: 409,
        }[err.code] ?? 422;
        return send(status, { error: err.code, detail: err.message });
      }
      if (err.code === "NOT_FOUND") return send(404, { error: "NOT_FOUND", detail: err.message });
      if (err.code === "CONCURRENCY") return send(409, { error: "CONCURRENCY", detail: err.message });
      return send(500, { error: "INTERNAL", detail: String(err?.message ?? err) });
    }
  });
}

async function dispatch(service, method, segs, body, role, actorId) {
  const deny = (ctx) => {
    const permKey = permissionKeyFor(method, segs);
    return authorize(permKey, role, actorId, ctx) ? null : { forbidden: "无权执行该操作" };
  };

  if (method === "POST" && segs[0] === "participants" && segs[2] === undefined) {
    return call(deny({}), () => service.registerParticipant(body));
  }
  if (segs[0] === "participants" && segs[2] === "preferences") {
    const pid = segs[1];
    const d = deny({ participantId: pid });
    if (d) return d;
    return service.confirmPreferences(pid, body);
  }
  if (segs[0] === "participants" && segs[2] === "withdraw") {
    const pid = segs[1];
    const d = deny({ participantId: pid });
    if (d) return d;
    return service.withdrawParticipant(pid, body);
  }
  if (segs[0] === "participants" && segs[2] === "revoke-followup") {
    const pid = segs[1];
    const d = deny({ participantId: pid });
    if (d) return d;
    return service.revokeFollowup(pid, body);
  }
  if (segs[0] === "participants" && segs[2] === "disclosures") {
    const pid = segs[1];
    const d = deny({ participantId: pid });
    if (d) return d;
    if (method === "POST") return service.grantDisclosure(pid, body);
    if (method === "DELETE") return service.revokeDisclosure(pid, body);
  }
  if (method === "POST" && segs[0] === "hosts" && segs.length === 1) {
    const d = deny({});
    if (d) return d;
    return service.createHostCommitment(body);
  }
  if (segs[0] === "hosts" && segs[2] === "cancel") {
    const d = deny({});
    if (d) return d;
    return service.cancelHost(segs[1], body);
  }
  if (method === "POST" && segs[0] === "slots" && segs[1] === "offer") {
    const d = deny({});
    if (d) return d;
    return service.offerSlot(body);
  }
  if (segs[0] === "slots" && segs[2] === "respond") {
    const owner = await ownerParticipant(service, segs[1]);
    const d = deny({ ownerParticipantId: owner });
    if (d) return d;
    return service.respondSlot(segs[1], body);
  }
  if (segs[0] === "slots" && segs[2] === "transport") {
    const d = deny({});
    if (d) return d;
    return service.arrangeTransport(segs[1], body);
  }
  if (segs[0] === "slots" && segs[2] === "accommodation") {
    const d = deny({});
    if (d) return d;
    return service.arrangeAccommodation(segs[1], body);
  }
  if (segs[0] === "slots" && segs[2] === "change-request") {
    const d = deny({});
    if (d) return d;
    return service.proposeChange(segs[1], body);
  }
  if (segs[0] === "slots" && segs[2] === "change-decision") {
    const owner = await ownerParticipant(service, segs[1]);
    const d = deny({ ownerParticipantId: owner });
    if (d) return d;
    return service.decideChange(segs[1], body);
  }
  if (segs[0] === "slots" && segs[2] === "logistics-change") {
    const d = deny({});
    if (d) return d;
    return service.recordLogisticsChange(segs[1], body);
  }
  if (segs[0] === "slots" && segs[2] === "checkin") {
    const d = deny({});
    if (d) return d;
    return service.recordCheckin(segs[1], body);
  }
  if (segs[0] === "slots" && segs[2] === "late-review") {
    const d = deny({});
    if (d) return d;
    return service.reviewLateInteraction(segs[1], body);
  }
  if (segs[0] === "slots" && segs[2] === "acknowledge") {
    const owner = await slotOwnership(service, segs[1]);
    const d = deny({ ownerParticipantId: owner?.participant_id ?? null, hostId: owner?.host_id ?? null });
    if (d) return d;
    // host 角色只能以 host 方确认，participant 角色只能以 participant 方确认。
    if (role === "host" && body?.by_party !== "host") return { forbidden: "接待方身份只能提交接待方确认" };
    if (role === "participant" && body?.by_party !== "participant") return { forbidden: "学生身份只能提交本人确认" };
    return service.acknowledgeInteraction(segs[1], body.by_party, { topic_refs: body.topic_refs ?? [] });
  }
  if (method === "POST" && segs[0] === "outcomes" && segs[1] === "intention") {
    const d = deny({});
    if (d) return d;
    return service.recordIntention(body);
  }
  if (method === "POST" && segs[0] === "outcomes" && segs[1] === "employment") {
    const d = deny({});
    if (d) return d;
    return service.claimEmployment(body);
  }
  const e = new Error("未找到路由");
  e.code = "NOT_FOUND";
  throw e;
}

function call(d, fn) { if (d) return d; return fn(); }

function permissionKeyFor(method, segs) {
  const parts = segs.map((s, i) => (i === 1 && ["participants", "hosts", "slots"].includes(segs[0]) ? ":id" : s));
  return `${method} /${parts.join("/")}`;
}

async function ownerParticipant(service, slotId) {
  const { materialize } = await import("./state.js");
  const slot = materialize(service.store).get("itinerary_slot").get(slotId);
  return slot?.participant_id ?? null;
}

async function slotOwnership(service, slotId) {
  const { materialize } = await import("./state.js");
  const slot = materialize(service.store).get("itinerary_slot").get(slotId);
  return slot ? { participant_id: slot.participant_id, host_id: slot.host_id } : null;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 1_000_000) reject(new Error("请求体过大")); });
    req.on("end", () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

const DEFAULT_PORT = 3000;
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  createApp().listen(port, () => {
    console.log(`城市体验履约后端监听 :${port}`);
  });
}
