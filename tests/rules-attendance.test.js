import assert from "node:assert/strict";
import test from "node:test";

import { materialize } from "../src/backend/state.js";
import { enroll, expectError, makeService, offerAndAccept, standardHost } from "./helpers/factory.js";

function slotState(service, slotId) {
  return materialize(service.store).get("itinerary_slot").get(slotId);
}

test("他人代签：记录原始事实但立即拒收，不产生到场", () => {
  const { service } = makeService();
  const pid = enroll(service, "30");
  const hostId = standardHost(service);
  const slotId = offerAndAccept(service, pid, hostId);
  const r = service.recordCheckin(slotId, { method: "proxy", proxy_for: pid });
  assert.equal(r.attended, false);
  const s = slotState(service, slotId);
  assert.equal(s.attendance, null, "代签不得生成 ATTENDANCE_VERIFIED");
  assert.equal(s.checkins.length, 1);
  assert.equal(s.checkins[0].rejected, true);
});

test("准时本人签到计到场；迟到在宽限内仍算准时，超过宽限计到场但不算准时", () => {
  const { service } = makeService();
  const hostId = standardHost(service);
  const sOnTime = offerAndAccept(service, enroll(service, "31"), hostId);
  const r1 = service.recordCheckin(sOnTime, { check_in_at: "2026-10-04T09:10:00+08:00" });
  assert.equal(r1.attended, true);
  assert.equal(r1.on_time, true);

  const sLate = offerAndAcceptLate(service, enroll(service, "33"), hostId);
  const r2 = service.recordCheckin(sLate, { check_in_at: "2026-10-04T13:40:00+08:00" });
  assert.equal(r2.attended, true);
  assert.equal(r2.on_time, false, "迟到40分钟计到场但不计准时");

  const sGrace = offerAndAcceptLate(service, enroll(service, "40"), standardHost(service, { host_name: "第二家" }));
  const r3 = service.recordCheckin(sGrace, { check_in_at: "2026-10-04T13:12:00+08:00" });
  assert.equal(r3.on_time, true, "15分钟宽限内视为准时");
});

function offerAndAcceptLate(service, pid, hostId) {
  const start = "2026-10-04T13:00:00+08:00";
  const end = "2026-10-04T15:00:00+08:00";
  const { slot_id } = service.offerSlot({
    program_id: "wmyc-2026-autumn", host_id: hostId, participant_id: pid,
    scheduled_start: start, scheduled_end: end,
  });
  service.respondSlot(slot_id, { accept: true });
  return slot_id;
}

test("活动结束后才到不算到场", () => {
  const { service } = makeService();
  const pid = enroll(service, "34");
  const hostId = standardHost(service);
  const slotId = offerAndAccept(service, pid, hostId);
  const r = service.recordCheckin(slotId, { check_in_at: "2026-10-04T12:30:00+08:00" }); // 场次 9:00-11:00
  assert.equal(r.attended, false);
  assert.equal(slotState(service, slotId).attendance, null);
});

test("有效交流需要双方确认；单方确认不构成", () => {
  const { service } = makeService();
  const pid = enroll(service, "35");
  const hostId = standardHost(service);
  const slotId = offerAndAccept(service, pid, hostId);
  service.recordCheckin(slotId, { check_in_at: "2026-10-04T09:02:00+08:00" });
  service.acknowledgeInteraction(slotId, "participant", { topic_refs: ["岗位方向"] });
  assert.equal(slotState(service, slotId).effective_interaction, null);
  service.acknowledgeInteraction(slotId, "host", { topic_refs: ["岗位方向"] });
  assert.ok(slotState(service, slotId).effective_interaction);
});

test("迟到签到不能直接升级为有效交流", () => {
  const { service } = makeService();
  const pid = enroll(service, "36");
  const hostId = standardHost(service);
  const slotId = offerAndAcceptLate(service, pid, hostId);
  service.recordCheckin(slotId, { check_in_at: "2026-10-04T13:50:00+08:00" });
  expectError("LATE_NOT_EFFECTIVE", () => service.acknowledgeInteraction(slotId, "participant"));
});

test("迟到交流经人工复核为有效后，仍须双方确认才构成有效交流；复核结论不可覆盖", () => {
  const { service } = makeService();
  const pid = enroll(service, "41");
  const hostId = standardHost(service);
  const slotId = offerAndAcceptLate(service, pid, hostId);
  service.recordCheckin(slotId, { check_in_at: "2026-10-04T13:40:00+08:00" });

  // 复核前任何单方确认都被拒
  expectError("LATE_NOT_EFFECTIVE", () => service.acknowledgeInteraction(slotId, "host"));

  service.reviewLateInteraction(slotId, { reviewer: "负责人林某", conclusion: "effective", note: "现场监控可见完整交流" });
  // 单方确认仍不够
  service.acknowledgeInteraction(slotId, "participant");
  assert.equal(slotState(service, slotId).effective_interaction, null);
  service.acknowledgeInteraction(slotId, "host");
  assert.equal(slotState(service, slotId).effective_interaction.via_late_review, true);

  // 复核不可覆盖
  expectError("ALREADY_REVIEWED", () => service.reviewLateInteraction(slotId, { reviewer: "另一位", conclusion: "ineffective" }));
});

test("迟到交流复核为无效后，确认通道关闭", () => {
  const { service } = makeService();
  const pid = enroll(service, "42");
  const hostId = standardHost(service);
  const slotId = offerAndAcceptLate(service, pid, hostId);
  service.recordCheckin(slotId, { check_in_at: "2026-10-04T13:50:00+08:00" });
  service.reviewLateInteraction(slotId, { reviewer: "负责人林某", conclusion: "ineffective", note: "仅取物料未交流" });
  expectError("REVIEWED_INEFFECTIVE", () => service.acknowledgeInteraction(slotId, "participant"));
});

test("未核身到场不能确认交流；同一方不能重复确认", () => {
  const { service } = makeService();
  const pid = enroll(service, "37");
  const hostId = standardHost(service);
  const slotId = offerAndAccept(service, pid, hostId);
  expectError("NOT_ATTENDED", () => service.acknowledgeInteraction(slotId, "participant"));
  service.recordCheckin(slotId, { check_in_at: "2026-10-04T09:00:00+08:00" });
  service.acknowledgeInteraction(slotId, "participant");
  expectError("ALREADY_ACKNOWLEDGED", () => service.acknowledgeInteraction(slotId, "participant"));
});

test("已取消/已拒绝场次不能签到", () => {
  const { service } = makeService();
  const pid = enroll(service, "38");
  const hostId = standardHost(service);
  const slotId = offerAndAccept(service, pid, hostId);
  service.cancelHost(hostId, { reason: "闭厂" });
  expectError("SLOT_CLOSED", () => service.recordCheckin(slotId, {}));
});
