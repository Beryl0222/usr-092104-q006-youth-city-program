/**
 * 读模型：只从事件还原结果，不产生新数据。
 * - departureBoard：出发前容量与交通/住宿/接待取消断点
 * - funnel：报名 → 到场 → 有效交流 → 后续意向（+有来源就业结果）
 * - publicStats：k-匿名单维统计（禁止多维交叉、小群抑制）
 * - hostPacket：接待方本场最小资料包（凭有效披露授权）
 */
import { materialize } from "./state.js";
import { HOST_ALLOWED_FIELDS } from "./service.js";

const ACTIVE_SLOT = ["offered", "accepted", "assigned", "replaced"];

export class ReadModelDenied extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function index(snap) {
  const participantSlots = new Map();
  for (const slot of snap.slots.values()) {
    if (!participantSlots.has(slot.participant_id)) participantSlots.set(slot.participant_id, []);
    participantSlots.get(slot.participant_id).push(slot);
  }
  return { participantSlots };
}

/**
 * 出发前看板：负责人在出发前看到容量余量与全部行程断点。
 * 断点类型：host_cancelled（接待取消未接续）、transport_missing（已接受但无交通）、
 * vehicle_overbooked（车辆超员）、logistics_broken（换车/住宿调整造成未接续断点）、
 * awaiting_consent（替代/调整方案等待学生决定）、accessibility_unmet（住宿无障碍未落实）。
 */
export function departureBoard(serviceOrSnap, programId, { asOf = new Date().toISOString() } = {}) {
  const snap = toSnap(serviceOrSnap);
  const hosts = [...snap.hosts.values()].filter((h) => h.program_id === programId);
  const slots = [...snap.slots.values()].filter((s) => s.program_id === programId);

  const hostCards = hosts.map((h) => {
    const mine = slots.filter((s) => s.host_id === h.id);
    const reserved = mine.filter((s) => ACTIVE_SLOT.includes(s.status)).length;
    const accepted = mine.filter((s) => ["accepted", "replaced"].includes(s.status)).length;
    return {
      host_id: h.id,
      host_name: h.host_name,
      host_kind: h.host_kind,
      capacity: h.capacity,
      reserved,
      accepted,
      remaining: Math.max(0, h.capacity - reserved),
      cancelled: h.cancelled,
      cancel_reason: h.cancel_reason ?? null,
    };
  });

  const breakpoints = [];
  const vehicleLoads = new Map(); // vehicle_ref -> {seats, passengers}

  for (const slot of slots) {
    if (slot.status === "declined") continue;
    const participant = snap.participants.get(slot.participant_id);
    const base = { slot_id: slot.id, participant_id: slot.participant_id, participant_name: participant?.name ?? null, host_id: slot.host_id };

    if (slot.status === "cancelled") {
      breakpoints.push({ ...base, kind: "host_cancelled", detail: "接待方取消，尚未形成经同意的替代活动" });
      continue;
    }
    if (slot.pending_change) {
      breakpoints.push({ ...base, kind: "awaiting_consent", detail: `${slot.pending_change.change_kind} 调整等待参与者决定` });
    }
    if (["accepted", "replaced"].includes(slot.status)) {
      if (!slot.transport) {
        breakpoints.push({ ...base, kind: "transport_missing", detail: "已接受场次但交通未安排" });
      } else if (slot.transport.vehicle_ref) {
        const v = vehicleLoads.get(slot.transport.vehicle_ref) ?? { seats: slot.transport.seats_total ?? null, passengers: 0 };
        v.passengers += 1;
        if (slot.transport.seats_total != null) v.seats = slot.transport.seats_total;
        vehicleLoads.set(slot.transport.vehicle_ref, v);
      }
      const needs = participant?.preferences?.accessibility_needs ?? [];
      if (needs.length && (!slot.accommodation || slot.accommodation.accessibility_met === false)) {
        breakpoints.push({ ...base, kind: "accessibility_unmet", detail: "参与者有无障碍需求，住宿尚未安排或未确认满足" });
      }
    }
    if (slot.broken) {
      const latest = slot.change_history.filter((c) => c.broken).at(-1);
      breakpoints.push({ ...base, kind: "logistics_broken", detail: latest ? `${latest.change_kind}：${latest.reason}` : "行程存在未接续断点" });
    }
  }

  for (const [vehicleRef, load] of vehicleLoads) {
    if (load.seats != null && load.passengers > load.seats) {
      breakpoints.push({ kind: "vehicle_overbooked", vehicle_ref: vehicleRef, seats: load.seats, passengers: load.passengers, detail: `车辆 ${vehicleRef} 超员 ${load.passengers - load.seats} 人` });
    }
  }

  return {
    program_id: programId,
    as_of: asOf,
    hosts: hostCards,
    capacity_total: hostCards.reduce((n, h) => n + h.capacity, 0),
    capacity_reserved: hostCards.reduce((n, h) => n + h.reserved, 0),
    hosts_cancelled: hostCards.filter((h) => h.cancelled).length,
    breakpoints,
  };
}

/**
 * 活动后四级漏斗（按参与者去重）：
 * 报名 registered → 到场 attended → 有效交流 effective_interaction → 后续意向 intention。
 * 另列：准时到场 on_time、有来源就业结果 employment、被拒重复认领 duplicate_claims。
 */
export function funnel(serviceOrSnap, programId) {
  const snap = toSnap(serviceOrSnap);
  const { participantSlots } = index(snap);

  const participants = [...snap.participants.values()].filter((p) => p.program_id === programId);
  const outcomes = [...snap.outcomes.values()].filter((o) => o.program_id === programId);

  // 重复认领是跨项目事实：其他项目流上的拒绝事件以 claimed_by_project_id 指回本项目。
  const duplicateClaims =
    outcomes.reduce((n, o) => n + o.rejected_claims.length, 0) +
    [...snap.outcomes.values()]
      .filter((o) => o.program_id !== programId)
      .reduce((n, o) => n + o.rejected_claims.filter((r) => r.claimed_by_project_id === programId).length, 0);

  let registered = 0;
  let withdrawn = 0;
  let attended = 0;
  let onTime = 0;
  let effective = 0;
  const intentionIds = new Set();
  const employedIds = new Set();

  for (const p of participants) {
    registered += 1;
    if (p.withdrawn) withdrawn += 1;
    const mine = participantSlots.get(p.id) ?? [];
    if (mine.some((s) => s.attendance)) {
      attended += 1;
      if (mine.some((s) => s.attendance?.on_time)) onTime += 1;
    }
    if (mine.some((s) => s.effective_interaction)) effective += 1;
  }
  for (const o of outcomes) {
    if (o.intention) intentionIds.add(o.participant_id);
    if (o.employment) employedIds.add(o.participant_id);
  }

  // 场次级明细：报名(邀约/接受) ≠ 到场 ≠ 有效交流。
  const slotRows = [...snap.slots.values()]
    .filter((s) => s.program_id === programId)
    .map((s) => ({
      slot_id: s.id,
      participant_id: s.participant_id,
      host_id: s.host_id,
      status: s.status,
      registered: ["offered", "accepted", "assigned", "replaced", "cancelled"].includes(s.status),
      attended: Boolean(s.attendance),
      on_time: s.attendance?.on_time ?? false,
      late_minutes: s.attendance?.late_minutes ?? null,
      effective_interaction: Boolean(s.effective_interaction),
      proxy_checkins_rejected: s.checkins.filter((c) => c.rejected).length,
      // 未到场原因：区分"被行程断点甩出"与"本人未到"，不把断点造成的脱落算成学生爽约
      dropout_reason: deriveDropoutReason(s),
    }));

  return {
    program_id: programId,
    stages: {
      registered,
      attended,
      on_time_attended: onTime,
      effective_interaction: effective,
      followup_intention: intentionIds.size,
      employment_with_source: employedIds.size,
    },
    withdrawn,
    conversion: {
      registered_to_attended: ratio(attended, registered),
      attended_to_effective: ratio(effective, attended),
      effective_to_intention: ratio(intentionIds.size, effective),
    },
    duplicate_claims_rejected: duplicateClaims,
    slots: slotRows,
  };
}

/**
 * 匿名公共统计：
 * - 只允许单维分布，不提供任何交叉表（交叉可在小群体上反推个人）；
 * - 每个桶计数 < k 一律抑制并入"已抑制"，不显示具体值；
 * - 总样本 < k 时整份统计拒绝发布。
 */
export function publicStats(serviceOrSnap, programId, { k = 5 } = {}) {
  const snap = toSnap(serviceOrSnap);
  const { participantSlots } = index(snap);
  const participants = [...snap.participants.values()].filter((p) => p.program_id === programId && !p.withdrawn);
  const outcomes = [...snap.outcomes.values()].filter((o) => o.program_id === programId);

  if (participants.length < k) {
    return { program_id: programId, k, released: false, reason: `样本量 ${participants.length} 小于匿名阈值 ${k}，统计不予发布` };
  }

  /**
   * 发布处理（防反推）：
   * - 计数 < k 的桶整体隐藏，桶名也不公开（稀有桶名本身可识别个人）；
   * - 全部发布计数向下取整到 k 的倍数，避免用"总数-大桶"差分得到小群人数；
   * - 小桶合计达到 k 时合并为"其他"（同样取整），否则只报有桶被抑制。
   */
  const dist = (counts) => {
    const buckets = [];
    let residual = 0;
    let suppressed = false;
    for (const [key, count] of Object.entries(counts).sort()) {
      if (count === 0) continue; // 未出现的桶不是小群体，直接不展示
      if (count < k) { suppressed = true; residual += count; }
      else buckets.push({ key, count: roundDown(count, k) });
    }
    if (residual >= k) buckets.push({ key: "其他", count: roundDown(residual, k) });
    else if (residual > 0) suppressed = true;
    return { buckets, suppressed, counts_rounded_to: k };
  };

  const byMajor = {};
  const byInterest = {};
  const byHostKind = {};
  const byStage = { registered: 0, attended: 0, effective_interaction: 0, followup_intention: 0 };
  const intentionIds = new Set();
  for (const o of outcomes) if (o.intention) intentionIds.add(o.participant_id);

  for (const p of participants) {
    byStage.registered += 1;
    for (const m of p.preferences?.majors ?? []) byMajor[m] = (byMajor[m] ?? 0) + 1;
    for (const i of p.preferences?.interests ?? []) byInterest[i] = (byInterest[i] ?? 0) + 1;
    const mine = participantSlots.get(p.id) ?? [];
    if (mine.some((s) => s.attendance)) byStage.attended += 1;
    if (mine.some((s) => s.effective_interaction)) byStage.effective_interaction += 1;
    if (intentionIds.has(p.id)) byStage.followup_intention += 1;
    const attendedKinds = new Set();
    for (const s of mine) {
      if (!s.attendance) continue;
      const h = snap.hosts.get(s.host_id);
      if (h) attendedKinds.add(h.host_kind);
    }
    for (const kind of attendedKinds) byHostKind[kind] = (byHostKind[kind] ?? 0) + 1;
  }

  return {
    program_id: programId,
    released: true,
    k,
    note: "仅发布单维分布；禁止任意两维交叉。计数向下取整到 k 的倍数，小群桶名与人数均不公开，不能经差分反推个人。",
    dimensions: {
      fulfillment_stage: dist(byStage),
      major: dist(byMajor),
      interest: dist(byInterest),
      host_kind_of_attended: dist(byHostKind),
    },
  };
}

/**
 * 接待方资料包：仅返回本场有效披露授权列出的字段。
 * - 无授权/已撤回/已过期：拒绝；
 * - 联系方式、证件号、可用时段等不在白名单，任何情况下不返回；
 * - 只能取本接待方、本场次的数据。
 */
export function hostPacket(serviceOrSnap, { host_id, slot_id, asOf = new Date().toISOString() }) {
  const svc = serviceOrSnap;
  const snap = toSnap(svc);
  const slot = snap.slots.get(slot_id);
  if (!slot || slot.host_id !== host_id) throw new ReadModelDenied("NO_ACCESS", "接待方只能访问自己的场次");
  const participant = snap.participants.get(slot.participant_id);
  if (!participant) throw new ReadModelDenied("NO_ACCESS", "参与者不存在");

  const grant = participant.disclosures.find((d) => d.host_id === host_id && d.slot_id === slot_id);
  if (!grant) throw new ReadModelDenied("DISCLOSURE_MISSING", "参与者未向本接待方开放本场资料");
  if (grant.revoked) throw new ReadModelDenied("DISCLOSURE_REVOKED", "资料开放已撤回");
  if (new Date(asOf) > new Date(grant.expires_at)) throw new ReadModelDenied("DISCLOSURE_EXPIRED", "资料开放已过有效期");

  const allowed = grant.fields.filter((f) => HOST_ALLOWED_FIELDS.includes(f));
  const pref = participant.preferences ?? {};
  const fieldValues = {
    name: participant.name,
    school: pref.school ?? null,
    major: slot.matched_major ?? (pref.majors ?? [])[0] ?? null,
    grade: pref.grade ?? null,
    accessibility_on_site: (pref.accessibility_needs ?? []).filter((n) =>
      (snap.hosts.get(host_id)?.accessibility_support ?? []).includes(n)),
  };
  const packet = {
    slot_id,
    host_id,
    purpose: grant.purpose,
    expires_at: grant.expires_at,
    fields: Object.fromEntries(allowed.map((f) => [f, fieldValues[f] ?? null])),
  };
  return packet;
}

function ratio(a, b) {
  return b === 0 ? null : Number((a / b).toFixed(4));
}

function deriveDropoutReason(slot) {
  if (slot.attendance) return null;
  if (slot.status === "declined") return "participant_declined";
  if (slot.status === "cancelled") return "host_cancelled";
  const broken = slot.change_history.filter((c) => c.broken).at(-1);
  if (broken) return `logistics_broken:${broken.change_kind}`;
  if (slot.status === "offered") return "no_response";
  if (["accepted", "assigned", "replaced"].includes(slot.status)) return "did_not_attend";
  return null;
}

function roundDown(n, k) {
  return Math.floor(n / k) * k;
}

/** 接受服务实例、materialize() 的外层 Map 或已构造的快照对象。 */
function toSnap(x) {
  if (x && x.participants instanceof Map && x.hosts instanceof Map) return x;
  if (x instanceof Map && x.get("host_commitment") instanceof Map) {
    return {
      participants: x.get("program_participant"),
      hosts: x.get("host_commitment"),
      slots: x.get("itinerary_slot"),
      outcomes: x.get("engagement_outcome"),
    };
  }
  const all = materialize(x.store);
  return {
    participants: all.get("program_participant"),
    hosts: all.get("host_commitment"),
    slots: all.get("itinerary_slot"),
    outcomes: all.get("engagement_outcome"),
  };
}
