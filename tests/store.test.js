import assert from "node:assert/strict";
import test from "node:test";

import { EventStore, ConcurrencyError, EventValidationError } from "../src/backend/store.js";

function evt(overrides = {}) {
  return {
    event_id: overrides.event_id ?? "e1",
    event_type: "SLOT_ACCEPTED",
    aggregate_type: "itinerary_slot",
    aggregate_id: "slot-1",
    occurred_at: "2026-10-04T09:00:00+08:00",
    version: 1,
    summary: "x",
    payload: { program_id: "p", participant_id: "a", accepted_at: "2026-10-04T09:00:00+08:00" },
    ...overrides,
  };
}

test("版本号必须从1连续递增", () => {
  const store = new EventStore();
  assert.throws(() => store.append([{ streamId: "s", event: evt({ version: 2 }), expectedVersion: 0 }]), /版本号应为 1/);
  store.append([{ streamId: "s", event: evt(), expectedVersion: 0 }]);
  assert.throws(() => store.append([{ streamId: "s", event: evt({ event_id: "e2", version: 2 }), expectedVersion: 0 }]), ConcurrencyError);
  store.append([{ streamId: "s", event: evt({ event_id: "e2", version: 2 }), expectedVersion: 1 }]);
  assert.equal(store.streamVersion("s"), 2);
});

test("跨流批次原子提交：任一条校验失败则整批不写入", () => {
  const store = new EventStore();
  const good = evt({ event_id: "a1", aggregate_id: "slot-1" });
  const bad = evt({
    event_id: "b1", aggregate_id: "slot-2", event_type: "SLOT_OFFERED",
    payload: { program_id: "p" }, // 缺多个必需字段
  });
  assert.throws(() => store.append([
    { streamId: "slot-1", event: good, expectedVersion: 0 },
    { streamId: "slot-2", event: bad, expectedVersion: 0 },
  ]), EventValidationError);
  assert.equal(store.streamVersion("slot-1"), 0, "失败批次不得部分写入");
  assert.equal(store.streamVersion("slot-2"), 0);
});

test("事件 ID 全流唯一", () => {
  const store = new EventStore();
  store.append([{ streamId: "s1", event: evt({ event_id: "dup" }), expectedVersion: 0 }]);
  assert.throws(() => store.append([{
    streamId: "s2",
    event: evt({ event_id: "dup", aggregate_id: "slot-2" }),
    expectedVersion: 0,
  }]), /事件 ID 重复/);
});

test("事件只追加：已有事件内容不可变", async () => {
  const { service, store } = await import("./helpers/factory.js").then(async (m) => {
    const f = m.makeService();
    const pid = f.service.registerParticipant({ program_id: "p", student_id: "9", name: "王" });
    f.service.withdrawParticipant(pid.participant_id, { reason: "个人原因" });
    return { service: f.service, store: f.store };
  });
  const events = store.getStream("participant:p:9");
  assert.equal(events[0].event_type, "PARTICIPANT_REGISTERED");
  // 流外修改拿到的副本不得影响存储
  events[0].summary = "hacked";
  assert.notEqual(store.getStream("participant:p:9")[0].summary, "hacked");
  void service;
});
