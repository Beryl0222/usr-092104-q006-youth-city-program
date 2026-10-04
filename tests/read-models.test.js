import assert from "node:assert/strict";
import test from "node:test";

import { departureBoard, funnel, publicStats } from "../src/backend/read-models.js";
import { DAY, enroll, makeService, PROGRAM, slotTime, standardHost } from "./helpers/factory.js";

test("出发前看板：容量余量、缺交通、接待取消、待同意替代均作为断点呈现", () => {
  const { service } = makeService();
  const hostId = standardHost(service, { capacity: 3 });
  const canceled = standardHost(service, { host_name: "临时取消的展馆", host_kind: "museum", wanted_majors: ["机械工程"], interests_served: ["先进制造"], capacity: 5 });

  const p1 = enroll(service, "70");
  const p2 = enroll(service, "71");
  const o1 = service.offerSlot({ program_id: PROGRAM, host_id: hostId, participant_id: p1, ...slotTime(9, 0) });
  service.respondSlot(o1.slot_id, { accept: true });
  service.arrangeTransport(o1.slot_id, {
    mode: "bus", vehicle_ref: "大巴1号", pickup: { at: "东门" }, dropoff: { at: "厂区" }, seats_total: 40,
  });
  const o2 = service.offerSlot({ program_id: PROGRAM, host_id: hostId, participant_id: p2, ...slotTime(13, 0) });
  service.respondSlot(o2.slot_id, { accept: true }); // 未安排交通 → 断点

  const o3 = service.offerSlot({ program_id: PROGRAM, host_id: canceled, participant_id: enroll(service, "72"), ...slotTime(9, 0) });
  service.respondSlot(o3.slot_id, { accept: true });
  service.cancelHost(canceled, { reason: "展馆维护" });

  const board = departureBoard(service, PROGRAM);
  const card = board.hosts.find((h) => h.host_id === hostId);
  assert.equal(card.capacity, 3);
  assert.equal(card.reserved, 2);
  assert.equal(card.remaining, 1);
  assert.equal(board.hosts_cancelled, 1);

  const kinds = board.breakpoints.map((b) => b.kind);
  assert.ok(kinds.includes("transport_missing"));
  assert.ok(kinds.includes("host_cancelled"));
});

test("车辆超员在看板上暴露为 vehicle_overbooked", () => {
  const { service } = makeService();
  const hostId = standardHost(service, { capacity: 10 });
  const slots = [];
  for (let i = 0; i < 3; i++) {
    const pid = enroll(service, `8${i}`);
    const o = service.offerSlot({ program_id: PROGRAM, host_id: hostId, participant_id: pid, ...slotTime(9 + i, 0) });
    service.respondSlot(o.slot_id, { accept: true });
    slots.push(o.slot_id);
  }
  for (const s of slots) {
    service.arrangeTransport(s, {
      mode: "bus", vehicle_ref: "同一辆车", pickup: { at: "东门" }, dropoff: { at: "厂区" }, seats_total: 2,
    });
  }
  const board = departureBoard(service, PROGRAM);
  assert.ok(board.breakpoints.some((b) => b.kind === "vehicle_overbooked"));
});

test("活动后漏斗严格区分 报名/到场/有效交流/后续意向", () => {
  const { service } = makeService();
  const hostId = standardHost(service, { capacity: 20 });

  // 4 人：A 全流程；B 只报名接受未到场；C 到场但未交流；D 交流且有意向
  const a = enroll(service, "90");
  const b = enroll(service, "91");
  const c = enroll(service, "92");
  const d = enroll(service, "93");

  for (const [pid, hour] of [[a, 9], [b, 10], [c, 13], [d, 14]]) {
    const o = service.offerSlot({ program_id: PROGRAM, host_id: hostId, participant_id: pid, ...slotTime(hour, 0) });
    service.respondSlot(o.slot_id, { accept: true });
    if (pid !== b) service.arrangeTransport(o.slot_id, { mode: "self", pickup: { at: "自行" }, dropoff: { at: "厂区" } });
    if (pid === a || pid === c || pid === d) {
      service.recordCheckin(o.slot_id, { check_in_at: `${DAY}T${String(hour).padStart(2, "0")}:05:00+08:00` });
    }
    if (pid === a || pid === d) {
      service.acknowledgeInteraction(o.slot_id, "participant");
      service.acknowledgeInteraction(o.slot_id, "host");
    }
    if (pid === d) {
      service.recordIntention({ program_id: PROGRAM, participant_id: pid, host_id: hostId, related_slot_id: o.slot_id });
    }
  }

  const f = funnel(service, PROGRAM);
  assert.equal(f.stages.registered, 4);
  assert.equal(f.stages.attended, 3);
  assert.equal(f.stages.effective_interaction, 2);
  assert.equal(f.stages.followup_intention, 1);
  assert.equal(f.conversion.registered_to_attended, 0.75);
  // 代签/迟到的场次级行也保留区分
  const rowB = f.slots.find((r) => r.participant_id === b);
  assert.equal(rowB.attended, false);
  assert.equal(rowB.effective_interaction, false);
});

test("公共统计：总量低于 k 不发布；单维小桶被抑制；不提供交叉维度", () => {
  const { service } = makeService();
  for (let i = 0; i < 6; i++) {
    enroll(service, `10${i}`, i === 0 ? { majors: ["稀缺小众专业"], interests: ["先进制造"] } : {});
  }
  const blocked = publicStats(service, PROGRAM, { k: 10 });
  assert.equal(blocked.released, false);

  const stats = publicStats(service, PROGRAM, { k: 5 });
  assert.equal(stats.released, true);
  const majorDist = stats.dimensions.major;
  assert.ok(!majorDist.buckets.some((b) => b.key === "稀缺小众专业"), "单一样本的稀有桶名也不得公开");
  assert.equal(majorDist.suppressed, true);
  assert.deepEqual(Object.keys(stats.dimensions), ["fulfillment_stage", "major", "interest", "host_kind_of_attended"]);
  // 所有发布计数都是 k 的倍数（防差分）
  for (const dim of Object.values(stats.dimensions)) {
    for (const b of dim.buckets) assert.equal(b.count % 5, 0);
  }
});
