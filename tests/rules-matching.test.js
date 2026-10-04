import assert from "node:assert/strict";
import test from "node:test";

import { DAY, enroll, expectError, makeService, offerAndAccept, PROGRAM, slotTime, standardHost } from "./helpers/factory.js";

test("未确认兴趣/无障碍/可用时段，不能安排具体场次", () => {
  const { service } = makeService();
  const { participant_id } = service.registerParticipant({ program_id: PROGRAM, student_id: "1", name: "学生1" });
  const hostId = standardHost(service);
  const { scheduled_start, scheduled_end } = slotTime();
  expectError("PREFERENCE_NOT_CONFIRMED", () => service.offerSlot({
    program_id: PROGRAM, host_id: hostId, participant_id, scheduled_start, scheduled_end,
  }));
});

test("场次必须落在学生确认的可用时段内", () => {
  const { service } = makeService();
  const pid = enroll(service, "2", { available_windows: [{ date: DAY, from: "14:00", to: "18:00" }] });
  const hostId = standardHost(service);
  const { scheduled_start, scheduled_end } = slotTime(9, 0);
  expectError("OUTSIDE_AVAILABILITY", () => service.offerSlot({
    program_id: PROGRAM, host_id: hostId, participant_id: pid, scheduled_start, scheduled_end,
  }));
  // 下午窗口内可以
  const ok = slotTime(14, 30);
  const { slot_id } = service.offerSlot({ program_id: PROGRAM, host_id: hostId, participant_id: pid, ...ok });
  service.respondSlot(slot_id, { accept: true });
});

test("同一参与者时间冲突的场次不能重复安排", () => {
  const { service } = makeService();
  const pid = enroll(service, "3");
  const hostId = standardHost(service);
  offerAndAccept(service, pid, hostId);
  const { scheduled_start, scheduled_end } = slotTime(10, 0);
  expectError("SLOT_OVERLAP", () => service.offerSlot({
    program_id: PROGRAM, host_id: hostId, participant_id: pid, scheduled_start, scheduled_end,
  }));
});

test("专业与兴趣均不匹配时静默指派被拒；显式审批可放行并留痕", () => {
  const { service } = makeService();
  const pid = enroll(service, "4", { majors: ["汉语言文学"], interests: ["文博策展"] });
  const hostId = standardHost(service); // 只要机械工程/先进制造
  const t = slotTime();
  expectError("NO_MATCH", () => service.offerSlot({ program_id: PROGRAM, host_id: hostId, participant_id: pid, ...t }));
  const { slot_id } = service.offerSlot({
    program_id: PROGRAM, host_id: hostId, participant_id: pid, ...t,
    allow_mismatch: true, mismatch_reason: "学生主动要求跨专业体验",
  });
  assert(slot_id, "显式不匹配审批应放行");
});

test("接待方不具备所需无障碍支持时不能安排", () => {
  const { service } = makeService();
  const pid = enroll(service, "5", { accessibility_needs: ["手语翻译"] });
  const hostId = standardHost(service, { accessibility_support: ["轮椅通行"] });
  const t = slotTime();
  expectError("ACCESSIBILITY_UNSUPPORTED", () => service.offerSlot({
    program_id: PROGRAM, host_id: hostId, participant_id: pid, ...t,
  }));
});

test("容量满时邀约被拒；邀约即占位（未接受也占容量）", () => {
  const { service } = makeService();
  const hostId = standardHost(service, { capacity: 2 });
  const p1 = enroll(service, "6");
  const p2 = enroll(service, "7");
  const p3 = enroll(service, "8");
  const t = slotTime();
  service.offerSlot({ program_id: PROGRAM, host_id: hostId, participant_id: p1, ...t }); // offered，占1
  const o2 = service.offerSlot({ program_id: PROGRAM, host_id: hostId, participant_id: p2, ...slotTime(13, 0) });
  service.respondSlot(o2.slot_id, { accept: true });
  expectError("HOST_FULL", () => service.offerSlot({
    program_id: PROGRAM, host_id: hostId, participant_id: p3, ...slotTime(15, 0),
  }));
  // 拒绝后释放容量
  // p1 仍为 offered；构造一个拒绝释放的场景：新参与者只有在有空位时才能约
});

test("拒绝场次释放接待容量", () => {
  const { service } = makeService();
  const hostId = standardHost(service, { capacity: 1 });
  const p1 = enroll(service, "10");
  const p2 = enroll(service, "11");
  const t = slotTime();
  const o1 = service.offerSlot({ program_id: PROGRAM, host_id: hostId, participant_id: p1, ...t });
  expectError("HOST_FULL", () => service.offerSlot({ program_id: PROGRAM, host_id: hostId, participant_id: p2, ...slotTime(13, 0) }));
  service.respondSlot(o1.slot_id, { accept: false, reason: "时间不合适" });
  service.offerSlot({ program_id: PROGRAM, host_id: hostId, participant_id: p2, ...slotTime(13, 0) });
});

test("交通与住宿只能在参与者接受场次之后安排", () => {
  const { service } = makeService();
  const pid = enroll(service, "12");
  const hostId = standardHost(service);
  const t = slotTime();
  const { slot_id } = service.offerSlot({ program_id: PROGRAM, host_id: hostId, participant_id: pid, ...t });
  expectError("SLOT_NOT_ACCEPTED", () => service.arrangeTransport(slot_id, {
    mode: "bus", pickup: { at: "东门" }, dropoff: { at: "厂区" },
  }));
  service.respondSlot(slot_id, { accept: true });
  service.arrangeTransport(slot_id, {
    mode: "bus", vehicle_ref: "大巴1号", pickup: { at: "东门" }, dropoff: { at: "厂区" }, seats_total: 40,
  });
});

test("住宿安排必须满足已确认的无障碍需求", () => {
  const { service } = makeService();
  const pid = enroll(service, "13", { accessibility_needs: ["轮椅通行"] });
  const hostId = standardHost(service);
  const slotId = offerAndAccept(service, pid, hostId);
  expectError("ACCESSIBILITY_UNMET", () => service.arrangeAccommodation(slotId, {
    venue_ref: "青年驿站", room_ref: "302", check_in: `${DAY}T08:00:00+08:00`, check_out: `${DAY}T18:00:00+08:00`,
    accessibility_met: false,
  }));
  service.arrangeAccommodation(slotId, {
    venue_ref: "青年驿站", room_ref: "101无障碍房", check_in: `${DAY}T08:00:00+08:00`, check_out: `${DAY}T18:00:00+08:00`,
    accessibility_met: true,
  });
});
