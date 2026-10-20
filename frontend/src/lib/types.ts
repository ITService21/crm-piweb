export type Role = 'admin' | 'agent' | 'telecaller';
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
  last_remark: { text: string; by: string | null; at: string; tags: Tag[] } | null; remarks_count: number;
  priority_reason: 'new' | 'overdue' | 'followup_today' | null;
  removed: { at: string; by: string | null; reason: string } | null;
  allocated: { to: { id: number; name: string }; by: { id: number; name: string } | null; at: string } | null;
}
export interface Tag { id: number; label: string; colour: string | null }
export interface Remark { id: number; text: string; created_at: string; author: string | null; tags: Tag[] }
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
export interface Summary { unread_new_leads: number; overdue_followups: number; scheduled_followups: number; removed: number; payment_followups?: number }
export type NoteKind = 'message' | 'email';
export interface NoteCategory { id: number; name: string; colour: string | null; sort_order: number; notes: number; copies: number }
export interface Note {
  id: number; category_id: number | null; category_name: string | null; category_colour: string | null; kind: NoteKind;
  title: string; subject: string | null; content: string;
  copy_count: number; last_copied_at: string | null; created_by: number | null; created_by_name: string | null; updated_at: string;
}

// ---------- quotations & invoices ----------
export type DocType = 'invoice' | 'quotation';
export interface Issuer { company_name: string; cin: string; headquarters: { label: string; lines: string[] }; office: { label: string; lines: string[] }; phone: string; website: string; bank?: { account_name: string; account_number: string; ifsc: string } }
export const CLIENT_KEYS = ['company_name', 'contact_name', 'email', 'phone', 'alt_phone', 'address', 'city', 'state', 'postal_code', 'country', 'gstin', 'pan', 'website', 'additional_details', 'notes'] as const;
export type ClientInfo = Record<(typeof CLIENT_KEYS)[number], string | null>;
export interface DocItem {
  position?: number; name: string; description: string | null; quantity: string; unit_price: string;
  discount_type: 'none' | 'percent' | 'amount'; discount_value: string | null; tax_rate: string | null;
  gross_amount: string; discount_amount: string; taxable_amount: string; tax_amount: string; line_total: string;
}
export interface ProofFile { id: number; name: string; mime: string; size: number; created_at: string }
export interface Payment { attachments?: ProofFile[]; id: number; amount: string; paid_on: string; method: string | null; reference: string | null; notes: string | null; created_by_name: string | null; created_at: string }
export interface DocEmail { id: number; channel: 'email' | 'whatsapp'; to_email: string; cc_email: string | null; subject: string; status: 'sent' | 'failed' | 'opened'; error: string | null; created_at: string; sent_by_name: string | null }
export interface BillingDoc {
  id: number; type: DocType; doc_number: string; status: string; currency: string;
  lead: { id: number; lead_code: string; nickname: string | null; removed: boolean };
  issue_date: string; due_date: string | null; payment_terms: string | null; po_number: string | null; place_of_supply: string | null;
  client_notes: string | null; internal_notes: string | null; client: ClientInfo; issuer: Issuer; items: DocItem[];
  subtotal: string; discount_total: string; taxable_amount: string; tax_amount: string; additional_charges: string; additional_charges_label: string | null;
  total: string; amount_paid: string; outstanding: string; amount_in_words: string | null;
  payment_status: 'unpaid' | 'partial' | 'paid' | null; is_overdue: boolean; is_expired: boolean;
  source_quotation_id: number | null; issued_at: string | null; responded_at: string | null; cancelled_at: string | null; cancel_reason: string | null;
  created_by_name: string | null; created_at: string; updated_at: string;
  next_payment_due?: string | null; payment_followup_due?: boolean;
  payments?: Payment[]; emails?: DocEmail[]; converted_invoice?: { id: number; doc_number: string } | null; source_quotation?: { id: number; doc_number: string } | null;
}
export interface DocRow {
  id: number; type: DocType; doc_number: string; status: string; lead: { id: number; lead_code: string }; client_name: string | null;
  issue_date: string; due_date: string | null; currency: string; total: string; amount_paid: string; outstanding: string;
  is_overdue: boolean; is_expired: boolean; created_by_name: string | null; created_at: string;
  next_payment_due?: string | null; payment_followup_due?: boolean;
}
export interface LeadDocRow { id: number; type: DocType; doc_number: string; status: string; total: string; outstanding: string; currency: string; is_overdue: boolean; is_expired: boolean; created_at: string }
