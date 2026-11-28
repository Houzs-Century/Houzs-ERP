import type { HowtoGuide } from "./mcp-howto-types";
import { SALES_GUIDES } from "./mcp-howto-guides-sales";
import { PURCHASING_GUIDES } from "./mcp-howto-guides-purchasing";
import { AFTERSALES_GUIDES } from "./mcp-howto-guides-aftersales";

/** Every how-to guide (task SOPs and end-to-end flows), in display order. */
export const HOWTO_GUIDES: readonly HowtoGuide[] = [...SALES_GUIDES, ...PURCHASING_GUIDES, ...AFTERSALES_GUIDES];
