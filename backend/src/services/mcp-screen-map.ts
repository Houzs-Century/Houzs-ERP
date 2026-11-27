import type { ScreenPage } from "./mcp-screen-types";
import { SALES_SCREENS } from "./mcp-screen-map-sales";
import { SUPPLY_SCREENS } from "./mcp-screen-map-supply";
import { FINANCE_SCREENS } from "./mcp-screen-map-finance";
import { GENERAL_SCREENS } from "./mcp-screen-map-general";

/** Every page of the frontend router, for explain_screen and where_is. */
export const SCREENS: readonly ScreenPage[] = [...SALES_SCREENS, ...SUPPLY_SCREENS, ...FINANCE_SCREENS, ...GENERAL_SCREENS];
