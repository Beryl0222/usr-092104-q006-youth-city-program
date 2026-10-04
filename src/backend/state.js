/**
 * 聚合还原：把事件流折叠为当前状态。全部为纯函数，便于测试与重建读模型。
 */

function foldParticipant(events) {
  const s = {
    id: null,
    program_id: null,
    student_id: null,
    name: null,
    contact: null,
    registered: false,
    registered_at: null,
    preferences: null,
    withdrawn: false,
    withdrew_at: null,
    followup_consent: true,
    followup_revoked_scope: null,
    disclosures: [], // 针对接待方的最小披露授权
  };
  for (const e of events) {
    const p = e.payload ?? {};
    switch (e.event_type) {
      case "PARTICIPANT_REGISTERED":
        s.id = e.aggregate_id;
        s.program_id = p.program_id;
        s.student_id = p.student_id;
        s.name = p.name;
        s.contact = p.contact;
        s.registered = true;
        s.registered_at = p.registered_at;
        break;
      case "PREFERENCE_CONFIRMED":
        s.preferences = {
          school: p.school ?? null,
          grade: p.grade ?? null,
          majors: p.majors,
          interests: p.interests,
          accessibility_needs: p.accessibility_needs,
          available_windows: p.available_windows,
          confirmed_at: e.occurred_at,
        };
        s.followup_consent = p.contact_consent;
        break;
      case "PARTICIPANT_WITHDRAWN":
        s.withdrawn = true;
        s.withdrew_at = p.withdrew_at;
        break;
      case "FOLLOWUP_CONSENT_REVOKED":
        s.followup_consent = false;
        s.followup_revoked_scope = p.scope;
        break;
      case "DISCLOSURE_GRANTED":
        s.disclosures = [
          ...s.disclosures.filter((d) => !(d.host_id === p.host_id && d.slot_id === p.slot_id)),
          { host_id: p.host_id, slot_id: p.slot_id, fields: p.fields, purpose: p.purpose, expires_at: p.expires_at, granted_at: p.granted_at, revoked: false },
        ];
        break;
      case "DISCLOSURE_REVOKED":
        s.disclosures = s.disclosures.map((d) => (d.host_id === p.host_id && d.slot_id === p.slot_id ? { ...d, revoked: true } : d));
        break;
    }
  }
  return s;
}

function foldHost(events) {
  const s = {
    id: null,
    program_id: null,
    host_name: null,
    host_kind: null,
    wanted_majors: [],
    interests_served: [],
    capacity: 0,
    window: null,
    accessibility_support: [],
    cancelled: false,
    cancelled_at: null,
  };
  for (const e of events) {
    const p = e.payload ?? {};
    switch (e.event_type) {
      case "HOST_COMMITMENT_CREATED":
        Object.assign(s, {
          id: e.aggregate_id,
          program_id: p.program_id,
          host_name: p.host_name,
          host_kind: p.host_kind,
          wanted_majors: p.wanted_majors,
          interests_served: p.interests_served,
          capacity: p.capacity,
          window: p.window,
          accessibility_support: p.accessibility_support,
        });
        break;
      case "HOST_CANCELLED":
        s.cancelled = true;
        s.cancelled_at = p.cancelled_at;
        s.cancel_reason = p.reason;
        break;
    }
  }
  return s;
}

function foldSlot(events) {
  const s = {
    id: null,
    program_id: null,
    host_id: null,
    participant_id: null,
    scheduled_start: null,
    scheduled_end: null,
    status: "created", // created → offered → accepted | declined | replaced；cancelled
    matched_major: null,
    match_score: null,
    transport: null,
    accommodation: null,
    pending_change: null, // 等待参与者决定的调整提案
    change_history: [],
    broken: false,
    checkins: [], // 原始签到记录（含被拒代签）
    attendance: null, // 有效到场（本人核身）
    late_review: null, // 迟到交流的人工复核结论
    effective_interaction: null, // 双方确认后的有效交流
    acks: { participant: null, host: null },
  };
  for (const e of events) {
    const p = e.payload ?? {};
    switch (e.event_type) {
      case "SLOT_ASSIGNED":
        s.id = e.aggregate_id;
        s.program_id = p.program_id;
        s.host_id = p.host_id;
        s.participant_id = p.participant_id;
        s.scheduled_start = p.scheduled_start;
        s.scheduled_end = p.scheduled_end;
        s.matched_major = p.matched_major ?? null;
        s.assignment_basis = p.basis;
        s.status = "assigned";
        break;
      case "SLOT_OFFERED":
        s.id = e.aggregate_id;
        s.program_id = p.program_id;
        s.host_id = p.host_id;
        s.participant_id = p.participant_id;
        s.scheduled_start = p.scheduled_start;
        s.scheduled_end = p.scheduled_end;
        s.matched_major = p.matched_major ?? null;
        s.match_score = p.match_score;
        s.status = "offered";
        break;
      case "SLOT_ACCEPTED":
        s.status = "accepted";
        s.accepted_at = p.accepted_at;
        break;
      case "SLOT_DECLINED":
        s.status = "declined";
        s.declined_at = p.declined_at;
        s.decline_reason = p.reason ?? null;
        break;
      case "TRANSPORT_ARRANGED":
        s.transport = {
          mode: p.mode,
          vehicle_ref: p.vehicle_ref ?? null,
          pickup: p.pickup,
          dropoff: p.dropoff,
          seats_total: p.seats_total ?? null,
        };
        break;
      case "ACCOMMODATION_ARRANGED":
        s.accommodation = {
          venue_ref: p.venue_ref,
          room_ref: p.room_ref,
          check_in: p.check_in,
          check_out: p.check_out,
          accessibility_met: p.accessibility_met,
        };
        break;
      case "CHANGE_CONSENT_REQUESTED":
        s.pending_change = { change_kind: p.change_kind, proposal: p.proposal, requested_at: p.requested_at };
        break;
      case "CHANGE_CONSENT_DECIDED":
        // 决定本身只清掉待决提案；替代/调整的生效以携带 consent_event_id 的
        // ITINERARY_CHANGED 事件为准，保证"同意"与"变更"两个事实可分别审计。
        s.pending_change = null;
        s.last_change_decision = { decision: p.decision, decided_at: p.decided_at };
        break;
      case "ITINERARY_CHANGED":
        s.change_history.push({
          change_kind: p.change_kind,
          reason: p.reason,
          before: p.before ?? null,
          after: p.after ?? null,
          consent_event_id: p.consent_event_id ?? null,
          broken: p.broken,
          at: e.occurred_at,
        });
        if (p.broken) s.broken = true;
        if (p.change_kind === "host_cancel") s.status = "cancelled";
        if (p.change_kind === "replacement" && p.consent_event_id) {
          if (p.after) {
            s.host_id = p.after.host_id ?? s.host_id;
            s.scheduled_start = p.after.scheduled_start ?? s.scheduled_start;
            s.scheduled_end = p.after.scheduled_end ?? s.scheduled_end;
          }
          s.status = "replaced";
          s.broken = false; // 经同意的替代活动接续，断点解除
        }
        if ((p.change_kind === "transport" || p.change_kind === "accommodation") && p.after && !p.requires_participant_consent) {
          if (p.change_kind === "transport") s.transport = { ...(s.transport ?? {}), ...p.after };
          if (p.change_kind === "accommodation") s.accommodation = { ...(s.accommodation ?? {}), ...p.after };
        }
        break;
      case "CHECKIN_RECORDED":
        s.checkins.push({
          event_id: e.event_id,
          check_in_at: p.check_in_at,
          late_minutes: p.late_minutes,
          method: p.method,
          proxy_for: p.proxy_for ?? null,
          rejected: false,
        });
        break;
      case "PROXY_CHECKIN_REJECTED":
        s.checkins = s.checkins.map((c) => (c.event_id === p.rejected_checkin_event_id ? { ...c, rejected: true, reject_reason: p.reason } : c));
        break;
      case "ATTENDANCE_VERIFIED":
        s.attendance = {
          check_method: p.check_method,
          check_in_at: p.check_in_at,
          late_minutes: p.late_minutes,
          on_time: p.on_time,
          verified_at: e.occurred_at,
        };
        break;
      case "LATE_INTERACTION_REVIEWED":
        s.late_review = {
          reviewer: p.reviewer,
          reviewed_at: p.reviewed_at,
          conclusion: p.conclusion,
          note: p.note ?? null,
        };
        // 复核结论为"无效"时，撤掉此前可能已形成的有效交流判定
        if (p.conclusion === "ineffective") s.effective_interaction = null;
        break;
      case "INTERACTION_ACKNOWLEDGED":
        s.acks[p.by_party] = { at: p.acknowledged_at, topic_refs: p.topic_refs ?? [] };
        const interactionValid = s.attendance?.on_time || s.late_review?.conclusion === "effective";
        if (s.acks.participant && s.acks.host && interactionValid) {
          s.effective_interaction = {
            at: e.occurred_at,
            participant_at: s.acks.participant.at,
            host_at: s.acks.host.at,
            topics: [...new Set([...s.acks.participant.topic_refs, ...s.acks.host.topic_refs])],
            via_late_review: !s.attendance?.on_time,
          };
        }
        break;
    }
  }
  return s;
}

function foldOutcome(events) {
  const s = {
    id: null,
    program_id: null,
    participant_id: null,
    host_id: null,
    intention: null, // 后续意向（参与者表达）
    employment: null, // 就业结果（有来源联系）
    rejected_claims: [],
    history: [],
  };
  for (const e of events) {
    const p = e.payload ?? {};
    switch (e.event_type) {
      case "OUTCOME_LINKED":
        s.id = e.aggregate_id;
        s.program_id = p.program_id;
        s.participant_id = p.participant_id;
        s.host_id = p.host_id;
        if (p.kind === "intention") {
          s.intention = { linked_at: e.occurred_at, claim: p.claim, related_slot_id: p.related_slot_id ?? null };
        } else if (p.kind === "employment") {
          s.employment = {
            linked_at: e.occurred_at,
            source: p.source,
            evidence_ref: p.evidence_ref,
            claim: p.claim,
            related_slot_id: p.related_slot_id ?? null,
          };
        }
        s.history.push({ type: p.kind, at: e.occurred_at });
        break;
      case "EMPLOYMENT_RESULT_CLAIMED":
        s.id = e.aggregate_id;
        s.program_id = p.program_id;
        s.participant_id = p.participant_id;
        s.host_id = p.host_id;
        s.employment = {
          source_type: p.source_type,
          source_contact: p.source_contact,
          evidence_ref: p.evidence_ref,
          occurred_on: p.occurred_on,
          related_slot_id: p.related_slot_id ?? null,
          statement: p.statement,
          claimed_by_project_id: e.payload.program_id,
          claimed_at: p.claimed_at,
        };
        s.history.push({ type: "employment", at: e.occurred_at });
        break;
      case "DUPLICATE_CLAIM_REJECTED":
        s.id = e.aggregate_id;
        s.program_id = p.program_id;
        s.participant_id = p.participant_id;
        s.host_id = p.host_id;
        s.rejected_claims.push({
          kind: p.rejected_kind,
          claimed_by_project_id: p.claimed_by_project_id,
          at: p.rejected_at,
        });
        break;
    }
  }
  return s;
}

const FOLDERS = {
  program_participant: foldParticipant,
  host_commitment: foldHost,
  itinerary_slot: foldSlot,
  engagement_outcome: foldOutcome,
};

/** 从存储还原全部聚合，返回 Map<aggregateType, Map<id, state>>。 */
export function materialize(store) {
  const byType = new Map(Object.keys(FOLDERS).map((t) => [t, new Map()]));
  const streams = new Map();
  for (const event of store.allEvents()) {
    const key = `${event.aggregate_type} ${event.aggregate_id}`;
    if (!streams.has(key)) streams.set(key, { type: event.aggregate_type, id: event.aggregate_id, events: [] });
    streams.get(key).events.push(event);
  }
  for (const { type, id, events } of streams.values()) {
    events.sort((a, b) => a.version - b.version);
    byType.get(type)?.set(id, FOLDERS[type](events));
  }
  return byType;
}

export function reduceOne(aggregateType, events) {
  return FOLDERS[aggregateType](events);
}
