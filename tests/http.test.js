import assert from "node:assert/strict";
import test from "node:test";

import { FulfillmentService } from "../src/backend/service.js";
import { createApp } from "../src/backend/http.js";

async function withServer(run) {
  const service = new FulfillmentService();
  const server = createApp(service);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  try {
    await run({ base, service });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function req(base, method, path, { role, actor, body } = {}) {
  return fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(role ? { "x-role": role } : {}), ...(actor ? { "x-actor-id": actor } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ status: r.status, json: await r.json() }));
}

test("完整链路：报名→偏好→接待承诺→邀约（学生接受）→交通→签到→双方确认→意向", async () => {
  await withServer(async ({ base }) => {
    const reg = await req(base, "POST", "/participants", {
      role: "organizer",
      body: { program_id: "p", student_id: "1", name: "学生1", contact: { phone: "139" } },
    });
    assert.equal(reg.status, 200);
    const pid = reg.json.participant_id;

    const pref = await req(base, "POST", `/participants/${encodeURIComponent(pid)}/preferences`, {
      role: "organizer",
      body: {
        school: "三峡大学", majors: ["机械工程"], interests: [],
        available_windows: [{ date: "2026-10-04", from: "08:00", to: "18:00" }], contact_consent: true,
      },
    });
    assert.equal(pref.status, 200, JSON.stringify(pref.json));

    const host = await req(base, "POST", "/hosts", {
      role: "organizer",
      body: {
        program_id: "p", host_name: "甲企业", host_kind: "enterprise", wanted_majors: ["机械工程"],
        interests_served: [], capacity: 5, window: { start: "2026-10-04T08:00:00+08:00", end: "2026-10-04T18:00:00+08:00" },
      },
    });
    assert.equal(host.status, 200);
    const hostId = host.json.host_id;

    const offer = await req(base, "POST", "/slots/offer", {
      role: "organizer",
      body: {
        program_id: "p", host_id: hostId, participant_id: pid,
        scheduled_start: "2026-10-04T09:00:00+08:00", scheduled_end: "2026-10-04T11:00:00+08:00",
      },
    });
    assert.equal(offer.status, 200, JSON.stringify(offer.json));
    const slotId = offer.json.slot_id;

    // 学生本人可以接受；别的学生不能替他接受
    const other = await req(base, "POST", `/slots/${encodeURIComponent(slotId)}/respond`, {
      role: "participant", actor: "participant:p:999", body: { accept: true },
    });
    assert.equal(other.status, 403);
    const accept = await req(base, "POST", `/slots/${encodeURIComponent(slotId)}/respond`, {
      role: "participant", actor: pid, body: { accept: true },
    });
    assert.equal(accept.status, 200);

    const transport = await req(base, "POST", `/slots/${encodeURIComponent(slotId)}/transport`, {
      role: "organizer",
      body: { mode: "bus", vehicle_ref: "1号车", pickup: { at: "东站" }, dropoff: { at: "厂区" }, seats_total: 40 },
    });
    assert.equal(transport.status, 200);

    const checkin = await req(base, "POST", `/slots/${encodeURIComponent(slotId)}/checkin`, {
      role: "organizer",
      body: { check_in_at: "2026-10-04T09:03:00+08:00" },
    });
    assert.equal(checkin.status, 200);
    assert.equal(checkin.json.attended, true);

    // 代签：服务端接收原始记录后立即拒收，HTTP 仍 200，但 attended=false
    const proxy = await req(base, "POST", `/slots/${encodeURIComponent(slotId)}/checkin`, {
      role: "organizer", body: { method: "proxy" },
    });
    assert.equal(proxy.status, 200);
    assert.equal(proxy.json.attended, false);
    assert.equal(proxy.json.reason, "proxy_rejected");

    const ackP = await req(base, "POST", `/slots/${encodeURIComponent(slotId)}/acknowledge`, {
      role: "participant", actor: pid, body: { by_party: "participant" },
    });
    assert.equal(ackP.status, 200);
    // 学生身份不能冒充接待方确认
    const ackWrong = await req(base, "POST", `/slots/${encodeURIComponent(slotId)}/acknowledge`, {
      role: "participant", actor: pid, body: { by_party: "host" },
    });
    assert.equal(ackWrong.status, 403);
    const ackH = await req(base, "POST", `/slots/${encodeURIComponent(slotId)}/acknowledge`, {
      role: "host", actor: hostId, body: { by_party: "host", topic_refs: ["岗位"] },
    });
    assert.equal(ackH.status, 200);
    assert.equal(ackH.json.effective_interaction, true);

    const intention = await req(base, "POST", "/outcomes/intention", {
      role: "organizer",
      body: { program_id: "p", participant_id: pid, host_id: hostId, related_slot_id: slotId },
    });
    assert.equal(intention.status, 200);

    const funnel = await req(base, "GET", "/programs/p/funnel", { role: "organizer" });
    assert.equal(funnel.status, 200);
    assert.equal(funnel.json.stages.effective_interaction, 1);
  });
});

test("授权：学生不能登记接待方/安排交通/查看看板；接待方只能领自己的资料包", async () => {
  await withServer(async ({ base }) => {
    assert.equal((await req(base, "POST", "/hosts", { role: "participant", actor: "x", body: {} })).status, 403);
    assert.equal((await req(base, "GET", "/programs/p/departure-board", { role: "participant" })).status, 403);
    assert.equal((await req(base, "GET", "/programs/p/funnel", { role: "host", actor: "h1" })).status, 403);
    // 公共统计对各角色开放（发布即匿名）
    assert.equal((await req(base, "GET", "/programs/p/public-stats", { role: "host" })).status, 200);
    // 无披露授权时接待方资料包 422
    const packet = await req(base, "GET", "/hosts/h1/packet?slot_id=slot-x", { role: "host", actor: "h1" });
    assert.equal(packet.status, 422);
    // 接待方不能领别人的包（路径接待方与身份不一致，直接 403）
    const otherHost = await req(base, "GET", "/hosts/h2/packet?slot_id=slot-x", { role: "host", actor: "h1" });
    assert.equal(otherHost.status, 403);
  });
});

test("业务错误码映射：未确认偏好就邀约返回 422 且不产生事件", async () => {
  await withServer(async ({ base, service }) => {
    await req(base, "POST", "/participants", { role: "organizer", body: { program_id: "p", student_id: "7", name: "学生7" } });
    const host = await req(base, "POST", "/hosts", {
      role: "organizer",
      body: {
        program_id: "p", host_name: "h", host_kind: "enterprise", wanted_majors: [], interests_served: [],
        capacity: 3, window: { start: "2026-10-04T08:00:00+08:00", end: "2026-10-04T18:00:00+08:00" },
      },
    });
    const offer = await req(base, "POST", "/slots/offer", {
      role: "organizer",
      body: {
        program_id: "p", host_id: host.json.host_id, participant_id: "participant:p:7",
        scheduled_start: "2026-10-04T09:00:00+08:00", scheduled_end: "2026-10-04T11:00:00+08:00",
      },
    });
    assert.equal(offer.status, 422);
    assert.equal(offer.json.error, "PREFERENCE_NOT_CONFIRMED");
    assert.equal(service.store.allEvents().filter((e) => e.event_type === "SLOT_OFFERED").length, 0);
  });
});
