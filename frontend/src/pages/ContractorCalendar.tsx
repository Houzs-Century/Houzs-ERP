// ----------------------------------------------------------------------------
// The two public share-link surfaces, each a mode of ONE page:
//
//   /c/<token>  ContractorCalendar — a booth contractor's confirmed events;
//               tap an event for its UNFILLED floorplan
//   /b/<token>  BrandCalendar — a brand's own confirmed events; tap an event
//               for its DISPLAY floorplan, size and total sales
//
// Everything lives in pages/ShareCalendar.tsx. These names stay because
// main.tsx and the tests mount them by name. What each mode may see is a
// SERVER decision (routes/publicContractorCalendar.ts,
// routes/publicBrandCalendar.ts), not a prop this file could get wrong.
// ----------------------------------------------------------------------------
import { ShareCalendar } from "./ShareCalendar";

export function ContractorCalendar() {
  return <ShareCalendar mode="contractor" />;
}

export function BrandCalendar() {
  return <ShareCalendar mode="brand" />;
}
