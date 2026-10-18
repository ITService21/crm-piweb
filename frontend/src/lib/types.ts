export type Role = 'admin' | 'agent';
export interface Me {
  id: number; name: string; email: string; role: Role; permissions: string[]; timezone: string;
  preferences: { sound_enabled: boolean; browser_notifications: boolean };
}
export type StatusCategory = 'active' | 'not_interested' | 'converted';
export interface SelectableValue {
  id: number; category: string; value_key: string; label: string; description: string | null; colour: string | null;
  status_category: StatusCategory | null; is_new_state: boolean; sort_order: number; is_active: boolean; usage_count?: number;
}
export interface Ref { id: number; label: string; colour?: string | null }
export interface Lead {
  id: number; lead_code: string; created_at: string;
  status: { id: number; label: string; colour: string | null; category: StatusCategory; is_new_state: boolean };
  enquiry_type: Ref | null; source: Ref | null; special_markup: (Ref & { key: string }) | null;
  email: string | null; phone: string | null; nickname: string | null; business_name: string | null; requirement: string | null; budget: string | null; message: string | null;
  next_followup_at: string | null;
  last_action_by: { id: number; name: string } | null; last_action_at: string;
  assigned_to: { id: number; name: string } | null; created_by: { id: number; name: string } | null;
  last_remark: { text: string; by: string | null; at: string } | null; remarks_count: number;
  priority_reason: 'new' | 'overdue' | 'followup_today' | null;
  removed: { at: string; by: string | null; reason: string } | null;
  allocated: { to: { id: number; name: string }; by: { id: number; name: string } | null; at: string } | null;
}
export interface Remark { id: number; text: string; created_at: string; author: string | null }
export interface Activity {
  id: number; action_type: string; summary: string; created_at: string; actor: string | null;
  before_data: unknown; after_data: unknown;
}
export interface UserLite { id: number; name: string; email?: string; role?: Role; is_active?: boolean; last_login_at?: string | null }
export type TabKey = 'leads' | 'not_interested' | 'converted' | 'scheduled' | 'removed';
export interface NewLeadEvent {
  eventId: string; seq: number; leadId: number; leadCode: string; enquiry: string; phone: string | null;
  nickname: string | null; receivedAt: string; replayed: boolean;
}
export interface Summary { unread_new_leads: number; overdue_followups: number; scheduled_followups: number; removed: number }
export type NoteCategory = 'whatsapp' | 'email';
export interface Note {
  id: number; category: NoteCategory; title: string; subject: string | null; content: string;
  copy_count: number; last_copied_at: string | null; created_by: number | null; created_by_name: string | null; updated_at: string;
}
export type NoteStats = Record<'all' | NoteCategory, { notes: number; copies: number }>;
