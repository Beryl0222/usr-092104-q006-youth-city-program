/**
 * 履约命令服务：所有业务不变量的唯一执行者。
 *
 * 关键规则（与团市委需求逐条对应）：
 * 1. 先确认兴趣/无障碍需求/可用时段，才能接受场次；交通住宿只能在接受场次后安排。
 * 2. 场次须匹配专业或兴趣、落在可用时段内、不超容量、不与其他场次时间冲突，
 *    且接待方具备所需无障碍支持；无匹配的指派必须留下带理由的显式审计。
 * 3. 替代活动必须经参与者本人同意（CHANGE_CONSENT_REQUESTED → accepted），
 *    组织方不能单方面换入；换车/住宿调整等后勤变更可单方记录，断点对负责人可见。
 * 4. 代签当场拒收，不产生到场；迟到可算到场但不算准时，准时到场+双方确认才是有效交流。
 * 5. 接待方只能取得完成本场所需的最小字段，授权有目的、有效期，可撤回。
 * 6. 参与者退出/撤回后续联系，只停止新安排与新联系，历史履约事实保留。
 * 7. 就业结果必须登记来源联系人/渠道与凭据，禁止因果性措辞；跨项目重复认领被拒绝并留痕。
 */
import { randomUUID } from "node:crypto";
import { EventStore } from "./store.js";
import { materialize } from "./state.js";
import { EVENT_TYPES } from "../events/catalog.js";

export class DomainRuleError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    Object.assign(this, details);
  }
}

const LATE_GRACE_MINUTES = 15; // 宽限内视为准时
/** 接待方可取得字段的白名单：完成现场接待所需的最小集，不含联系方式与证件号。 */
export const HOST_ALLOWED_FIELDS = ["name", "school", "major", "grade", "accessibility_on_site"];
/** 公共统计允许的单维维度（禁止多维交叉，防止反推个人）。 */
export const PUBLIC_STAT_DIMENSIONS = ["host_kind", "major", "interest", "fulfillment_stage"];

const CAUSAL_PHRASES = /(因|由于).{0,12}(参访|参观|活动|行程).{0,8}(录用|入职|就业)|(参访|参观|活动).{0,10}(导致|促成|带来|促使|成就).{0,8}(录用|入职|就业)|归因于|归功于/;

const ACTIVE_SLOT_STATES = ["offered", "accepted", "assigned", "replaced"];

export class FulfillmentService {
  #store;
  #clock;
  #id;

  constructor({ store = new EventStore(), now = () => new Date(), id = () => randomUUID() } = {}) {
    this.#store = store;
    this.#clock = now;
    this.#id = id;
  }

  get store() { return this.#store; }

  now() { return this.#clock(); }
  iso() { return this.#clock().toISOString(); }

  // ── 内部工具 ────────────────────────────────────────────────────────────

  #snapshot() {
    const all = materialize(this.#store);
    return {
      participants: all.get("program_participant"),
      hosts: all.get("host_commitment"),
      slots: all.get("itinerary_slot"),
      outcomes: all.get("engagement_outcome"),
    };
  }

  #participant(id) {
    const p = this.#snapshot().participants.get(id);
    if (!p) throw new DomainRuleError("PARTICIPANT_NOT_FOUND", `参与者不存在：${id}`);
    return p;
  }

  #slot(id) {
    const s = this.#snapshot().slots.get(id);
    if (!s) throw new DomainRuleError("SLOT_NOT_FOUND", `行程场次不存在：${id}`);
    return s;
  }

  #emit(streamId, eventType, payload, summary, expectedVersion = this.#store.streamVersion(streamId)) {
    const event = {
      event_id: this.#id(),
      event_type: eventType,
      aggregate_type: aggregateOf(eventType),
      aggregate_id: streamId,
      occurred_at: this.iso(),
      version: expectedVersion + 1,
      summary,
      payload,
    };
    this.#store.append([{ streamId, event, expectedVersion }]);
    return event;
  }

  #emitBatch(entries) {
    const prepared = entries.map(({ streamId, eventType, payload, summary }) => {
      const expectedVersion = this.#store.streamVersion(streamId);
      return {
        streamId,
        expectedVersion,
        event: {
          event_id: this.#id(),
          event_type: eventType,
          aggregate_type: aggregateOf(eventType),
          aggregate_id: streamId,
          occurred_at: this.iso(),
          version: expectedVersion + 1,
          summary,
          payload,
        },
      };
    });
    return this.#store.append(prepared);
  }

  #requirePreference(p) {
    if (!p.registered) throw new DomainRuleError("NOT_REGISTERED", "参与者尚未报名");
    if (p.withdrawn) throw new DomainRuleError("PARTICIPANT_WITHDRAWN", "参与者已退出，不能接受新的安排");
    if (!p.preferences) {
      throw new DomainRuleError(
        "PREFERENCE_NOT_CONFIRMED",
        "参与者尚未确认兴趣、无障碍需求与可用时段，不能安排具体场次",
      );
    }
  }

  // ── 报名与偏好 ──────────────────────────────────────────────────────────

  registerParticipant({ program_id, student_id, name, contact = {} }) {
    if (!program_id || !student_id || !name) throw new DomainRuleError("BAD_INPUT", "program_id/student_id/name 必填");
    const streamId = `participant:${program_id}:${student_id}`;
    if (this.#store.streamVersion(streamId) > 0) throw new DomainRuleError("ALREADY_REGISTERED", "该学生已报名本项目");
    this.#emit(streamId, "PARTICIPANT_REGISTERED", {
      program_id, student_id, name, contact: { ...contact }, registered_at: this.iso(),
    }, `${name}报名 ${program_id}`);
    return { participant_id: streamId };
  }

  confirmPreferences(participant_id, pref) {
    const p = this.#participant(participant_id);
    if (p.withdrawn) throw new DomainRuleError("PARTICIPANT_WITHDRAWN", "已退出的参与者不能修改偏好");
    const { school = null, grade = null, majors = [], interests = [], accessibility_needs = [], available_windows = [], contact_consent = false } = pref;
    if (!Array.isArray(majors) || !majors.length) throw new DomainRuleError("BAD_INPUT", "至少填写一个在读专业");
    if (!Array.isArray(available_windows) || !available_windows.length) throw new DomainRuleError("BAD_INPUT", "至少确认一个可用时段");
    for (const w of available_windows) {
      if (!w?.date || !w?.from || !w?.to || w.from >= w.to) throw new DomainRuleError("BAD_INPUT", "可用时段需包含 date/from/to 且 from<to");
    }
    this.#emit(participant_id, "PREFERENCE_CONFIRMED", {
      program_id: p.program_id,
      student_id: p.student_id,
      name: p.name,
      school, grade,
      majors, interests, accessibility_needs, available_windows,
      contact_consent: Boolean(contact_consent),
    }, `${p.name}确认专业兴趣、无障碍需求与可用时段`);
    return { participant_id };
  }

  withdrawParticipant(participant_id, { reason = "" } = {}) {
    const p = this.#participant(participant_id);
    if (p.withdrawn) return { participant_id, changed: false };
    this.#emit(participant_id, "PARTICIPANT_WITHDRAWN", {
      program_id: p.program_id,
      reason,
      withdrew_at: this.iso(),
      note: "退出仅停止后续安排与联系；已发生的签到、交流等履约事实保留",
    }, `${p.name}退出后续行程`);
    return { participant_id, changed: true };
  }

  revokeFollowup(participant_id, { scope = "all" } = {}) {
    const p = this.#participant(participant_id);
    if (!p.followup_consent) return { participant_id, changed: false };
    this.#emit(participant_id, "FOLLOWUP_CONSENT_REVOKED", {
      program_id: p.program_id, revoked_at: this.iso(), scope,
    }, `${p.name}撤回后续联系授权（历史履约事实保留）`);
    return { participant_id, changed: true };
  }

  // ── 接待方承诺 ──────────────────────────────────────────────────────────

  createHostCommitment(h) {
    const { program_id, host_name, host_kind, wanted_majors = [], interests_served = [], capacity, window, accessibility_support = [] } = h;
    if (!program_id || !host_name || !host_kind) throw new DomainRuleError("BAD_INPUT", "接待方名称/类型必填");
    if (!["enterprise", "museum", "talent_event"].includes(host_kind)) throw new DomainRuleError("BAD_INPUT", "host_kind 非法");
    if (!Number.isInteger(capacity) || capacity <= 0) throw new DomainRuleError("BAD_INPUT", "容量必须为正整数");
    if (!window?.start || !window?.end || window.start >= window.end) throw new DomainRuleError("BAD_INPUT", "接待时段非法");
    const host_id = h.host_id ?? `host:${program_id}:${this.#id()}`;
    this.#emit(host_id, "HOST_COMMITMENT_CREATED", {
      program_id, host_name, host_kind, wanted_majors, interests_served, capacity, window, accessibility_support,
      created_at: this.iso(),
    }, `登记接待承诺：${host_name}（容量 ${capacity}）`);
    return { host_id };
  }

  /** 接待方取消：已安排但未完成的场次全部标记断点，等待替代提案；不替学生做决定。 */
  cancelHost(host_id, { reason = "" } = {}) {
    const snap = this.#snapshot();
    const host = snap.hosts.get(host_id);
    if (!host) throw new DomainRuleError("HOST_NOT_FOUND", `接待方不存在：${host_id}`);
    if (host.cancelled) return { host_id, changed: false };

    const entries = [{
      streamId: host_id, eventType: "HOST_CANCELLED",
      payload: { program_id: host.program_id, cancelled_at: this.iso(), reason },
      summary: `接待方取消：${host.host_name}（${reason || "未说明原因"}）`,
    }];
    for (const slot of snap.slots.values()) {
      if (slot.host_id !== host_id) continue;
      if (["cancelled", "declined"].includes(slot.status)) continue;
      // 已经核身到场的场次属于完成事实，接待方事后取消不能追溯抹掉。
      if (slot.attendance) continue;
      entries.push({
        streamId: slot.id, eventType: "ITINERARY_CHANGED",
        payload: {
          program_id: slot.program_id,
          change_kind: "host_cancel",
          reason: `接待方取消：${reason || "未说明原因"}`,
          before: { host_id, scheduled_start: slot.scheduled_start },
          after: null,
          requires_participant_consent: true,
          broken: true,
        },
        summary: "接待方取消，原场次失效，等待参与者决定替代活动",
      });
    }
    this.#emitBatch(entries);
    return { host_id, affected_slots: entries.length - 1, changed: true };
  }

  // ── 场次邀约与接受 ──────────────────────────────────────────────────────

  #matchScore(pref, host) {
    const majors = new Set(host.wanted_majors);
    const interests = new Set(host.interests_served);
    const matchedMajor = pref.majors.find((m) => majors.has(m)) ?? null;
    const matchedInterests = pref.interests.filter((i) => interests.has(i));
    return { matchedMajor, matchedInterests, score: (matchedMajor ? 2 : 0) + matchedInterests.length };
  }

  #withinWindows(isoStart, isoEnd, windows) {
    const start = new Date(isoStart);
    const end = new Date(isoEnd);
    return windows.some((w) => {
      const ws = new Date(`${w.date}T${w.from}:00+08:00`);
      const we = new Date(`${w.date}T${w.to}:00+08:00`);
      return start >= ws && end <= we;
    });
  }

  offerSlot({ program_id, host_id, participant_id, scheduled_start, scheduled_end, allow_mismatch = false, mismatch_reason = null }) {
    const snap = this.#snapshot();
    const p = snap.participants.get(participant_id);
    const host = snap.hosts.get(host_id);
    if (!p) throw new DomainRuleError("PARTICIPANT_NOT_FOUND", "参与者不存在");
    if (!host) throw new DomainRuleError("HOST_NOT_FOUND", "接待方不存在");
    this.#requirePreference(p);
    if (host.program_id !== program_id || p.program_id !== program_id) throw new DomainRuleError("CROSS_PROGRAM", "参与者、接待方不属于同一项目");
    if (host.cancelled) throw new DomainRuleError("HOST_CANCELLED", "接待方已取消，不能向其安排场次");
    if (!scheduled_start || !scheduled_end || scheduled_start >= scheduled_end) throw new DomainRuleError("BAD_INPUT", "场次时间非法");

    const pref = p.preferences;

    // 可用时段：场次必须完整落在学生确认过的某个窗口内。
    if (!this.#withinWindows(scheduled_start, scheduled_end, pref.available_windows)) {
      throw new DomainRuleError("OUTSIDE_AVAILABILITY", "场次不在参与者确认的可用时段内");
    }

    // 时间冲突：同一参与者不得有时间重叠的其他有效场次。
    for (const s of snap.slots.values()) {
      if (s.participant_id !== participant_id) continue;
      if (["cancelled", "declined"].includes(s.status)) continue;
      if (new Date(scheduled_start) < new Date(s.scheduled_end) && new Date(s.scheduled_start) < new Date(scheduled_end)) {
        throw new DomainRuleError("SLOT_OVERLAP", "与参与者已有场次时间冲突", { conflicting_slot_id: s.id });
      }
    }

    // 专业/兴趣匹配：无匹配不得静默指派。
    const { matchedMajor, matchedInterests, score } = this.#matchScore(pref, host);
    if (score === 0 && !allow_mismatch) {
      throw new DomainRuleError("NO_MATCH", "参与者专业与兴趣均与接待方需求不匹配；如确需安排请走显式不匹配审批", { host_id, participant_id });
    }

    // 无障碍支持：接待现场必须能覆盖学生确认的全部无障碍需求。
    const unsupported = pref.accessibility_needs.filter((need) => !host.accessibility_support.includes(need));
    if (unsupported.length) {
      throw new DomainRuleError("ACCESSIBILITY_UNSUPPORTED", "接待方不具备参与者所需的无障碍支持", { unsupported });
    }

    // 容量：邀约即占位，accepted/offered 都计入。
    const reserved = [...snap.slots.values()].filter(
      (s) => s.host_id === host_id && ACTIVE_SLOT_STATES.includes(s.status),
    ).length;
    if (reserved >= host.capacity) throw new DomainRuleError("HOST_FULL", "接待容量已满", { capacity: host.capacity });

    const slotId = `slot:${program_id}:${this.#id()}`;
    this.#emit(slotId, "SLOT_OFFERED", {
      program_id, host_id, participant_id,
      scheduled_start, scheduled_end,
      matched_major: matchedMajor,
      match_score: score,
      offered_at: this.iso(),
    }, `向${p.name}发起场次邀约：${host.host_name}${matchedMajor ? `（专业匹配：${matchedMajor}）` : matchedInterests.length ? `（兴趣匹配：${matchedInterests.join("/")}）` : `（显式不匹配：${mismatch_reason}）`}`);
    return { slot_id: slotId, matched_major: matchedMajor, match_score: score };
  }

  respondSlot(slot_id, { accept, reason = null }) {
    const slot = this.#slot(slot_id);
    const p = this.#participant(slot.participant_id);
    if (p.withdrawn) throw new DomainRuleError("PARTICIPANT_WITHDRAWN", "参与者已退出");
    if (slot.status !== "offered" && slot.status !== "assigned") {
      throw new DomainRuleError("SLOT_NOT_OPEN", `场次当前状态 ${slot.status} 不允许回应`);
    }
    if (accept) {
      this.#emit(slot_id, "SLOT_ACCEPTED", {
        program_id: slot.program_id, participant_id: slot.participant_id, accepted_at: this.iso(),
      }, "参与者接受场次安排");
    } else {
      this.#emit(slot_id, "SLOT_DECLINED", {
        program_id: slot.program_id, participant_id: slot.participant_id, declined_at: this.iso(), reason,
      }, `参与者拒绝场次安排${reason ? `：${reason}` : ""}`);
    }
    return { slot_id, status: accept ? "accepted" : "declined" };
  }

  // ── 交通与住宿（只能在接受场次之后）──────────────────────────────────────

  arrangeTransport(slot_id, t) {
    const slot = this.#slot(slot_id);
    this.#requireAccepted(slot);
    const { mode, vehicle_ref = null, pickup, dropoff, seats_total = null } = t;
    if (!mode || !pickup?.at || !dropoff?.at) throw new DomainRuleError("BAD_INPUT", "交通方式与上下车点必填");
    this.#emit(slot_id, "TRANSPORT_ARRANGED", {
      program_id: slot.program_id, participant_id: slot.participant_id,
      mode, vehicle_ref, pickup, dropoff, seats_total,
    }, `安排${vehicle_ref ? vehicle_ref + " " : ""}交通：${pickup.at} → ${dropoff.at}`);
    return { slot_id };
  }

  arrangeAccommodation(slot_id, a) {
    const slot = this.#slot(slot_id);
    const p = this.#participant(slot.participant_id);
    this.#requireAccepted(slot);
    const { venue_ref, room_ref, check_in, check_out } = a;
    if (!venue_ref || !room_ref || !check_in || !check_out || check_in >= check_out) throw new DomainRuleError("BAD_INPUT", "住宿信息不完整");
    const needs = p.preferences?.accessibility_needs ?? [];
    const accessibility_met = needs.length === 0 ? true : Boolean(a.accessibility_met);
    if (needs.length && !accessibility_met) {
      throw new DomainRuleError("ACCESSIBILITY_UNMET", "住宿调整未满足参与者已确认的无障碍需求", { needs });
    }
    this.#emit(slot_id, "ACCOMMODATION_ARRANGED", {
      program_id: slot.program_id, participant_id: slot.participant_id,
      venue_ref, room_ref, check_in, check_out, accessibility_met,
    }, `安排住宿：${venue_ref}/${room_ref}（无障碍需求${accessibility_met ? "已满足" : "无"}）`);
    return { slot_id };
  }

  #requireAccepted(slot) {
    if (slot.status !== "accepted" && slot.status !== "replaced") {
      throw new DomainRuleError("SLOT_NOT_ACCEPTED", "只有参与者已接受的场次才能安排交通与住宿");
    }
  }

  /**
   * 后勤变更（换车/换房/时间微调）：组织方可单方记录。
   * broken=true 表示该变更造成衔接断点（如临时换车无座、住宿退订），负责人看板可见。
   * 替代活动（replacement）不得走此接口。
   */
  recordLogisticsChange(slot_id, { change_kind, reason, before = null, after = null, broken = false }) {
    const slot = this.#slot(slot_id);
    if (!["transport", "accommodation", "time"].includes(change_kind)) {
      throw new DomainRuleError("BAD_INPUT", "后勤变更类型仅支持 transport/accommodation/time；替代活动须经参与者同意");
    }
    if (["cancelled", "declined"].includes(slot.status)) {
      throw new DomainRuleError("SLOT_CLOSED", "已取消或已拒绝的场次不能再变更");
    }
    this.#emit(slot_id, "ITINERARY_CHANGED", {
      program_id: slot.program_id,
      change_kind, reason, before, after,
      requires_participant_consent: false,
      broken: Boolean(broken),
    }, `${change_kindText(change_kind)}变更：${reason}${broken ? "（形成行程断点）" : ""}`);
    return { slot_id, broken: Boolean(broken) };
  }

  /** 向参与者提出调整（替代活动必须走此流程）。 */
  proposeChange(slot_id, { change_kind, proposal, reason }) {
    const slot = this.#slot(slot_id);
    if (slot.status === "declined") throw new DomainRuleError("SLOT_CLOSED", "参与者已拒绝的场次不能再提出调整");
    if (slot.status === "cancelled" && change_kind !== "replacement") {
      throw new DomainRuleError("SLOT_CANCELLED", "场次因接待方取消而失效，只能提出替代活动");
    }
    if (!["replacement", "transport", "accommodation", "time"].includes(change_kind)) {
      throw new DomainRuleError("BAD_INPUT", "变更类型非法");
    }
    if (!proposal || typeof proposal !== "object") throw new DomainRuleError("BAD_INPUT", "必须给出具体调整提案");
    if (change_kind === "replacement") {
      const newHost = this.#snapshot().hosts.get(proposal.host_id);
      if (!newHost) throw new DomainRuleError("HOST_NOT_FOUND", "替代活动接待方不存在");
      if (newHost.cancelled) throw new DomainRuleError("HOST_CANCELLED", "不能以已取消的接待方作为替代");
      const p = this.#participant(slot.participant_id);
      if (newHost.program_id === slot.program_id) {
        const { score } = this.#matchScore(p.preferences, newHost);
        if (score === 0 && proposal.allow_mismatch !== true) {
          throw new DomainRuleError("NO_MATCH", "替代活动与参与者专业兴趣不匹配");
        }
        const unsupported = p.preferences.accessibility_needs.filter((n) => !newHost.accessibility_support.includes(n));
        if (unsupported.length) throw new DomainRuleError("ACCESSIBILITY_UNSUPPORTED", "替代场地不满足无障碍需求", { unsupported });
      }
    }
    this.#emit(slot_id, "CHANGE_CONSENT_REQUESTED", {
      program_id: slot.program_id, participant_id: slot.participant_id,
      change_kind, proposal, requested_at: this.iso(),
    }, change_kind === "replacement"
      ? `提出替代活动，等待参与者同意：${reason}`
      : `提出${change_kindText(change_kind)}调整，等待参与者确认：${reason}`);
    return { slot_id, awaiting: "participant_consent" };
  }

  decideChange(slot_id, { accept, reason = null }) {
    const slot = this.#slot(slot_id);
    if (!slot.pending_change) throw new DomainRuleError("NO_PENDING_CHANGE", "该场次没有待决定的调整提案");
    const pending = slot.pending_change;

    const consentEvent = this.#emit(slot_id, "CHANGE_CONSENT_DECIDED", {
      program_id: slot.program_id, participant_id: slot.participant_id,
      decision: accept ? "accepted" : "rejected", decided_at: this.iso(), reason,
    }, accept
      ? `参与者同意${pending.change_kind === "replacement" ? "替代活动" : "调整方案"}`
      : `参与者拒绝调整方案${reason ? `：${reason}` : ""}`);

    if (!accept) return { slot_id, decision: "rejected" };

    if (pending.change_kind === "replacement" && pending.proposal.host_id) {
      const snap = this.#snapshot();
      const target = snap.hosts.get(pending.proposal.host_id);
      const taken = [...snap.slots.values()].filter(
        (s) => s.host_id === target.id && s.id !== slot_id && ACTIVE_SLOT_STATES.includes(s.status),
      ).length;
      if (taken >= target.capacity) {
        throw new DomainRuleError("HOST_FULL", "替代活动接待方容量已满，不能换入", { capacity: target.capacity });
      }
    }

    // 同意之后变更才生效；携带同意事件号形成完整证据链（同流顺序追加）。
    this.#emit(slot_id, "ITINERARY_CHANGED", {
      program_id: slot.program_id,
      change_kind: pending.change_kind,
      reason: "参与者已同意",
      before: { host_id: slot.host_id, scheduled_start: slot.scheduled_start, scheduled_end: slot.scheduled_end },
      after: pending.proposal,
      requires_participant_consent: true,
      consent_event_id: consentEvent.event_id,
      broken: false,
    }, pending.change_kind === "replacement" ? "替代活动经参与者同意后生效" : "调整经参与者同意后生效");
    return { slot_id, decision: "accepted", consent_event_id: consentEvent.event_id };
  }

  // ── 签到、到场与有效交流 ────────────────────────────────────────────────

  /**
   * 签到。返回 attended（是否构成到场）与 effective（是否可计入有效交流）。
   * - 代签：记录原始签到后立即拒收，绝不产生到场。
   * - 迟到：本人核身后可算到场，但 on_time=false；有效交流另需双方确认。
   */
  recordCheckin(slot_id, { check_in_at = this.iso(), method = "self", proxy_for = null, verifier = null }) {
    const slot = this.#slot(slot_id);
    if (["cancelled", "declined"].includes(slot.status)) {
      throw new DomainRuleError("SLOT_CLOSED", "该场次已取消/被拒绝，不能签到");
    }
    const checkIn = new Date(check_in_at);
    const start = new Date(slot.scheduled_start);
    const end = new Date(slot.scheduled_end);
    const lateMin = Math.max(0, Math.round((checkIn - start) / 60000));

    if (method === "proxy" || proxy_for) {
      const events = this.#emitBatch([
        {
          streamId: slot_id, eventType: "CHECKIN_RECORDED",
          payload: {
            program_id: slot.program_id, participant_id: slot.participant_id, host_id: slot.host_id,
            check_in_at, late_minutes: lateMin, method: "proxy", proxy_for: proxy_for ?? slot.participant_id,
          },
          summary: "收到代签记录（待拒收）",
        },
      ]);
      this.#emit(slot_id, "PROXY_CHECKIN_REJECTED", {
        program_id: slot.program_id,
        rejected_checkin_event_id: events[0].event_id,
        reason: "他人代签不能计为本人到场或有效交流",
        rejected_at: this.iso(),
      }, "代签已拒收：不计到场、不计有效交流");
      return { attended: false, on_time: false, effective: false, reason: "proxy_rejected" };
    }

    // 本人到场：活动结束之后才到不算到场。
    const arrivedBeforeEnd = checkIn < end;
    const entries = [{
      streamId: slot_id, eventType: "CHECKIN_RECORDED",
      payload: {
        program_id: slot.program_id, participant_id: slot.participant_id, host_id: slot.host_id,
        check_in_at, late_minutes: lateMin, method,
      },
      summary: `本人签到（迟到 ${lateMin} 分钟）`,
    }];
    if (arrivedBeforeEnd) {
      const onTime = lateMin <= LATE_GRACE_MINUTES;
      entries.push({
        streamId: slot_id, eventType: "ATTENDANCE_VERIFIED",
        payload: {
          program_id: slot.program_id, participant_id: slot.participant_id, host_id: slot.host_id,
          check_method: verifier ? `staff:${verifier}` : "campus_code+self",
          check_in_at, late_minutes: lateMin, on_time: onTime,
        },
        summary: onTime ? "准时到场核身通过" : `迟到 ${lateMin} 分钟：计到场，不计准时`,
      });
    }
    this.#emitBatch(entries);
    return {
      attended: arrivedBeforeEnd,
      on_time: arrivedBeforeEnd && lateMin <= LATE_GRACE_MINUTES,
      effective: false, // 有效交流必须另有双方确认
      reason: arrivedBeforeEnd ? null : "arrived_after_end",
    };
  }

  /**
   * 迟到交流人工复核：迟到签到不自动升级为有效交流，须负责人复核并留痕。
   * 复核 effective 仅开启确认通道，仍需参与者与接待方双方确认才构成有效交流。
   */
  reviewLateInteraction(slot_id, { reviewer, conclusion, note = null }) {
    const slot = this.#slot(slot_id);
    if (!slot.attendance) throw new DomainRuleError("NOT_ATTENDED", "未到场场次无需复核");
    if (slot.attendance.on_time) throw new DomainRuleError("NOT_LATE", "准时到场无需迟到复核");
    if (slot.late_review) throw new DomainRuleError("ALREADY_REVIEWED", "迟到交流已复核，结论不可覆盖");
    if (!reviewer) throw new DomainRuleError("BAD_INPUT", "复核负责人必填");
    if (!["effective", "ineffective"].includes(conclusion)) {
      throw new DomainRuleError("BAD_INPUT", "复核结论只能是 effective 或 ineffective");
    }
    this.#emit(slot_id, "LATE_INTERACTION_REVIEWED", {
      program_id: slot.program_id,
      participant_id: slot.participant_id,
      reviewer, reviewed_at: this.iso(), conclusion, note,
    }, `迟到交流经${reviewer}复核为${conclusion === "effective" ? "有效候选（仍需双方确认）" : "无效"}`);
    return { slot_id, conclusion, requires_both_acks: conclusion === "effective" };
  }

  /** 参与者或接待方确认发生了实质性交流；双方都确认且准时到场才构成"有效交流"。 */
  acknowledgeInteraction(slot_id, by_party, { topic_refs = [] } = {}) {
    if (!["participant", "host"].includes(by_party)) throw new DomainRuleError("BAD_INPUT", "确认方只能是 participant 或 host");
    const slot = this.#slot(slot_id);
    if (!slot.attendance) throw new DomainRuleError("NOT_ATTENDED", "未核身到场的场次不能确认交流");
    if (slot.late_review?.conclusion === "ineffective") {
      throw new DomainRuleError("REVIEWED_INEFFECTIVE", "人工复核已认定本次交流无效");
    }
    if (!slot.attendance.on_time && slot.late_review?.conclusion !== "effective") {
      // 迟到签到不能"直接"升级为有效交流：需负责人人工复核后另行开启，本接口拒绝。
      throw new DomainRuleError("LATE_NOT_EFFECTIVE", "迟到到场不直接计为有效交流，须经人工复核流程");
    }
    if (slot.acks[by_party]) throw new DomainRuleError("ALREADY_ACKNOWLEDGED", `${by_party} 已确认过交流`);
    this.#emit(slot_id, "INTERACTION_ACKNOWLEDGED", {
      program_id: slot.program_id, participant_id: slot.participant_id, host_id: slot.host_id,
      by_party, acknowledged_at: this.iso(), topic_refs,
    }, by_party === "participant" ? "参与者确认与接待方完成实质交流" : "接待方确认与学生完成实质交流");
    const after = this.#slot(slot_id);
    return { effective_interaction: Boolean(after.effective_interaction), acks: after.acks };
  }

  // ── 最小披露 ────────────────────────────────────────────────────────────

  grantDisclosure(participant_id, { host_id, slot_id, fields, purpose, ttlHours = 24 }) {
    const snap = this.#snapshot();
    const p = snap.participants.get(participant_id);
    const slot = snap.slots.get(slot_id);
    if (!p || !slot) throw new DomainRuleError("NOT_FOUND", "参与者或场次不存在");
    if (slot.host_id !== host_id || slot.participant_id !== participant_id) {
      throw new DomainRuleError("DISCLOSURE_SCOPE_MISMATCH", "披露只能针对本人本场次的接待方");
    }
    const extra = fields.filter((f) => !HOST_ALLOWED_FIELDS.includes(f));
    if (extra.length) throw new DomainRuleError("FIELD_NOT_ALLOWED", "接待方取得字段超出最小必要范围", { extra });
    if (!purpose) throw new DomainRuleError("BAD_INPUT", "披露目的必填");
    if (!Number.isFinite(ttlHours) || ttlHours <= 0 || ttlHours > 72) throw new DomainRuleError("BAD_INPUT", "披露有效期不超过72小时");
    const expiresAt = new Date(this.#clock().getTime() + ttlHours * 3600000).toISOString();
    this.#emit(participant_id, "DISCLOSURE_GRANTED", {
      program_id: p.program_id, host_id, slot_id, fields, purpose,
      expires_at: expiresAt, granted_at: this.iso(),
    }, `向接待方开放本场最小资料：${fields.join("/")}（${ttlHours}小时有效）`);
    return { expires_at: expiresAt };
  }

  revokeDisclosure(participant_id, { host_id, slot_id }) {
    const p = this.#participant(participant_id);
    this.#emit(participant_id, "DISCLOSURE_REVOKED", {
      program_id: p.program_id, host_id, slot_id, revoked_at: this.iso(),
    }, "撤回对接待方的资料开放");
    return { participant_id };
  }

  // ── 后续意向与就业结果 ──────────────────────────────────────────────────

  #outcomeId(program_id, participant_id, host_id) {
    return `outcome:${program_id}:${participant_id}:${host_id}`;
  }

  recordIntention({ program_id, participant_id, host_id, claim = "参与者表达后续联系/投递意向", related_slot_id = null }) {
    const p = this.#participant(participant_id);
    if (p.withdrawn) throw new DomainRuleError("PARTICIPANT_WITHDRAWN", "参与者已退出，不能登记新的后续意向");
    if (!p.followup_consent) throw new DomainRuleError("FOLLOWUP_REVOKED", "后续联系授权已撤回，不能登记新的后续意向（既有事实保留）");
    if (related_slot_id) {
      const slot = this.#slot(related_slot_id);
      if (slot.participant_id !== participant_id || slot.host_id !== host_id) {
        throw new DomainRuleError("BAD_INPUT", "关联场次与参与者/接待方不一致");
      }
    }
    const oid = this.#outcomeId(program_id, participant_id, host_id);
    this.#emit(oid, "OUTCOME_LINKED", {
      program_id, participant_id, host_id,
      kind: "intention",
      claim,
      related_slot_id,
    }, claim);
    return { outcome_id: oid };
  }

  /**
   * 登记就业结果。
   * - 必须有来源联系（source_contact）与凭据（evidence_ref）；
   * - 同一参与者×接待方的就业结果只能被一个项目认领，其他项目的重复认领被拒绝并留痕；
   * - statement 不得含因果措辞；系统同时生成"只关联不归因"的规范陈述。
   */
  claimEmployment({ program_id, participant_id, host_id, source_type, source_contact, evidence_ref, occurred_on, related_slot_id = null, statement = null }) {
    const snap = this.#snapshot();
    const p = snap.participants.get(participant_id);
    if (!p) throw new DomainRuleError("PARTICIPANT_NOT_FOUND", "参与者不存在");
    if (!["host_hr", "participant_self", "official_record"].includes(source_type)) throw new DomainRuleError("BAD_INPUT", "来源类型非法");
    if (!source_contact || !String(source_contact).trim()) throw new DomainRuleError("SOURCE_REQUIRED", "就业结果必须登记有来源的联系（联系人或渠道）");
    if (!evidence_ref) throw new DomainRuleError("EVIDENCE_REQUIRED", "就业结果必须附来源凭据引用");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(occurred_on ?? "")) throw new DomainRuleError("BAD_INPUT", "occurred_on 需为 YYYY-MM-DD");
    if (related_slot_id) {
      const slot = snap.slots.get(related_slot_id);
      if (!slot || slot.participant_id !== participant_id || slot.host_id !== host_id) {
        throw new DomainRuleError("BAD_INPUT", "关联场次不存在或不属于该参与者×接待方");
      }
    }
    if (statement && CAUSAL_PHRASES.test(statement)) {
      throw new DomainRuleError("CAUSAL_CLAIM_FORBIDDEN", "不得声称一次参访造成录用：陈述含因果性措辞，请改为仅记录来源联系");
    }

    // 跨项目去重：任意项目已认领同一参与者×接待方的就业结果，则拒绝。
    for (const o of snap.outcomes.values()) {
      if (o.participant_id === participant_id && o.host_id === host_id && o.employment) {
        if (o.program_id === program_id) {
          throw new DomainRuleError("ALREADY_CLAIMED", "本项目已认领该就业结果，请勿重复登记");
        }
        const rejectStream = this.#outcomeId(program_id, participant_id, host_id);
        this.#emit(rejectStream, "DUPLICATE_CLAIM_REJECTED", {
          program_id, participant_id, host_id,
          rejected_kind: "employment",
          claimed_by_project_id: o.program_id,
          rejected_at: this.iso(),
        }, `重复认领被拒绝：就业结果已由项目 ${o.program_id} 认领`);
        return { claimed: false, reason: "duplicate_claim_rejected", owner_project: o.program_id };
      }
    }

    const canonical = `经${source_contact}（${source_type}）联系确认存在入职结果` +
      (related_slot_id ? "，与相关场次有关联" : "，无关联场次") +
      "，但不声称由一次参访造成录用";
    const oid = this.#outcomeId(program_id, participant_id, host_id);
    this.#emit(oid, "EMPLOYMENT_RESULT_CLAIMED", {
      program_id, participant_id, host_id,
      source_type, source_contact, evidence_ref, occurred_on,
      related_slot_id,
      statement: statement ? `${statement}｜规范陈述：${canonical}` : canonical,
      claimed_at: this.iso(),
    }, "登记有来源的就业联系（关联但不归因）");
    return { claimed: true, outcome_id: oid, canonical_statement: canonical };
  }
}

function change_kindText(k) {
  return { transport: "交通", accommodation: "住宿", time: "时间", replacement: "替代活动" }[k] ?? k;
}

function aggregateOf(eventType) {
  const spec = EVENT_TYPES[eventType];
  if (!spec) throw new Error(`未登记的事件类型：${eventType}`);
  return spec.aggregate;
}
