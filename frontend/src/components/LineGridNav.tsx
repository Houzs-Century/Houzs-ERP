import { useEffect } from 'react';
import { installLineGridNav } from '../lib/lineGridNav';

/** Arrow keys move between the fields of every document's line editor — see lib/lineGridNav.ts. */
export function LineGridNav() {
  useEffect(() => installLineGridNav(), []);
  return null;
}
