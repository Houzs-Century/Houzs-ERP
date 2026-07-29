export * from './format';
export * from './phone';
export * from './pricing';
export * from './mfg-pricing';
export * from './sofa-build';
export * from './sofa-combo-pricing';
export * from './sofa-quick-presets';
export * from './order-rules';
export * from './variant-key';
export * from './schemas';
export * from './variant-summary'; // Commander 2026-05-28
export * from './so-variant-rule'; // 2026-06-04 — POS/Backend variant vocabulary unified
export * from './fabric-tier-addon';
export * from './adjustment-reasons'; // 2026-06-04 — stock adjustment reason codes
export * from './inventory-adjustment'; // 2026-06-09 — adjustment variant+batch gate
export * from './adjustment-cost'; // 2026-07-25 — force real unit cost on +ADJUSTMENT/STOCK_TAKE (audit R3)
export * from './sofa-tier'; // 2026-06-09 — sofa price-tier recognition for SKU import
export * from './service-sku'; // 2026-06-05 — SERVICE SKU vocabulary + guards (SO-SKU spec P1)
export * from './service-lines'; // 2026-06-05 — fee/addon → SERVICE line builders (SO-SKU spec P2)
export * from './so-sofa-split'; // 2026-06-05 — sofa build → per-module line split (SO-SKU spec P3)
export * from './one-shot-sku'; // 2026-06-08 — one-shot SKU code/name helpers (remark → auto-SKU)
export * from './maintenance-pools'; // 2026-06-12 — maintenance option ACTIVE toggles (picker-level filter)
export * from './free-gift'; // 2026-06-14 — default free gift pure module (parse/desired/validate)
export * from './free-item-campaign'; // 2026-06-17 — free item campaign matcher (campaignsCoveringLine)
export * from './hr-commission'; // 2026-06-14 — HR commission math + KPI line matcher
export * from './effective-delivery'; // 2026-06-19 — PO supplier-revised delivery date (migration 0180): effective = MAX over non-null
export * from './rule-target'; // 2026-06-21 — unified rule targeting (model/variant/compartment/combo matcher)
export * from './special-delivery-match'; // 2026-06-21 — model-agnostic delivery trigger matcher (reuses rule-target)
export * from './fabric-tier-override-resolve'; // 2026-06-21 — effective fabric-tier delta = MAX(model, matching compartments)
export * from './so-amendment'; // 2026-07-11 — SO amendment/revision state machine + guards (port of 2990 0703)
export * from './amendment-lane'; // 2026-07-27 — SO amendment two-lane rework (LINES=purchasing / DELIVERY=logistics), split + lane state machine
export * from './so-save-problems'; // 2026-07-18 — aggregate ALL Processing-Date/save gate failures into one problem list
export * from './so-field-policy'; // 2026-07-19 — SO field edit policy: FREE (Save writes) vs CONTROLLED (Save raises an amendment)
