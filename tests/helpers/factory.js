/** 测试工厂：可控时钟、顺序 ID、预置数据的履约服务。 */
import { FulfillmentService } from "../../src/backend/service.js";
import { EventStore } from "../../src/backend/store.js";

export function makeService({ start = "2026-10-01T08:00:00.000+08:00" } = {}) {
  let t = new Date(start).getTime();
  const clock = { now: () => new Date(t), advance: (ms) => { t += ms; return new Date(t); }, set: (iso) => { t = new Date(iso).getTime(); } };
  let seq = 0;
  const store = new EventStore();
  const service = new FulfillmentService({ store, now: clock.now, id: () => `evt-${String(++seq).padStart(5, "0")}` });
  return { service, clock, seq, store };
}

export const PROGRAM = "wmyc-2026-autumn";
export const DAY = "2026-10-04";

export function studentPref(overrides = {}) {
  return {
    school: "三峡大学",
    grade: "大三",
    majors: ["机械工程"],
    interests: ["先进制造"],
    accessibility_needs: [],
    available_windows: [{ date: DAY, from: "08:00", to: "18:00" }],
    contact_consent: true,
    ...overrides,
  };
}

/** 注册并确认偏好，返回 participant_id。 */
export function enroll(service, studentId, prefOverrides = {}, program = PROGRAM, nameOverrides = {}) {
  const name = nameOverrides.name ?? `学生${studentId}`;
  const { participant_id } = service.registerParticipant({
    program_id: program, student_id: studentId, name,
    contact: { phone: `139${String(studentId).padStart(8, "0")}` },
  });
  service.confirmPreferences(participant_id, studentPref(prefOverrides));
  return participant_id;
}

export function standardHost(service, overrides = {}) {
  return service.createHostCommitment({
    program_id: PROGRAM,
    host_name: "某接待单位",
    host_kind: "enterprise",
    wanted_majors: ["机械工程"],
    interests_served: ["先进制造"],
    capacity: 10,
    window: { start: `${DAY}T08:00:00+08:00`, end: `${DAY}T18:00:00+08:00` },
    accessibility_support: ["轮椅通行"],
    ...overrides,
  }).host_id;
}

export function slotTime(h = 9, m = 0, dur = 120) {
  const start = new Date(`${DAY}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00+08:00`);
  const end = new Date(start.getTime() + dur * 60000);
  return { scheduled_start: start.toISOString(), scheduled_end: end.toISOString() };
}

export function offerAndAccept(service, participantId, hostId, overrides = {}) {
  const { scheduled_start, scheduled_end } = slotTime();
  const { slot_id } = service.offerSlot({
    program_id: PROGRAM, host_id: hostId, participant_id: participantId,
    scheduled_start, scheduled_end, ...overrides,
  });
  service.respondSlot(slot_id, { accept: true });
  return slot_id;
}

export function expectError(code, fn) {
  try {
    fn();
    throw new Error(`期望抛出 ${code}，但未抛错`);
  } catch (e) {
    if (e.code !== code) throw new Error(`期望错误 ${code}，实际 ${e.code}：${e.message}`);
  }
}

export async function expectErrorAsync(code, fn) {
  try {
    await fn();
    throw new Error(`期望抛出 ${code}，但未抛错`);
  } catch (e) {
    if (e.code !== code) throw new Error(`期望错误 ${code}，实际 ${e.code}：${e.message}`);
  }
}
