export type PortalStatusColor = "grey" | "blue" | "amber" | "violet" | "green";

// Who this token belongs to. 'staff' tokens are staff-ISSUED customer
// links, so the portal treats them as customer; 'sales' unlocks the
// salesperson variant (full stage progress, sales-attributed posts).
export type PortalViewer = "customer" | "staff" | "sales";

export interface PortalStageStep {
  stage: string;
  label: string;
  entered_at: string | null;
  done: boolean;
  current: boolean;
}

export interface PortalCaseDetail {
  viewer?: PortalViewer;
  // Present only for sales tokens — the real 9-stage progress.
  stages?: PortalStageStep[];
  case: {
    id: number;
    assr_no: string;
    customer_name: string | null;
    // Present only for sales tokens.
    doc_no?: string | null;
    ref_no?: string | null;
    complained_date: string | null;
    complaint_issue: string | null;
    category: string | null;
    status_label: string;
    status_color: PortalStatusColor;
    stage: string;
    expected_resolution_at: string | null;
    completion_date: string | null;
    closed_at: string | null;
    satisfaction_rating: number | null;
    resolution_method: string | null;
  };
  items: Array<{
    id: number;
    item_code: string;
    item_description: string | null;
    qty: number | null;
  }>;
  attachments: Array<{
    id: number;
    category: string;
    file_name: string | null;
    content_type: string | null;
    source: "staff" | "customer" | "system" | "sales" | null;
    created_at: string;
  }>;
  timeline: Array<{
    id: number;
    action: string;
    label: string;
    at: string;
    source: "staff" | "customer" | "system" | "sales";
    note?: string;
  }>;
}
