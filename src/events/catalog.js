/**
 * 领域事件目录：事件类型、所属聚合与负载约束的唯一登记处。
 *
 * 设计约定（跨单位交换边界）：
 * - 事件信封保持 contracts/domain.schema.json 的七字段，业务字段放入 payload。
 * - 事件类型只追加、不复用、不改语义；字段演进用 envelope.version 体现。
 * - 事件描述的是"已经发生的履约事实"，因此不含个人联系方式等易失信息；
 *   个人资料通过带披露目的/有效期的 DISCLOSURE_GRANTED / DISCLOSURE_REVOKED 管理。
 */

export const AGGREGATE_TYPES = [
  "program_participant", // 参与者聚合：报名身份、偏好、同意、退出
  "host_commitment", // 接待方承诺聚合：企业/场馆场次容量与取消
  "itinerary_slot", // 行程场次聚合：具体场次、交通、住宿、签到、有效交流
  "engagement_outcome", // 后续意向与就业结果聚合（按参与者×接待方唯一）
];

/**
 * 每条登记：
 * - aggregate：归属聚合
 * - payload：字段名 -> { required?, type, note }
 * 校验层只做结构校验；业务规则在命令服务中执行。
 */
export const EVENT_TYPES = {
  // ── 既有事件（v0 已登记，保持兼容，补充负载约定）──────────────────────
  PREFERENCE_CONFIRMED: {
    aggregate: "program_participant",
    payload: {
      program_id: { required: true, type: "string", note: "所属项目" },
      student_id: { required: true, type: "string", note: "学生证号/学籍标识（项目内稳定标识）" },
      name: { required: true, type: "string" },
      school: { type: "string", note: "就读院校（接待方现场识别所需，可空）" },
      grade: { type: "string", note: "年级（可空）" },
      majors: { required: true, type: "array", note: "在读专业，用于与岗位需求匹配" },
      interests: { required: true, type: "array", note: "行业/岗位兴趣代码" },
      accessibility_needs: { required: true, type: "array", note: "无障碍需求；空数组表示无特殊需求" },
      available_windows: { required: true, type: "array", note: "可用时段 [{date, from, to}]" },
      contact_consent: { required: true, type: "boolean", note: "是否同意后续联系（可随时撤回）" },
    },
  },
  SLOT_ASSIGNED: {
    aggregate: "itinerary_slot",
    payload: {
      program_id: { required: true, type: "string" },
      host_id: { required: true, type: "string" },
      participant_id: { required: true, type: "string", note: "program_participant 聚合标识" },
      scheduled_start: { required: true, type: "date-time" },
      scheduled_end: { required: true, type: "date-time" },
      basis: { required: true, type: "string", note: "指派依据，例如 兴趣匹配/专业匹配" },
      matched_major: { type: "string", note: "命中的专业（审计：是否把专业合适的人带到企业面前）" },
    },
  },
  ITINERARY_CHANGED: {
    aggregate: "itinerary_slot",
    payload: {
      program_id: { required: true, type: "string" },
      change_kind: { required: true, type: "string", note: "transport | accommodation | host_cancel | time | replacement" },
      reason: { required: true, type: "string" },
      before: { type: "object" },
      after: { type: "object" },
      requires_participant_consent: { required: true, type: "boolean", note: "true 表示必须等待参与者接受才生效" },
      consent_event_id: { type: "string", note: "替代活动同意事件，凭同意回填" },
      broken: { required: true, type: "boolean", note: "是否构成行程断点（如临时换车且无衔接）" },
    },
  },
  ATTENDANCE_VERIFIED: {
    aggregate: "itinerary_slot",
    payload: {
      program_id: { required: true, type: "string" },
      participant_id: { required: true, type: "string" },
      host_id: { required: true, type: "string" },
      check_method: { required: true, type: "string", note: "本人核身方式，如 校园码+人脸" },
      check_in_at: { required: true, type: "date-time" },
      late_minutes: { required: true, type: "integer", note: "相对计划开始的迟到分钟数，0为准时" },
      on_time: { required: true, type: "boolean" },
    },
  },
  OUTCOME_LINKED: {
    aggregate: "engagement_outcome",
    payload: {
      program_id: { required: true, type: "string" },
      participant_id: { required: true, type: "string" },
      host_id: { required: true, type: "string" },
      kind: { required: true, type: "string", note: "intention | employment" },
      source: { type: "string", note: "就业结果必须有来源（联系人/渠道+凭据标识）" },
      evidence_ref: { type: "string", note: "来源凭据引用，不存凭据正文" },
      claim: { required: true, type: "string", note: "只陈述联系事实，禁止声称参访造成录用" },
      related_slot_id: { type: "string", note: "相关场次（关联而非归因）" },
    },
  },

  // ── v2 新增（只追加）──────────────────────────────────────────────────
  PARTICIPANT_REGISTERED: {
    aggregate: "program_participant",
    payload: {
      program_id: { required: true, type: "string" },
      student_id: { required: true, type: "string" },
      name: { required: true, type: "string" },
      contact: { required: true, type: "object", note: "联系方式；仅团市委留存，不随事件分发给接待方" },
      registered_at: { required: true, type: "date-time" },
    },
  },
  PARTICIPANT_WITHDRAWN: {
    aggregate: "program_participant",
    payload: {
      program_id: { required: true, type: "string" },
      reason: { type: "string" },
      withdrew_at: { required: true, type: "date-time" },
      note: { required: true, type: "string", note: "退出只停止后续安排与联系，历史履约事实保留" },
    },
  },
  FOLLOWUP_CONSENT_REVOKED: {
    aggregate: "program_participant",
    payload: {
      program_id: { required: true, type: "string" },
      revoked_at: { required: true, type: "date-time" },
      scope: { required: true, type: "string", note: "all | host:{id}；撤回后续联系授权" },
    },
  },
  HOST_COMMITMENT_CREATED: {
    aggregate: "host_commitment",
    payload: {
      program_id: { required: true, type: "string" },
      host_name: { required: true, type: "string" },
      host_kind: { required: true, type: "string", note: "enterprise | museum | talent_event" },
      wanted_majors: { required: true, type: "array", note: "本场需要的专业" },
      interests_served: { required: true, type: "array" },
      capacity: { required: true, type: "integer", note: "接待容量" },
      window: { required: true, type: "object", note: "{start,end} 接待时段" },
      accessibility_support: { required: true, type: "array", note: "可提供的无障碍支持" },
      created_at: { required: true, type: "date-time" },
    },
  },
  HOST_CANCELLED: {
    aggregate: "host_commitment",
    payload: {
      program_id: { required: true, type: "string" },
      cancelled_at: { required: true, type: "date-time" },
      reason: { required: true, type: "string" },
    },
  },
  SLOT_OFFERED: {
    aggregate: "itinerary_slot",
    payload: {
      program_id: { required: true, type: "string" },
      host_id: { required: true, type: "string" },
      participant_id: { required: true, type: "string" },
      scheduled_start: { required: true, type: "date-time" },
      scheduled_end: { required: true, type: "date-time" },
      matched_major: { type: "string" },
      match_score: { required: true, type: "integer", note: "专业/兴趣匹配分，便于审计" },
      offered_at: { required: true, type: "date-time" },
    },
  },
  SLOT_ACCEPTED: {
    aggregate: "itinerary_slot",
    payload: {
      program_id: { required: true, type: "string" },
      participant_id: { required: true, type: "string" },
      accepted_at: { required: true, type: "date-time" },
    },
  },
  SLOT_DECLINED: {
    aggregate: "itinerary_slot",
    payload: {
      program_id: { required: true, type: "string" },
      participant_id: { required: true, type: "string" },
      declined_at: { required: true, type: "date-time" },
      reason: { type: "string" },
    },
  },
  TRANSPORT_ARRANGED: {
    aggregate: "itinerary_slot",
    payload: {
      program_id: { required: true, type: "string" },
      participant_id: { required: true, type: "string" },
      mode: { required: true, type: "string", note: "bus | van | public_transit | self" },
      vehicle_ref: { type: "string" },
      pickup: { required: true, type: "object", note: "{at, time}" },
      dropoff: { required: true, type: "object" },
      seats_total: { type: "integer" },
    },
  },
  ACCOMMODATION_ARRANGED: {
    aggregate: "itinerary_slot",
    payload: {
      program_id: { required: true, type: "string" },
      participant_id: { required: true, type: "string" },
      venue_ref: { required: true, type: "string" },
      room_ref: { required: true, type: "string" },
      check_in: { required: true, type: "date-time" },
      check_out: { required: true, type: "date-time" },
      accessibility_met: { required: true, type: "boolean", note: "是否满足已确认的无障碍需求" },
    },
  },
  CHANGE_CONSENT_REQUESTED: {
    aggregate: "itinerary_slot",
    payload: {
      program_id: { required: true, type: "string" },
      participant_id: { required: true, type: "string" },
      change_kind: { required: true, type: "string", note: "replacement | transport | accommodation | time" },
      proposal: { required: true, type: "object", note: "拟调整内容" },
      requested_at: { required: true, type: "date-time" },
    },
  },
  CHANGE_CONSENT_DECIDED: {
    aggregate: "itinerary_slot",
    payload: {
      program_id: { required: true, type: "string" },
      participant_id: { required: true, type: "string" },
      decision: { required: true, type: "string", note: "accepted | rejected" },
      decided_at: { required: true, type: "date-time" },
    },
  },
  CHECKIN_RECORDED: {
    aggregate: "itinerary_slot",
    payload: {
      program_id: { required: true, type: "string" },
      participant_id: { required: true, type: "string" },
      host_id: { required: true, type: "string" },
      check_in_at: { required: true, type: "date-time" },
      late_minutes: { required: true, type: "integer" },
      method: { required: true, type: "string", note: "self | proxy | staff" },
      proxy_for: { type: "string", note: "代签时被代签的参与者" },
    },
  },
  PROXY_CHECKIN_REJECTED: {
    aggregate: "itinerary_slot",
    payload: {
      program_id: { required: true, type: "string" },
      rejected_checkin_event_id: { required: true, type: "string" },
      reason: { required: true, type: "string" },
      rejected_at: { required: true, type: "date-time" },
    },
  },
  INTERACTION_ACKNOWLEDGED: {
    aggregate: "itinerary_slot",
    payload: {
      program_id: { required: true, type: "string" },
      participant_id: { required: true, type: "string" },
      host_id: { required: true, type: "string" },
      by_party: { required: true, type: "string", note: "participant | host；双方都确认才构成有效交流" },
      acknowledged_at: { required: true, type: "date-time" },
      topic_refs: { type: "array", note: "实际交流涉及的岗位/项目" },
    },
  },
  LATE_INTERACTION_REVIEWED: {
    aggregate: "itinerary_slot",
    payload: {
      program_id: { required: true, type: "string" },
      participant_id: { required: true, type: "string" },
      reviewer: { required: true, type: "string", note: "人工复核负责人" },
      reviewed_at: { required: true, type: "date-time" },
      conclusion: { required: true, type: "string", note: "effective | ineffective：迟到交流不能自动有效，须人工复核" },
      note: { type: "string" },
    },
  },
  DISCLOSURE_GRANTED: {
    aggregate: "program_participant",
    payload: {
      program_id: { required: true, type: "string" },
      host_id: { required: true, type: "string", note: "接收方：仅本场接待方" },
      slot_id: { required: true, type: "string", note: "限定场次：完成本场活动所需" },
      fields: { required: true, type: "array", note: "最小字段集，如 姓名/学校/专业/无障碍现场支持需求" },
      purpose: { required: true, type: "string" },
      expires_at: { required: true, type: "date-time", note: "披露有效期，场后自动失效" },
      granted_at: { required:true, type: "date-time" },
    },
  },
  DISCLOSURE_REVOKED: {
    aggregate: "program_participant",
    payload: {
      program_id: { required: true, type: "string" },
      host_id: { required: true, type: "string" },
      slot_id: { required: true, type: "string" },
      revoked_at: { required: true, type: "date-time" },
    },
  },
  EMPLOYMENT_RESULT_CLAIMED: {
    aggregate: "engagement_outcome",
    payload: {
      program_id: { required: true, type: "string" },
      participant_id: { required: true, type: "string" },
      host_id: { required: true, type: "string" },
      source_type: { required: true, type: "string", note: "host_hr | participant_self | official_record" },
      source_contact: { required: true, type: "string", note: "有来源的联系（人/渠道），无来源不得登记" },
      evidence_ref: { required: true, type: "string" },
      occurred_on: { required: true, type: "date" },
      related_slot_id: { type: "string" },
      statement: { required: true, type: "string", note: "措辞限定为'存在来源联系'，不得声称一次参访造成录用" },
      claimed_at: { required: true, type: "date-time" },
    },
  },
  DUPLICATE_CLAIM_REJECTED: {
    aggregate: "engagement_outcome",
    payload: {
      program_id: { required: true, type: "string" },
      participant_id: { required: true, type: "string" },
      host_id: { required: true, type: "string" },
      rejected_kind: { required: true, type: "string", note: "intention | employment" },
      claimed_by_project_id: { required: true, type: "string", note: "重复认领的其他项目" },
      rejected_at: { required: true, type: "date-time" },
    },
  },
};

export const EVENT_TYPE_NAMES = Object.keys(EVENT_TYPES);
