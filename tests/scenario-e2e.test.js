/**
 * 近百人端到端场景（"万名学子宜昌行"秋季一日）。
 * 覆盖：偏好先行、专业匹配、容量占位、临时换车、接待方取消+替代同意/拒绝、
 * 住宿调整、代签拒收、迟到降级、双方确认有效交流、退出保留事实、
 * 有来源就业结果、跨项目重复认领拒绝；最后核对负责人看板、四级漏斗与匿名统计。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { departureBoard, funnel, publicStats } from "../src/backend/read-models.js";
import { DAY, makeService, PROGRAM } from "./helpers/factory.js";

const t9 = ["2026-10-04T09:00:00+08:00", "2026-10-04T11:00:00+08:00"];
const t14 = ["2026-10-04T14:00:00+08:00", "2026-10-04T16:00:00+08:00"];

function pref(major, interest, extra = {}) {
  return {
    school: "三峡大学",
    grade: "大三",
    majors: [major],
    interests: [interest],
    accessibility_needs: extra.needs ?? [],
    available_windows: [{ date: DAY, from: "08:00", to: "18:00" }],
    contact_consent: true,
  };
}

function buildCohort(service) {
  // 96 人：机械40 / 电子20 / 化工15 / 材料5 / 中文10 / 历史6
  const cohorts = [
    ["机械工程", "先进制造", 40, "jx"],
    ["电子信息", "电子信息", 20, "dz"],
    ["化学工程", "新材料", 15, "hg"],
    ["材料科学", "新材料", 5, "cl"],
    ["汉语言文学", "文博策展", 10, "zw"],
    ["历史学", "文博策展", 6, "ls"],
  ];
  const students = [];
  for (const [major, interest, n, code] of cohorts) {
    for (let i = 1; i <= n; i++) {
      const sid = `${code}${String(i).padStart(3, "0")}`;
      const needs = code === "jx" && i === 1 ? ["轮椅通行"] : [];
      const { participant_id } = service.registerParticipant({ program_id: PROGRAM, student_id: sid, name: `学生${sid}`, contact: { phone: `139${i}` } });
      service.confirmPreferences(participant_id, pref(major, interest, { needs }));
      students.push({ id: participant_id, sid, major, interest, needs });
    }
  }
  return students;
}

test("近百人一日履约全流程：断点、四级漏斗、匿名统计与跨项目去重", () => {
  const { service } = makeService();
  const students = buildCohort(service);
  assert.equal(students.length, 96);

  const hosts = {
    e1: service.createHostCommitment({
      program_id: PROGRAM, host_name: "精密制造企业", host_kind: "enterprise",
      wanted_majors: ["机械工程"], interests_served: ["先进制造"], capacity: 30,
      window: { start: `${DAY}T08:00:00+08:00`, end: `${DAY}T18:00:00+08:00` },
      accessibility_support: ["轮椅通行"],
    }).host_id,
    e2: service.createHostCommitment({
      program_id: PROGRAM, host_name: "电子信息企业", host_kind: "enterprise",
      wanted_majors: ["电子信息"], interests_served: ["电子信息"], capacity: 20,
      window: { start: `${DAY}T08:00:00+08:00`, end: `${DAY}T18:00:00+08:00` }, accessibility_support: [],
    }).host_id,
    e3: service.createHostCommitment({
      program_id: PROGRAM, host_name: "化工新材料企业", host_kind: "enterprise",
      wanted_majors: ["化学工程", "材料科学"], interests_served: ["新材料"], capacity: 20,
      window: { start: `${DAY}T08:00:00+08:00`, end: `${DAY}T18:00:00+08:00` }, accessibility_support: [],
    }).host_id,
    m1: service.createHostCommitment({
      program_id: PROGRAM, host_name: "城市博物馆", host_kind: "museum",
      wanted_majors: ["汉语言文学", "历史学"], interests_served: ["文博策展"], capacity: 16,
      window: { start: `${DAY}T08:00:00+08:00`, end: `${DAY}T18:00:00+08:00` }, accessibility_support: [],
    }).host_id,
    t1: service.createHostCommitment({
      program_id: PROGRAM, host_name: "青年人才日", host_kind: "talent_event",
      wanted_majors: [], interests_served: ["先进制造", "文博策展", "电子信息", "新材料"], capacity: 30,
      window: { start: `${DAY}T08:00:00+08:00`, end: `${DAY}T18:00:00+08:00` }, accessibility_support: [],
    }).host_id,
  };

  // 2 人出发前退出
  const withdraw1 = students.find((s) => s.sid === "zw010").id;
  const withdraw2 = students.find((s) => s.sid === "ls006").id;
  service.withdrawParticipant(withdraw1, { reason: "课程答辩" });
  service.withdrawParticipant(withdraw2, { reason: "身体不适" });

  const assign = (student, hostId, [start, end]) => {
    const { slot_id } = service.offerSlot({
      program_id: PROGRAM, host_id: hostId, participant_id: student.id,
      scheduled_start: start, scheduled_end: end,
    });
    service.respondSlot(slot_id, { accept: true });
    return slot_id;
  };

  const placements = new Map(); // studentId -> {host, slot, time}
  const jx = students.filter((s) => s.major === "机械工程");
  const dz = students.filter((s) => s.major === "电子信息");
  const hg = students.filter((s) => s.major === "化学工程");
  const cl = students.filter((s) => s.major === "材料科学");
  const zw = students.filter((s) => s.major === "汉语言文学" && s.id !== withdraw1);
  const ls = students.filter((s) => s.major === "历史学" && s.id !== withdraw2);

  jx.slice(0, 30).forEach((s, i) => placements.set(s.id, { host: hosts.e1, slot: assign(s, hosts.e1, t9) }));
  jx.slice(30).forEach((s) => placements.set(s.id, { host: hosts.t1, slot: assign(s, hosts.t1, t9) })); // 10→实际8? 机械共40
  dz.forEach((s) => placements.set(s.id, { host: hosts.e2, slot: assign(s, hosts.e2, t9) }));
  [...hg, ...cl].forEach((s) => placements.set(s.id, { host: hosts.e3, slot: assign(s, hosts.e3, t9) })); // 20
  [...zw, ...ls].forEach((s) => placements.set(s.id, { host: hosts.m1, slot: assign(s, hosts.m1, t14) })); // 9+5=14

  // 机械40：e1 30 + t1 10；t1 容量30，足够承接后续博物馆替代
  assert.equal(jx.length, 40);

  // 交通：企业线统一大巴；其中 e1 的 3 人遭遇临时换车且形成断点
  for (const s of jx.slice(0, 30)) {
    service.arrangeTransport(placements.get(s.id).slot, {
      mode: "bus", vehicle_ref: "大巴-企业1线", pickup: { at: "宜昌东站", time: t9[0] }, dropoff: { at: "厂区门" }, seats_total: 30,
    });
  }
  for (const s of jx.slice(30)) {
    service.arrangeTransport(placements.get(s.id).slot, {
      mode: "van", vehicle_ref: "商务-人才日", pickup: { at: "宜昌东站" }, dropoff: { at: "人才公寓" }, seats_total: 12,
    });
  }
  for (const s of dz) {
    service.arrangeTransport(placements.get(s.id).slot, {
      mode: "bus", vehicle_ref: "大巴-企业2线", pickup: { at: "宜昌东站" }, dropoff: { at: "园区" }, seats_total: 20,
    });
  }
  for (const s of [...hg, ...cl]) {
    service.arrangeTransport(placements.get(s.id).slot, {
      mode: "bus", vehicle_ref: "大巴-企业3线", pickup: { at: "宜昌东站" }, dropoff: { at: "厂区" }, seats_total: 20,
    });
  }
  // 无障碍学生住宿必须满足需求
  const accessibleStudent = jx[0];
  service.arrangeAccommodation(placements.get(accessibleStudent.id).slot, {
    venue_ref: "青年驿站", room_ref: "101无障碍房", check_in: `${DAY}T07:30:00+08:00`, check_out: `${DAY}T17:30:00+08:00`, accessibility_met: true,
  });
  // 另一人住宿临时调整（酒店水管维修换酒店），形成断点
  const moved = jx[1];
  service.arrangeAccommodation(placements.get(moved.id).slot, {
    venue_ref: "江景酒店", room_ref: "512", check_in: `${DAY}T07:30:00+08:00`, check_out: `${DAY}T17:30:00+08:00`, accessibility_met: true,
  });
  service.recordLogisticsChange(placements.get(moved.id).slot, {
    change_kind: "accommodation", reason: "酒店设备维修，临时改派但新酒店无房",
    before: { venue_ref: "江景酒店" }, after: { venue_ref: "待定" }, broken: true,
  });
  // e1 线 3 人临时换车，小车座位不足，形成断点
  for (const s of jx.slice(2, 5)) {
    service.recordLogisticsChange(placements.get(s.id).slot, {
      change_kind: "transport", reason: "企业1线大巴抛锚，换小车座位不足",
      before: { vehicle_ref: "大巴-企业1线" }, after: { vehicle_ref: "临时小车", seats_total: 1 }, broken: true,
    });
  }

  // 博物馆临时取消：14 个下午场次全部进入断点；组织方提出替代到人才日，10 人同意、4 人拒绝
  const museumStudents = [...zw, ...ls];
  service.cancelHost(hosts.m1, { reason: "展厅临时检修" });
  let replacementsAccepted = 0;
  let replacementsRejected = 0;
  for (const s of museumStudents) {
    const slot = placements.get(s.id).slot;
    service.proposeChange(slot, {
      change_kind: "replacement", reason: "博物馆闭馆，改参访青年人才日",
      proposal: { host_id: hosts.t1, scheduled_start: t14[0], scheduled_end: t14[1] },
    });
    if (replacementsAccepted < 10) {
      service.decideChange(slot, { accept: true });
      placements.set(s.id, { host: hosts.t1, slot, replaced: true });
      replacementsAccepted += 1;
    } else {
      service.decideChange(slot, { accept: false, reason: "只对博物馆方向感兴趣" });
      replacementsRejected += 1;
    }
  }
  assert.equal(replacementsAccepted, 10);
  assert.equal(replacementsRejected, 4);

  // ── 现场签到与有效交流 ─────────────────────────────────────────────────
  const checkIn = (student, iso, method = "self", proxyFor = null) =>
    service.recordCheckin(placements.get(student.id).slot, { check_in_at: iso, method, proxy_for: proxyFor });
  const bothAck = (student, topic = "岗位方向") => {
    const slot = placements.get(student.id).slot;
    service.acknowledgeInteraction(slot, "participant", { topic_refs: [topic] });
    service.acknowledgeInteraction(slot, "host", { topic_refs: [topic] });
  };

  // E1：1 人代签被拒、2 人迟到（到场但不准时）、27 准时；其中 20 人完成双方确认
  checkIn(jx[5], `${DAY}T09:05:00+08:00`, "proxy", jx[5].id); // 代签
  [jx[6], jx[7]].forEach((s, i) => checkIn(s, `${DAY}T09:${30 + i * 10}:00+08:00`)); // 30/40 分钟迟到
  jx.slice(0, 30).filter((s) => ![jx[5], jx[6], jx[7]].includes(s)).forEach((s) => checkIn(s, `${DAY}T09:0${s.sid.slice(-1) % 9}:00+08:00`));
  // 准时且双方交流：取除代签/迟到外 20 人
  jx.slice(8, 28).forEach((s) => bothAck(s, "数控工艺工程师"));

  // E2：20 人全准时，15 人双方确认
  dz.forEach((s, i) => checkIn(s, `${DAY}T09:0${(i % 9) + 1}:00+08:00`));
  dz.slice(0, 15).forEach((s) => bothAck(s, "嵌入式工程师"));

  // E3：1 代签、1 迟到、18 准时；12 人双方确认
  checkIn(hg[0], `${DAY}T09:03:00+08:00`, "proxy", hg[0].id);
  checkIn(hg[1], `${DAY}T09:40:00+08:00`);
  [...hg.slice(2), ...cl].forEach((s, i) => checkIn(s, `${DAY}T09:0${(i % 9) + 1}:00+08:00`));
  [...hg.slice(2, 9), ...cl].forEach((s) => bothAck(s, "材料研发助理")); // 7+5=12

  // T1 上午（机械溢出 10 人）：全准时，8 人双方确认
  jx.slice(30).forEach((s, i) => checkIn(s, `${DAY}T09:0${(i % 9) + 1}:00+08:00`));
  jx.slice(30, 38).forEach((s) => bothAck(s, "装备研发"));

  // 替代到 T1 的 10 人：全准时，6 人双方确认
  museumStudents.slice(0, 10).forEach((s, i) => checkIn(s, `${DAY}T14:0${(i % 9) + 1}:00+08:00`));
  museumStudents.slice(0, 6).forEach((s) => bothAck(s, "策展实习通道"));

  // 迟到者不能被"签到即有效"——任何一方确认都被拒
  assert.throws(() => service.acknowledgeInteraction(placements.get(jx[6].id).slot, "participant"), /迟到/);

  // ── 后续意向与就业结果 ─────────────────────────────────────────────────
  const effectiveThenIntention = [
    ...jx.slice(8, 20), // 12
    ...dz.slice(0, 8), // 8
    ...[...hg.slice(2, 9), ...cl].slice(0, 5), // 5
  ]; // 共 25
  for (const s of effectiveThenIntention) {
    const p = placements.get(s.id);
    service.recordIntention({ program_id: PROGRAM, participant_id: s.id, host_id: p.host, related_slot_id: p.slot });
  }
  // 1 人事后撤回后续联系：旧意向保留，不能再登记新意向
  const revoker = jx[8];
  service.revokeFollowup(revoker.id);
  assert.throws(() => service.recordIntention({
    program_id: PROGRAM, participant_id: revoker.id, host_id: hosts.t1,
  }), /后续联系授权已撤回/);

  // 3 条有来源就业结果，措辞只关联不归因
  const emp1 = service.claimEmployment({
    program_id: PROGRAM, participant_id: jx[9].id, host_id: hosts.e1,
    source_type: "host_hr", source_contact: "精密制造 HR 周主管", evidence_ref: "offer-2026-1201",
    occurred_on: "2026-12-01", related_slot_id: placements.get(jx[9].id).slot,
  });
  assert.equal(emp1.claimed, true);
  const emp2 = service.claimEmployment({
    program_id: PROGRAM, participant_id: dz[0].id, host_id: hosts.e2,
    source_type: "participant_self", source_contact: "学生本人确认（小程序回执 yc-778）", evidence_ref: "self-778",
    occurred_on: "2026-12-05",
  });
  const emp3 = service.claimEmployment({
    program_id: PROGRAM, participant_id: hg[2].id, host_id: hosts.e3,
    source_type: "official_record", source_contact: "市人社局就业登记库 JY-2026-3321", evidence_ref: "jy-3321",
    occurred_on: "2026-12-10",
  });
  assert.equal(emp2.claimed, true);
  assert.equal(emp3.claimed, true);

  // 另一个项目试图把同一个人×同一企业的录用算到自己头上 → 拒绝并留痕
  const dup = service.claimEmployment({
    program_id: "other-project-2026", participant_id: jx[9].id, host_id: hosts.e1,
    source_type: "host_hr", source_contact: "精密制造 HR 周主管", evidence_ref: "offer-2026-1201",
    occurred_on: "2026-12-02",
  });
  assert.equal(dup.claimed, false);
  assert.equal(dup.owner_project, PROGRAM);

  // ── 负责人核对 ─────────────────────────────────────────────────────────
  const board = departureBoard(service, PROGRAM);
  const counts = {};
  for (const b of board.breakpoints) counts[b.kind] = (counts[b.kind] ?? 0) + 1;
  assert.equal(counts.host_cancelled, 4, "4 人拒绝替代，原取消断点保留");
  assert.equal(counts.logistics_broken, 4, "3 个换车断点 + 1 个住宿断点");
  assert.equal(board.hosts_cancelled, 1);
  // 替代接受者的断点已解除（不再计入 host_cancelled）
  assert.equal(board.hosts.find((h) => h.host_id === hosts.m1).cancelled, true);

  const f = funnel(service, PROGRAM);
  assert.equal(f.stages.registered, 96);
  assert.equal(f.withdrawn, 2);
  // 到场：e1 29（含2迟到）+ e2 20 + e3 19（含1迟到）+ t1上午10 + 替代10 = 88
  assert.equal(f.stages.attended, 88, JSON.stringify(f.stages));
  // 准时：27+20+18+10+10 = 85
  assert.equal(f.stages.on_time_attended, 85);
  // 有效交流：20+15+12+8+6 = 61
  assert.equal(f.stages.effective_interaction, 61);
  // 后续意向 25（撤回不抹除已登记意向）
  assert.equal(f.stages.followup_intention, 25);
  assert.equal(f.stages.employment_with_source, 3);
  assert.equal(f.duplicate_claims_rejected, 1);
  // 代签在场次行可见为 rejected，且不计 attended
  const proxyRow = f.slots.find((r) => r.proxy_checkins_rejected > 0 && r.participant_id === jx[5].id);
  assert.ok(proxyRow);
  assert.equal(proxyRow.attended, false);
  // 拒绝替代的 4 人：脱落归因为接待方取消，不算学生爽约
  const rejectedReplacers = f.slots.filter((r) =>
    museumStudents.slice(10).some((s) => s.id === r.participant_id));
  assert.equal(rejectedReplacers.length, 4);
  for (const row of rejectedReplacers) {
    assert.equal(row.attended, false);
    assert.equal(row.dropout_reason, "host_cancelled");
  }

  // 公共统计：k=5 发布，桶内不出现小于 5 的计数，且只有单维
  const stats = publicStats(service, PROGRAM, { k: 5 });
  assert.equal(stats.released, true);
  for (const dim of Object.values(stats.dimensions)) {
    for (const b of dim.buckets) {
      assert.ok(b.count >= 5);
      assert.equal(b.count % 5, 0, "发布计数取整到 k 的倍数");
    }
  }
  assert.deepEqual(Object.keys(stats.dimensions).sort(), ["fulfillment_stage", "host_kind_of_attended", "interest", "major"]);
  // 高阈值下整体拒绝发布
  assert.equal(publicStats(service, PROGRAM, { k: 100 }).released, false);
});
