import assert from "node:assert/strict";
import test from "node:test";

import { enroll, expectError, makeService, offerAndAccept, standardHost } from "./helpers/factory.js";
import { hostPacket } from "../src/backend/read-models.js";
import { materialize } from "../src/backend/state.js";

function acceptAndGrant(service, pid, hostId, fields = ["name", "school", "major", "accessibility_on_site"]) {
  const slotId = offerAndAccept(service, pid, hostId);
  service.grantDisclosure(pid, { host_id: hostId, slot_id: slotId, fields, purpose: "现场接待识别与无障碍支持", ttlHours: 24 });
  return slotId;
}

test("接待方只能取得白名单内的最小字段；联系方式永不入包", () => {
  const { service } = makeService();
  const pid = enroll(service, "50", { accessibility_needs: ["轮椅通行"] });
  const hostId = standardHost(service);
  const slotId = acceptAndGrant(service, pid, hostId);

  expectError("FIELD_NOT_ALLOWED", () => service.grantDisclosure(pid, {
    host_id: hostId, slot_id: slotId, fields: ["name", "phone"], purpose: "试图索取手机号",
  }));

  const now = "2026-10-01T09:00:00+08:00";
  const packet = hostPacket(service, { host_id: hostId, slot_id: slotId, asOf: now });
  assert.deepEqual(Object.keys(packet.fields).sort(), ["accessibility_on_site", "major", "name", "school"]);
  assert.equal(packet.fields.accessibility_on_site.includes("轮椅通行"), true);
  assert.ok(!("phone" in packet.fields));
  assert.ok(!("contact" in packet.fields));
});

test("披露必须限定本接待方本场次，且有有效期；过期/撤回后取不到", () => {
  const { service, clock } = makeService();
  const pid = enroll(service, "51");
  const hostA = standardHost(service);
  const hostB = standardHost(service, { host_name: "另一家企业" });
  const slotA = acceptAndGrant(service, pid, hostA, ["name"]);

  // 其他接待方不能取
  assert.throws(() => hostPacket(service, { host_id: hostB, slot_id: slotA, asOf: "2026-10-01T09:00:00+08:00" }), /自己的场次/);

  // 过期
  clock.advance(25 * 3600 * 1000);
  assert.throws(() => hostPacket(service, { host_id: hostA, slot_id: slotA }), /已过有效期/);

  // 撤回
  service.revokeDisclosure(pid, { host_id: hostA, slot_id: slotA });
  assert.throws(() => hostPacket(service, { host_id: hostA, slot_id: slotA, asOf: "2026-10-01T09:00:00.000+08:00" }), /撤回/);
});

test("无披露授权时接待方取不到任何资料", () => {
  const { service } = makeService();
  const pid = enroll(service, "52");
  const hostId = standardHost(service);
  const slotId = offerAndAccept(service, pid, hostId);
  expectError("DISCLOSURE_MISSING", () => hostPacket(service, { host_id: hostId, slot_id: slotId, asOf: "2026-10-01T09:00:00+08:00" }));
});

test("参与者退出后：历史履约事实保留，但不能再安排新场次", () => {
  const { service, store } = makeService();
  const pid = enroll(service, "53");
  const hostId = standardHost(service);
  const slotId = offerAndAccept(service, pid, hostId);
  service.recordCheckin(slotId, { check_in_at: "2026-10-04T09:05:00+08:00" });
  service.acknowledgeInteraction(slotId, "participant");
  service.acknowledgeInteraction(slotId, "host");

  service.withdrawParticipant(pid, { reason: "课程冲突" });
  // 历史事件仍在
  const types = store.getStream(pid).map((e) => e.event_type);
  assert.ok(types.includes("PARTICIPANT_WITHDRAWN"));
  const slotEvents = store.getStream(slotId);
  assert.ok(slotEvents.some((e) => e.event_type === "ATTENDANCE_VERIFIED"), "到场事实保留");
  assert.ok(slotEvents.some((e) => e.event_type === "INTERACTION_ACKNOWLEDGED"), "交流事实保留");

  // 不能再接受新邀约
  const host2 = standardHost(service, { host_name: "另一家" });
  expectError("PARTICIPANT_WITHDRAWN", () => service.offerSlot({
    program_id: "wmyc-2026-autumn", host_id: host2, participant_id: pid,
    scheduled_start: "2026-10-05T09:00:00+08:00", scheduled_end: "2026-10-05T11:00:00+08:00",
  }));
});

test("撤回后续联系后不能登记新意向，但已发生的意向与履约事实保留", () => {
  const { service, store } = makeService();
  const pid = enroll(service, "54");
  const hostId = standardHost(service);
  const slotId = offerAndAccept(service, pid, hostId);
  service.recordIntention({ program_id: "wmyc-2026-autumn", participant_id: pid, host_id: hostId, related_slot_id: slotId });
  service.revokeFollowup(pid);
  expectError("FOLLOWUP_REVOKED", () => service.recordIntention({
    program_id: "wmyc-2026-autumn", participant_id: pid, host_id: standardHost(service, { host_name: "新企业" }),
  }));
  // 旧意向事件仍在
  assert.ok(store.allEvents().some((e) => e.event_type === "OUTCOME_LINKED"));
});

test("就业结果必须有来源联系与凭据；禁止因果性措辞", () => {
  const { service } = makeService();
  const pid = enroll(service, "55");
  const hostId = standardHost(service);
  const args = { program_id: "wmyc-2026-autumn", participant_id: pid, host_id: hostId, source_type: "host_hr", occurred_on: "2026-11-01" };
  expectError("SOURCE_REQUIRED", () => service.claimEmployment({ ...args, source_contact: "", evidence_ref: "e1" }));
  expectError("EVIDENCE_REQUIRED", () => service.claimEmployment({ ...args, source_contact: "HR王", evidence_ref: "" }));
  expectError("CAUSAL_CLAIM_FORBIDDEN", () => service.claimEmployment({
    ...args, source_contact: "HR王", evidence_ref: "e1", statement: "该生因本次参访被企业录用",
  }));
  const r = service.claimEmployment({ ...args, source_contact: "HR王 13800001111", evidence_ref: "offer-1" });
  assert.equal(r.claimed, true);
  assert.match(r.canonical_statement, /不声称由一次参访造成录用/);
});

test("同一参与者×接待方的就业结果被多个项目重复认领时，仅首个成立，其余拒绝并留痕", () => {
  const { service } = makeService();
  // 学生在 A 项目报名并完成活动
  const pidA = enroll(service, "60", {}, "proj-A");
  const hostId = standardHost(service, { program_id: "proj-A" });
  const slotA = offerAndAcceptIn(service, pidA, hostId, "proj-A");
  const first = service.claimEmployment({
    program_id: "proj-A", participant_id: pidA, host_id: hostId,
    source_type: "host_hr", source_contact: "HR赵", evidence_ref: "offer-9", occurred_on: "2026-11-11",
    related_slot_id: slotA,
  });
  assert.equal(first.claimed, true);

  // B 项目重复认领同一人同一企业
  const second = service.claimEmployment({
    program_id: "proj-B", participant_id: pidA, host_id: hostId,
    source_type: "participant_self", source_contact: "学生本人", evidence_ref: "screenshot-9", occurred_on: "2026-11-12",
  });
  assert.equal(second.claimed, false);
  assert.equal(second.reason, "duplicate_claim_rejected");
  assert.equal(second.owner_project, "proj-A");

  const outcomes = materialize(service.store).get("engagement_outcome");
  const rejectState = [...outcomes.values()].find((o) => o.program_id === "proj-B" && o.rejected_claims.length);
  assert.ok(rejectState, "拒绝事实应作为独立履约事件留痕");
  assert.equal(rejectState.rejected_claims[0].claimed_by_project_id, "proj-A");
  // A 项目的就业结果不受影响
  const owner = [...outcomes.values()].find((o) => o.program_id === "proj-A");
  assert.ok(owner.employment);
});

function offerAndAcceptIn(service, pid, hostId, programId) {
  const { slot_id } = service.offerSlot({
    program_id: programId, host_id: hostId, participant_id: pid,
    scheduled_start: "2026-10-04T09:00:00+08:00", scheduled_end: "2026-10-04T11:00:00+08:00",
  });
  service.respondSlot(slot_id, { accept: true });
  return slot_id;
}
