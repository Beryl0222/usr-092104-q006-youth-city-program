import { AGGREGATE_TYPES, EVENT_TYPES } from "./events/catalog.js";

const required = ["event_id", "event_type", "aggregate_type", "aggregate_id", "occurred_at", "version", "summary"];

const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 基础信封校验（保留 v0 行为：缺少字段与 version 合法性）。
 */
export function validateEvent(record) {
  const errors = required.filter((name) => !(name in record)).map((name) => `缺少字段：${name}`);
  if ("version" in record && (!Number.isInteger(record.version) || record.version < 1)) errors.push("version 必须是正整数");
  return errors;
}

function typeOk(value, type) {
  if (value === null || value === undefined) return false;
  if (type === "array") return Array.isArray(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "object") return typeof value === "object" && !Array.isArray(value);
  if (type === "boolean") return typeof value === "boolean";
  if (type === "date-time") return typeof value === "string" && ISO_DATE_TIME.test(value);
  if (type === "date") return typeof value === "string" && ISO_DATE.test(value);
  return typeof value === type;
}

/**
 * 完整校验：信封 + 事件类型登记 + 聚合归属 + payload 必需字段与类型。
 * 跨单位入库前使用；只验证结构，业务规则在命令服务内执行。
 */
export function validateEventStrict(record) {
  const errors = validateEvent(record);
  if (errors.length) return errors;

  const spec = EVENT_TYPES[record.event_type];
  if (!spec) {
    errors.push(`未登记的事件类型：${record.event_type}`);
    return errors;
  }
  if (!AGGREGATE_TYPES.includes(record.aggregate_type)) {
    errors.push(`未知聚合类型：${record.aggregate_type}`);
  }
  if (record.aggregate_type !== spec.aggregate) {
    errors.push(`事件 ${record.event_type} 只能属于聚合 ${spec.aggregate}，实际为 ${record.aggregate_type}`);
  }
  if (typeof record.occurred_at !== "string" || !ISO_DATE_TIME.test(record.occurred_at)) {
    errors.push("occurred_at 必须是 RFC3339 日期时间");
  }

  const payload = record.payload ?? {};
  for (const [field, rule] of Object.entries(spec.payload)) {
    const value = payload[field];
    if (rule.required && (value === undefined || value === null)) {
      errors.push(`payload 缺少必需字段：${field}`);
    } else if (value !== undefined && value !== null && !typeOk(value, rule.type)) {
      errors.push(`payload.${field} 类型应为 ${rule.type}`);
    }
  }
  return errors;
}
