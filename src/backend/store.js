/**
 * 事件存储：按聚合流追加，单流版本号乐观并发，跨流批次原子提交。
 * 跨单位数据全部表现为 src/events/catalog.js 登记的领域事件；
 * 本实现为进程内存储，append 时执行严格结构校验，并可挂载 JSONL 日志做持久化。
 */
import { appendFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { validateEventStrict } from "../validator.js";

export class ConcurrencyError extends Error {
  constructor(streamId, expected, actual) {
    super(`聚合流 ${streamId} 版本冲突：期望 ${expected}，实际 ${actual}`);
    this.code = "CONCURRENCY";
    this.expected = expected;
    this.actual = actual;
  }
}

export class EventValidationError extends Error {
  constructor(eventId, errors) {
    super(`事件 ${eventId} 校验未通过：${errors.join("；")}`);
    this.code = "EVENT_INVALID";
    this.errors = errors;
  }
}

export class EventStore {
  #streams = new Map();
  #eventIds = new Set();
  #listeners = new Set();
  #journalPath = null;

  constructor({ journalPath = null } = {}) {
    this.#journalPath = journalPath;
  }

  /** 追加一个跨流原子批次。expectedVersion：-1 表示流必须不存在；undefined 表示不检查。 */
  append(entries) {
    if (!Array.isArray(entries) || entries.length === 0) throw new Error("追加批次不能为空");

    // 先在影子副本上完成全部校验，任何一条失败则整批不写入（原子性）。
    const committed = [];
    for (const entry of entries) {
      const { streamId, event, expectedVersion } = entry;
      const errors = validateEventStrict(event);
      if (errors.length) throw new EventValidationError(event.event_id, errors);

      const stream = this.#streams.get(streamId) ?? { events: [] };
      const actual = stream.events.length;
      if (expectedVersion !== undefined && expectedVersion !== actual) {
        throw new ConcurrencyError(streamId, expectedVersion, actual);
      }
      if (this.#eventIds.has(event.event_id)) {
        throw new Error(`事件 ID 重复：${event.event_id}`);
      }
      if (event.version !== actual + 1) {
        throw new Error(`事件 ${event.event_id} 版本号应为 ${actual + 1}，实际 ${event.version}`);
      }
      committed.push({ streamId, event, stream });
    }

    for (const { streamId, event, stream } of committed) {
      stream.events.push(event);
      this.#streams.set(streamId, stream);
      this.#eventIds.add(event.event_id);
      for (const listener of this.#listeners) listener(event, streamId);
    }
    if (this.#journalPath) {
      const line = JSON.stringify({ at: new Date().toISOString(), entries: committed.map((c) => ({ streamId: c.streamId, event: c.event })) }) + "\n";
      // 日志写入失败不回滚内存状态；持久化部署应将存储替换为事务型日志实现。
      appendFile(this.#journalPath, line).catch(() => {});
    }
    return committed.map((c) => c.event);
  }

  getStream(streamId) {
    return (this.#streams.get(streamId)?.events ?? []).map((e) => ({ ...e, payload: structuredClone(e.payload) }));
  }

  streamVersion(streamId) {
    return this.#streams.get(streamId)?.events.length ?? 0;
  }

  allEvents() {
    const out = [];
    for (const stream of this.#streams.values()) out.push(...stream.events);
    return out.sort((a, b) => (a.occurred_at < b.occurred_at ? -1 : a.occurred_at > b.occurred_at ? 1 : 0));
  }

  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** 从 JSONL 日志恢复（每行一个批次）。 */
  async loadJournal() {
    if (!this.#journalPath || !existsSync(this.#journalPath)) return;
    const text = await readFile(this.#journalPath, "utf8");
    for (const line of text.split("\n").filter(Boolean)) {
      const batch = JSON.parse(line);
      for (const { streamId, event } of batch.entries) {
        const stream = this.#streams.get(streamId) ?? { events: [] };
        stream.events.push(event);
        this.#streams.set(streamId, stream);
        this.#eventIds.add(event.event_id);
      }
    }
  }
}
