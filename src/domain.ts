/**
 * 领域事件信封与履约模型类型。
 * 事件类型与负载字段的唯一登记处是 src/events/catalog.js（运行时），
 * 此处提供编译期形状；二者漂移由 tests/contract.test.js 兜底。
 */

/** 跨单位领域事件信封（七字段，与 contracts/domain.schema.json 一致）。 */
export interface DomainEvent<TPayload = Record<string, unknown>> {
  event_id: string;
  event_type: string;
  aggregate_type: AggregateType;
  aggregate_id: string;
  occurred_at: string;
  /** 聚合流内单调版本号，从 1 开始。 */
  version: number;
  summary: string;
  payload: TPayload;
}

export type AggregateType = "program_participant" | "host_commitment" | "itinerary_slot" | "engagement_outcome";

// ── 参与者侧 ──────────────────────────────────────────────────────────────

export interface TimeWindow {
  date: string;
  from: string;
  to: string;
}

export interface ContactInfo {
  phone?: string;
  email?: string;
  /** 其他联系方式只用于团市委内部组织，不进入对接待方的披露包。 */
  [key: string]: unknown;
}

export interface PreferenceConfirmation {
  program_id: string;
  student_id: string;
  name: string;
  majors: string[];
  interests: string[];
  accessibility_needs: string[];
  available_windows: TimeWindow[];
  contact_consent: boolean;
}

// ── 行程侧 ────────────────────────────────────────────────────────────────

export type ChangeKind = "transport" | "accommodation" | "host_cancel" | "time" | "replacement";

export interface ItineraryChange {
  change_kind: ChangeKind;
  reason: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  requires_participant_consent: boolean;
  consent_event_id?: string;
  broken: boolean;
}

export type CheckinMethod = "self" | "proxy" | "staff";

/** 签到事实（原始记录）。 */
export interface CheckinRecord {
  check_in_at: string;
  late_minutes: number;
  method: CheckinMethod;
  proxy_for?: string;
}

// ── 履约结果分级（活动后漏斗）──────────────────────────────────────────────

/** 报名 → 到场 → 有效交流 → 后续意向，四级互不等同。 */
export type FulfillmentStage = "registered" | "attended" | "effective_interaction" | "followup_intention";

// ── 最小披露 ──────────────────────────────────────────────────────────────

export interface DisclosureGrant {
  host_id: string;
  slot_id: string;
  fields: string[];
  purpose: string;
  expires_at: string;
  revoked: boolean;
}

// ── 就业结果 ──────────────────────────────────────────────────────────────

export type EmploymentSourceType = "host_hr" | "participant_self" | "official_record";

export interface EmploymentResult {
  host_id: string;
  source_type: EmploymentSourceType;
  /** 有来源的联系：HR 联系人/本人确认渠道/官方记录编号。 */
  source_contact: string;
  evidence_ref: string;
  occurred_on: string;
  related_slot_id?: string;
  /** 陈述措辞限定为"存在来源联系"，不得声称一次参访造成录用。 */
  statement: string;
  claimed_by_project_id: string;
}
