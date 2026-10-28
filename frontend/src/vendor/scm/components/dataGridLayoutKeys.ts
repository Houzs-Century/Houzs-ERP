/**
 * Stable ownership manifest for layout keys that previously collided.
 *
 * Keep each logical grid on its own entry. The accompanying uniqueness test
 * makes a repeated value fail CI before one page can corrupt another page's
 * saved column layout.
 */
export const DATA_GRID_LAYOUT_KEYS = {
  driversStandalone: "dg-drivers-standalone",
  fleetDrivers: "dg-drivers",
} as const;
