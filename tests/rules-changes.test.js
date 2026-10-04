import assert from "node:assert/strict";
import test from "node:test";

import { enroll, expectError, makeService, offerAndAccept, slotTime, standardHost } from "./helpers/factory.js";

test("替代活动不能由组织方单方换入：必须先提案、参与者同意才生效", () => {
  const { service, store } = makeService();
  const pid = enroll(service, "20");
  const hostA = standardHost(service, { host_name: "甲企业" });
  const hostB = standardHost(service, { host_name: "乙企业", wanted_majors: ["机械工程"] });
  const slotId = offerAndAccept(service, pid, hostA);

  // 后勤接口不允许夹带 replacement
  expectError("BAD_INPUT", () => service.recordLogisticsChange(slotId, {
    change_kind: "replacement", reason: "组织方直接换", after: { host_id: hostB },
  }));

  service.proposeChange(slotId, {
    change_kind: "replacement", reason: "甲企业临时闭厂", proposal: { ...slotTime(14, 0), host_id: hostB },
  });

  // 提案期间原接待方不变
  const mid = store.getStream(slotId).map((e) => e.event_type);
  assert.ok(!mid.includes("ITINERARY_CHANGED"), "同意前不得产生生效变更");

  service.decideChange(slotId, { accept: true });
  const events = store.getStream(slotId);
  const change = events.find((e) => e.event_type === "ITINERARY_CHANGED" && e.payload.change_kind === "replacement");
  assert.ok(change.payload.consent_event_id, "变更事件必须回填同意事件号");
  assert.equal(change.payload.after.host_id, hostB);
});

test("参与者拒绝替代活动：原场次维持取消/无替代状态，组织方不能再自行换入", () => {
  const { service } = makeService();
  const pid = enroll(service, "21");
  const hostA = standardHost(service);
  const hostB = standardHost(service);
  const slotId = offerAndAccept(service, pid, hostA);
  service.cancelHost(hostA, { reason: "检修停产" });
  service.proposeChange(slotId, {
    change_kind: "replacement", reason: "改去乙企业", proposal: { ...slotTime(14, 0), host_id: hostB },
  });
  service.decideChange(slotId, { accept: false, reason: "不想去" });

  // 拒绝后没有生效变更，且组织方仍不能借后勤接口单方换入/复活场次
  expectError("SLOT_CLOSED", () => service.recordLogisticsChange(slotId, {
    change_kind: "transport", reason: "试图借后勤接口复活场次", broken: false,
  }));
});

test("换车/住宿调整可单方记录，但形成断点时 broken=true 并对看板可见", () => {
  const { service } = makeService();
  const pid = enroll(service, "22");
  const hostId = standardHost(service);
  const slotId = offerAndAccept(service, pid, hostId);
  service.arrangeTransport(slotId, {
    mode: "bus", vehicle_ref: "大巴2号", pickup: { at: "东门" }, dropoff: { at: "厂区" }, seats_total: 40,
  });
  const r = service.recordLogisticsChange(slotId, {
    change_kind: "transport", reason: "2号车故障，临时换小车且座位不足",
    before: { vehicle_ref: "大巴2号" }, after: { vehicle_ref: "临时小车", seats_total: 20 }, broken: true,
  });
  assert.equal(r.broken, true);
});

test("接待方取消后所有未完成场次进入断点，已完成（有效交流）的场次不被追溯取消", () => {
  const { service } = makeService();
  const pid1 = enroll(service, "23");
  const pid2 = enroll(service, "24");
  const hostId = standardHost(service, { capacity: 5 });
  const slot1 = offerAndAccept(service, pid1, hostId, slotTime(9, 0));
  const slot2 = offerAndAccept(service, pid2, hostId, slotTime(13, 0));
  // 第一场已完成交流
  service.recordCheckin(slot1, { check_in_at: "2026-10-04T09:05:00+08:00" });
  service.acknowledgeInteraction(slot1, "participant");
  service.acknowledgeInteraction(slot1, "host");

  const res = service.cancelHost(hostId, { reason: "临时接待任务冲突" });
  assert.equal(res.affected_slots, 1, "只影响未完成场次");
  const events2 = service.store.getStream(slot2);
  assert.ok(events2.some((e) => e.event_type === "ITINERARY_CHANGED" && e.payload.change_kind === "host_cancel" && e.payload.broken));
  const events1 = service.store.getStream(slot1);
  assert.ok(!events1.some((e) => e.payload?.change_kind === "host_cancel"), "已完成场次不被追溯取消");
});
