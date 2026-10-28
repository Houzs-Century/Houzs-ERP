# Column Allocation Reference

## 1. Delivery Details (West Malaysia)

| Index | Col | Column Name | Description |
|-------|-----|-------------|-------------|
| 1 | A | Delivery Message Status | Manual. Delivery status message. Auto-synced to Column P (Remark 4) and pushed to AutoCount on edit. |
| 2 | B | Doc. No. | API Pull. Sales Order document number. Primary key for row matching. |
| 3 | C | Transfer To | API Pull. D/O (Delivery Order) number. |
| 4 | D | Date | API Pull. Sales Order date (DocDate). |
| 5 | E | Ref. No. | API Pull. Customer reference number. |
| 6 | F | Branding | API Pull. SOUDF_BRANDING field from AutoCount. |
| 7 | G | Debtor Name | API Pull. Customer name. |
| 8 | H | Phone (60xxxxxxxx) | API Pull. Customer phone number. Special characters (+, &, -, space) stripped on pull. |
| 9 | I | Sales Location | API Pull. Branch location code (KL, PG for West). Used for regional routing. |
| 10 | J | Agent | API Pull. Sales agent name. |
| 11 | K | Local Total | API Pull. Order total amount. |
| 12 | L | Balance | API Pull. SOUDF_BALANCE — remaining balance to collect. |
| 13 | M | Remarks 2 | API Pull. Remark2 field from AutoCount. |
| 14 | N | Processing Date | API Pull. SOUDF_PDate — processing/production date. |
| 15 | O | Sales Exemption Expiry Date | API Pull / Push. Expiry date for the order. Updated via Column Q edit (YYYY/MM/DD). Pushed to AutoCount as ExpiryDate. |
| 16 | P | Remark 4 | API Pull / Push. Auto-populated from Column A on edit. Pushed to AutoCount. |
| 17 | Q | Delivery Date | Manual. Validated on edit for YYYY/MM/DD format. Value copied to Column O on valid entry. |
| 18 | R | Amend Delivery Date from Customer | Manual. Customer-requested delivery date change. |
| 19 | S | Amend Client Date Reason | Manual. Reason for the delivery date amendment. |
| 20 | T | Estimate New Delivery Date | Manual. Internal estimated new delivery date. |
| 21 | U | Internal - To Confirm Purchasing | Manual. Internal purchasing confirmation notes. |
| 22 | V | Landed / Condo / Apartment | Manual. Property type classification. |
| 23 | W | New House / Replacement | Manual. Indicates if new house or replacement order. |
| 24 | X | Replacement (Disposal) | Manual. Disposal details for replacement orders. |
| 25 | Y | Remark 3 (INTERNAL USE) | API Pull. Remark3 field. Block 2 write starts here for West. |
| 26 | Z | Note | API Pull. SOUDF_Note field from AutoCount. |
| 27 | AA | PO Doc No. | API Pull. SOUDF_ToPONo — linked Purchase Order number. |
| 28 | AB | Address 1 | API Pull. InvAddr1 — invoice address line 1. |
| 29 | AC | Address 2 | API Pull. InvAddr2 — invoice address line 2. |
| 30 | AD | Address 3 | API Pull. InvAddr3 — invoice address line 3. Used for Singapore routing detection. |
| 31 | AE | Address 4 | API Pull. InvAddr4 — invoice address line 4. |
| 32 | AF | Time Range | Manual. Delivery time window. |
| 33 | AG | Time Confirmed | Manual. Confirmed delivery time. |
| 34 | AH | Internal - To Send Customer | Manual. Internal flag for customer communication. |
| 35 | AI | Lorry Plate | Manual. Delivery vehicle plate number. |
| 36 | AJ | Driver Name | Manual. Delivery driver name. |
| 37 | AK | Driver IC | Manual. Driver identification number. |
| 38 | AL | Driver Contact | Manual. Driver phone number. |
| 39 | AM | Days Left | Manual. Days remaining until delivery. |
| 40 | AN | Driver 2 | Manual. Second driver name (if applicable). |
| 41 | AO | Helper 1 | Manual. First delivery helper name. |
| 42 | AP | Helper 2 | Manual. Second delivery helper name. |
| 43 | AQ | Arrival Time (Start) | Manual. Driver arrival start time. |
| 44 | AR | Departure Time (End) | Manual. Driver departure end time. |
| 45 | AS | Attention | API Pull / Push. Attention field. Set to "SEAMPIFY" on pull. |
| 46 | AT | Sync Status | System. Sync state indicator. Values: SYNCED (green), PENDING (yellow), ERR: {code} (red). |

---

## 2. EM Order (East Malaysia)

Columns V and W are empty spacer columns. All columns after U are shifted +2 from their original positions. Last column is BD (56).

| Index | Col | Column Name | Description |
|-------|-----|-------------|-------------|
| 1 | A | Delivery Message Status | Manual. Delivery status message. Auto-synced to Column P (Remark 4) and pushed to AutoCount on edit. |
| 2 | B | Doc. No. | API Pull. Sales Order document number. Primary key for row matching. |
| 3 | C | Transfer To | API Pull. D/O (Delivery Order) number. |
| 4 | D | SO Date | API Pull. Sales Order date (DocDate). |
| 5 | E | Ref. | API Pull. Customer reference number. |
| 6 | F | BRANDING | API Pull. SOUDF_BRANDING field from AutoCount. |
| 7 | G | Debtor Name | API Pull. Customer name. |
| 8 | H | Phone | API Pull. Customer phone number. Special characters stripped on pull. |
| 9 | I | Sales Location | API Pull. Branch location code (SBH, SRW for East). Used for regional routing. |
| 10 | J | Agent | API Pull. Sales agent name. |
| 11 | K | Local Total | API Pull. Order total amount. |
| 12 | L | BALANCE | API Pull. SOUDF_BALANCE — remaining balance to collect. |
| 13 | M | Remarks 2 | API Pull. Remark2 field from AutoCount. |
| 14 | N | Processing Date | API Pull. SOUDF_PDate — processing/production date. |
| 15 | O | Sales Exemption Expiry Date / DO Date | API Pull / Push. Expiry date. Updated via Column Q edit. Pushed to AutoCount as ExpiryDate. |
| 16 | P | Remark 4 | API Pull / Push. Auto-populated from Column A on edit. Pushed to AutoCount. |
| 17 | Q | SHIPOUT DATE = DO Date | Manual. Validated on edit for YYYY/MM/DD format. Value copied to Column O on valid entry. |
| 18 | R | ETA of Arriving Port | Transporter Owned. Managed by transporter team via external spreadsheet. |
| 19 | S | Estimate Delivery Date | Transporter Owned. Managed by transporter team via external spreadsheet. |
| 20 | T | m3 (RM 10 / week) | Transporter Owned. Managed by transporter team via external spreadsheet. |
| 21 | U | Internal - To Confirm Purchasing | Manual. Internal purchasing confirmation notes. |
| 22 | V | *(empty)* | Spacer. Empty column — no data written. |
| 23 | W | *(empty)* | Spacer. Empty column — no data written. |
| 24 | X | Item Details | Manual. Item description or details. |
| 25 | Y | Remark 3 (INTERNAL USE) | API Pull. Remark3 field. Block 2 write starts here for East. |
| 26 | Z | Note | API Pull. SOUDF_Note field from AutoCount. |
| 27 | AA | PO Doc No. | API Pull. SOUDF_ToPONo — linked Purchase Order number. |
| 28 | AB | Address 1 | API Pull. InvAddr1 — invoice address line 1. |
| 29 | AC | Address 2 | API Pull. InvAddr2 — invoice address line 2. |
| 30 | AD | Address 3 | API Pull. InvAddr3 — invoice address line 3. |
| 31 | AE | Address 4 | API Pull. InvAddr4 — invoice address line 4. |
| 32 | AF | NIL | Reserved. Currently unused. |
| 33 | AG | Done Delivery | Manual. Delivery completion flag or date. |
| 34 | AH | CTN | Manual. Carton count or container reference. |
| 35 | AI | Remarks | Manual. General remarks. |
| 36 | AJ | Consignment No | Manual. Shipping consignment tracking number. |
| 37 | AK | Vessel & Voyage | Transporter Owned. Shipping vessel and voyage reference. |
| 38 | AL | ETD Port Klang | Transporter Owned. Estimated departure from Port Klang. |
| 39 | AM | ETA Destination | Transporter Owned. Estimated arrival at destination port. |
| 40 | AN | Remarks 1 | Transporter Owned. Transporter remarks line 1. |
| 41 | AO | Remarks 2 | Transporter Owned. Transporter remarks line 2. |
| 42 | AP | Attention | Transporter Owned / API Push. Attention field. Set to "SEAMPIFY" on pull. Transporter can override. |
| 43 | AQ | Sync Status | System. Sync state indicator. Values: SYNCED (green), PENDING (yellow), ERR: {code} (red). |
| 44 | AR | Supplier Invoice | Manual. Supplier invoice reference number. |
| 45 | AS | Supplier Invoice Date | Manual. Date of supplier invoice. |
| 46 | AT | SEAFREIGHT | Manual. Sea freight cost. |
| 47 | AU | LOCAL CHARGES | Manual. Local handling charges. |
| 48 | AV | LSS | Manual. Low Sulphur Surcharge. |
| 49 | AW | INLAND | Manual. Inland transport cost. |
| 50 | AX | TPT & INSTALLATION FIRST SET | Manual. Transport and first installation set cost. |
| 51 | AY | INSTALLATION SUBSEQUENT SET | Manual. Subsequent installation set cost. |
| 52 | AZ | AGENT FEE | Manual. Agent fee. |
| 53 | BA | INSURANCE | Manual. Insurance cost. |
| 54 | BB | ADD SST | Manual. Sales and Service Tax addition. |
| 55 | BC | ROUNDING ADJUSTMENT | Manual. Rounding adjustment amount. |
| 56 | BD | TOTAL | Manual / Formula. Total cost calculation. |

---

## 3. SG Order (Singapore)

Columns R and S are empty spacer columns. Last column is AT (46).

| Index | Col | Column Name | Description |
|-------|-----|-------------|-------------|
| 1 | A | Delivery Message Status | Manual. Delivery status message. Auto-synced to Column P (Remark 4) and pushed to AutoCount on edit. |
| 2 | B | Doc. No. | API Pull. Sales Order document number. Primary key for row matching. |
| 3 | C | Transfer To | API Pull. D/O (Delivery Order) number. |
| 4 | D | Date | API Pull. Sales Order date (DocDate). |
| 5 | E | Ref. | API Pull. Customer reference number. |
| 6 | F | BRANDING | API Pull. SOUDF_BRANDING field from AutoCount. |
| 7 | G | Debtor Name | API Pull. Customer name. |
| 8 | H | Phone | API Pull. Customer phone number. Special characters stripped on pull. |
| 9 | I | Sales Location | API Pull. Branch location code. Routed to SG when InvAddr3 contains "SINGAPORE". |
| 10 | J | Agent | API Pull. Sales agent name. |
| 11 | K | Local Total | API Pull. Order total amount. |
| 12 | L | BALANCE | API Pull. SOUDF_BALANCE — remaining balance to collect. |
| 13 | M | Remarks 2 | API Pull. Remark2 field from AutoCount. |
| 14 | N | Processing Date | API Pull. SOUDF_PDate — processing/production date. |
| 15 | O | Sales Exemption Expiry Date | API Pull / Push. Expiry date. Updated via Column Q edit. Pushed to AutoCount as ExpiryDate. |
| 16 | P | Remark 4 | API Pull / Push. Auto-populated from Column A on edit. Pushed to AutoCount. |
| 17 | Q | Delivery Date | Manual. Validated on edit for YYYY/MM/DD format. Value copied to Column O on valid entry. |
| 18 | R | *(empty)* | Spacer. Empty column — no data written. |
| 19 | S | *(empty)* | Spacer. Empty column — no data written. |
| 20 | T | SHIPOUT DATE | Manual. Shipout date for SG orders. |
| 21 | U | Internal - To Confirm Purchasing | Manual. Internal purchasing confirmation notes. |
| 22 | V | Landed / Condo / Apartment | Manual. Property type classification. |
| 23 | W | New House / Replacement | Manual. Indicates if new house or replacement order. |
| 24 | X | New House (Ready / Delay) | Manual. New house readiness status. |
| 25 | Y | Replacement (Disposal) | Manual. Disposal details for replacement orders. |
| 26 | Z | Note | API Pull. SOUDF_Note field. Block 2 write starts here for SG (no Remark 3 column). |
| 27 | AA | PO Doc No. | API Pull. SOUDF_ToPONo — linked Purchase Order number. |
| 28 | AB | Address 1 | API Pull. InvAddr1 — invoice address line 1. |
| 29 | AC | Address 2 | API Pull. InvAddr2 — invoice address line 2. |
| 30 | AD | Address 3 | API Pull. InvAddr3 — invoice address line 3. Contains "SINGAPORE" for routing. |
| 31 | AE | Address 4 | API Pull. InvAddr4 — invoice address line 4. |
| 32 | AF | Time Range | Manual. Delivery time window. |
| 33 | AG | Time Confirmed | Manual. Confirmed delivery time. |
| 34 | AH | Internal - To Send Customer | Manual. Internal flag for customer communication. |
| 35 | AI | Lorry Plate | Manual. Delivery vehicle plate number. |
| 36 | AJ | Driver Name | Manual. Delivery driver name. |
| 37 | AK | Driver IC | Manual. Driver identification number. |
| 38 | AL | Driver Contact | Manual. Driver phone number. |
| 39 | AM | Days Left | Manual. Days remaining until delivery. |
| 40 | AN | Driver 2 | Manual. Second driver name (if applicable). |
| 41 | AO | Helper 1 | Manual. First delivery helper name. |
| 42 | AP | SYNC_STATUS | Legacy. Original sync status column (superseded by col 46). |
| 43 | AQ | Arrival Time (Start) | Manual. Driver arrival start time. |
| 44 | AR | Departure Time (End) | Manual. Driver departure end time. |
| 45 | AS | Attention | API Pull / Push. Attention field. Set to "SEAMPIFY" on pull. |
| 46 | AT | Sync Status | System. Sync state indicator. Values: SYNCED (green), PENDING (yellow), ERR: {code} (red). |

---

## 4. ASSR Case

| Index | Col | Column Name | Description |
|-------|-----|-------------|-------------|
| 1 | A | ASSR Status | Manual. Case status (starts as "Under Verification"). |
| 2 | B | S/O | Form / API. Sales Order document number from form submission. |
| 3 | C | ASSR NO | System Generated. Format: ASSR/YYMM-NNN (e.g. ASSR/2506-001). Scanned from Column C for sequence. |
| 4 | D | Complained Date | System. Auto-set to current date on form submission. |
| 5 | E | Ref No. | API Pull. Customer reference number (o.Ref). |
| 6 | F | NIL | Manual. Reserved column — not auto-populated. |
| 7 | G | Customer Name | API Pull. Debtor name from AutoCount. |
| 8 | H | HP | API Pull. Phone number. Special characters stripped. |
| 9 | I | Location | API Pull. Sales location code from AutoCount. |
| 10 | J | Sales Agent | API Pull. Sales agent name from AutoCount. |
| 11 | K | D/O | API Pull. Transfer To (Delivery Order) number. |
| 12 | L | DO Delivered Date | API Pull. SalesExemptionExpiryDate from AutoCount. |
| 13 | M | NIL | Manual. Reserved column — not auto-populated. |
| 14 | N | Action Remark | Manual. Action taken remarks. |
| 15 | O | Service Category | Manual. Category of service issue. |
| 16 | P | Supplier | Manual. Related supplier name. |
| 17 | Q | Service/Delivery Date (FIXED) | Manual. Fixed service or delivery date. |
| 18 | R | Pickup Service Date | Manual. Date of pickup service. |
| 19 | S | Supplier Pickup Date | Manual. Date supplier picks up item. |
| 20 | T | Item Ready Date | Manual. Date item is ready. |
| 21 | U | Completion Date | Manual. Date case is completed. |
| 22 | V | Case Period (Days) | Manual / Formula. Duration of case in days. |
| 23 | W | Service Item Code | Form. Item code detected from form submission (dynamic field). |
| 24 | X | Complaint Issue | Form. Issue description from form submission. |
| 25 | Y | Action Taken (Summarize) | Manual. Summary of actions taken. |
| 26 | Z | Call Log: Purchasing Action Taken | Manual. Call log and purchasing actions. |
| 27 | AA | PO No | API Pull. SOUDF_ToPONo — linked Purchase Order. |
| 28 | AB | Address 1 | API Pull. InvAddr1. |
| 29 | AC | Address 2 | API Pull. InvAddr2. |
| 30 | AD | Address 3 | API Pull. InvAddr3. |
| 31 | AE | Address 4 | API Pull. InvAddr4. |
| 32 | AF | Time Range | Manual. Service time window. |
| 33 | AG | Time Confirmed | Manual. Confirmed service time. |
| 34 | AH | Link Ref. | Formula. Reference link (formula exists in sheet). |
| 35 | AI | Lorry Plate | Manual. Service vehicle plate number. |
| 36 | AJ | Driver Name | Manual. Service driver name. |
| 37 | AK | Driver IC | Manual. Driver identification number. |
| 38 | AL | Driver Contact | Manual. Driver phone number. |
| 39 | AM | Day Left | Manual. Days remaining for the case. |
| 40 | AN | Goods Returned Note & Date | Manual. Goods return documentation. |
| 41 | AO | Supplier Service Note | Manual. Notes from supplier service. |

---

## 5. Outstanding PO

Data starts at Row 11 (header) / Row 12 (first data row). Rows 1–10 are reserved for internal team use.

| Index | Col | Column Name | Description |
|-------|-----|-------------|-------------|
| 1 | A | Doc No | API Pull. Purchase Order document number. Part of composite key (DocNo + ItemCode). |
| 2 | B | SO Doc No | API Pull. Linked Sales Order document number. |
| 3 | C | Creditor Code | API Pull. Supplier/creditor code. |
| 4 | D | Creditor Name | API Pull. Supplier/creditor name. |
| 5 | E | Item Code | API Pull. Item code. Part of composite key for Column P backup. |
| 6 | F | Item Description | API Pull. Primary item description. |
| 7 | G | Item Description 2 | API Pull. Secondary item description. |
| 8 | H | Location | API Pull. Stock location. |
| 9 | I | Item Group | API Pull. Item group classification. |
| 10 | J | Doc Date | API Pull. Purchase Order date. |
| 11 | K | Remaining Qty | API Pull. Outstanding quantity still to be delivered. |
| 12 | L | Delivery Date | API Pull. Expected delivery date. |
| 13 | M | Supplier Delivery Date 1 | Manual / Push. First supplier delivery date (POUDF_EDate). Synced to AutoCount via syncPODate. |
| 14 | N | Supplier Delivery Date 2 | Manual / Push. Second supplier delivery date (POUDF_EDate2). Synced to AutoCount via syncPODate. |
| 15 | O | Supplier Delivery Date 3 | Manual / Push. Third supplier delivery date (POUDF_EDate3). Synced to AutoCount via syncPODate. |
| 16 | P | Overdue Days | Manual. Manually maintained notes. Backed up before refresh and restored using DocNo+ItemCode composite key. |

---

## 6. Overdue History

Sheet is append-only. Each overdue pull adds new rows as a historical audit log.

| Index | Col | Column Name | Description |
|-------|-----|-------------|-------------|
| 1 | A | Pull Date | System. Timestamp of when the overdue pull was executed (yyyy-MM-dd HH:mm). |
| 2 | B | Doc. No. | API Pull. Sales Order document number. |
| 3 | C | Transfer To | API Pull. D/O number. |
| 4 | D | Date | API Pull. Sales Order date. |
| 5 | E | Ref. No. | API Pull. Customer reference number. |
| 6 | F | BRANDING | API Pull. SOUDF_BRANDING field. |
| 7 | G | Debtor Name | API Pull. Customer name. |
| 8 | H | Phone | API Pull. Customer phone number. |
| 9 | I | Location | API Pull. Sales location code. |
| 10 | J | Agent | API Pull. Sales agent name. |
| 11 | K | Total | API Pull. Order total amount. |
| 12 | L | Balance | API Pull. SOUDF_BALANCE — remaining balance. |
| 13 | M | Remark 2 | API Pull. Remark2 field. |
| 14 | N | Processing Date | API Pull. SOUDF_PDate. |
| 15 | O | Original Expiry Date | API Pull. SalesExemptionExpiryDate at time of pull (before auto-extension). |
| 16 | P | Remark 4 | API Pull. Remark4 field. |
| 17 | Q | Remark 3 | API Pull. Remark3 field. |
| 18 | R | Note | API Pull. SOUDF_Note field. |
| 19 | S | PO No | API Pull. SOUDF_ToPONo. |
| 20 | T | Address 1 | API Pull. InvAddr1. |
| 21 | U | Address 2 | API Pull. InvAddr2. |
| 22 | V | Address 3 | API Pull. InvAddr3. |
| 23 | W | Address 4 | API Pull. InvAddr4. |
| 24 | X | Venue | API Pull. SOUDF_VENUE. |
| 25 | Y | Attention | API Pull. Attention field. |

---

## 7. Balance Collection

Sheet is fully replaced on each refresh (clear → write). No manual columns.

| Index | Col | Column Name | Description |
|-------|-----|-------------|-------------|
| 1 | A | Doc. No. | API Pull. Sales Order document number. |
| 2 | B | Transfer To | API Pull. D/O number. |
| 3 | C | Date | API Pull. Sales Order date. |
| 4 | D | Ref. No. | API Pull. Customer reference number. |
| 5 | E | BRANDING | API Pull. SOUDF_BRANDING field. |
| 6 | F | Debtor Name | API Pull. Customer name. |
| 7 | G | Phone | API Pull. Customer phone number. |
| 8 | H | Location | API Pull. Sales location code. |
| 9 | I | Agent | API Pull. Sales agent name. |
| 10 | J | Total | API Pull. Order total amount. |
| 11 | K | BALANCE | API Pull. SOUDF_BALANCE. Column styled bold. |
| 12 | L | Remark 2 | API Pull. Remark2 field. |
| 13 | M | Processing Date | API Pull. SOUDF_PDate. |
| 14 | N | Sales Exemption Expiry Date | API Pull. Used for expiry highlighting. Red row = expired. Yellow row = expiring within 3 days. |
| 15 | O | Remark 4 | API Pull. Remark4 field. |
| 16 | P | Remark 3 | API Pull. Remark3 field. |
| 17 | Q | Note | API Pull. SOUDF_Note field. |
| 18 | R | PO No | API Pull. SOUDF_ToPONo. |
| 19 | S | Address 1 | API Pull. InvAddr1. |
| 20 | T | Address 2 | API Pull. InvAddr2. |
| 21 | U | Address 3 | API Pull. InvAddr3. |
| 22 | V | Address 4 | API Pull. InvAddr4. |
| 23 | W | Venue | API Pull. SOUDF_VENUE. |
| 24 | X | Attention | API Pull. Attention field. |

---

## Column Legend

| Tag | Meaning |
|-----|---------|
| **API Pull** | Value fetched from AutoCount API during pull and written to the sheet. |
| **API Pull / Push** | Fetched on pull, also pushed back to AutoCount when modified. |
| **Manual** | Entered by the team directly in the sheet. Not overwritten by API pulls. |
| **Manual / Push** | Entered manually, then synced to AutoCount via push function. |
| **Form** | Populated from Google Form submission. |
| **System** | Auto-generated by the script (timestamps, ASSR numbers, sync status). |
| **System Generated** | One-time generated value (e.g. ASSR number). |
| **Formula** | Contains a spreadsheet formula — not written by script. |
| **Transporter Owned** | Managed by transporter team in external spreadsheet. Preserved during sync. |
| **Legacy** | Superseded column kept for backward compatibility. |
| **Reserved** | Column exists in layout but is not currently used. |
