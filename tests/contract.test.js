import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

import { validateEvent, validateEventStrict } from "../src/validator.js";
import { AGGREGATE_TYPES, EVENT_TYPES, EVENT_TYPE_NAMES } from "../src/events/catalog.js";

async function loadJson(path) {
  return JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
}

test("旧样例仍符合基础信封约定（向后兼容）", async () => {
  const sample = await loadJson("../data/sample.json");
  assert.deepEqual(validateEvent(sample), []);
});

test("v2 样例通过严格校验", async () => {
  const sample = await loadJson("../data/sample-v2.json");
  assert.deepEqual(validateEventStrict(sample), []);
});

test("schema 枚举、目录枚举与聚合归属三处一致（防漂移）", async () => {
  const schema = await loadJson("../contracts/domain.schema.json");
  assert.deepEqual([...schema.properties.event_type.enum].sort(), [...EVENT_TYPE_NAMES].sort());
  assert.deepEqual([...schema.properties.aggregate_type.enum].sort(), [...AGGREGATE_TYPES].sort());
  for (const name of EVENT_TYPE_NAMES) {
    assert.ok(AGGREGATE_TYPES.includes(EVENT_TYPES[name].aggregate), `${name} 的聚合未登记`);
  }
});

test("data/ 下所有样例都通过严格校验", async () => {
  const files = (await readdir(new URL("../data/", import.meta.url))).filter((f) => f.endsWith(".json"));
  for (const f of files) {
    const sample = await loadJson(`../data/${f}`);
    assert.deepEqual(validateEventStrict(sample), [], `${f} 校验失败`);
  }
});

test("严格校验拒绝：错聚合、缺 payload 必需字段、错类型", () => {
  const base = {
    event_id: "x1", event_type: "SLOT_ACCEPTED", aggregate_type: "itinerary_slot",
    aggregate_id: "s1", occurred_at: "2026-10-04T09:00:00+08:00", version: 1, summary: "x", payload: {},
  };
  assert.ok(validateEventStrict({ ...base, payload: { program_id: "p", participant_id: "a", accepted_at: "t" } }).some((e) => e.includes("date-time")));
  assert.ok(validateEventStrict({ ...base, aggregate_type: "host_commitment" }).some((e) => e.includes("只能属于聚合")));
  assert.ok(validateEventStrict({ ...base, event_type: "NOT_REGISTERED" }).some((e) => e.includes("未登记")));
  assert.deepEqual(validateEventStrict({
    ...base,
    payload: { program_id: "p", participant_id: "a", accepted_at: "2026-10-04T09:00:00+08:00" },
  }), []);
});
