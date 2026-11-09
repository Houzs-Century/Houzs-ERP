import { useSearchParams } from 'react-router-dom';

/* Modular hides a Model whose codes are all switched off - the leftover of a
   merge - unless "Show inactive" is on (owner, 2026-11-10). A Model that is on
   and has no code yet stays visible: that is the "0 SKUs" orphan flag staff
   asked to see (2026-06-19), not a leftover. */

type CountedModel = { active: boolean; sku_count?: number; active_sku_count?: number };

export const SHOW_INACTIVE_PARAM = 'showInactive';

export function isLeftoverModel(m: CountedModel): boolean {
  if (m.active_sku_count === undefined) return false;
  return m.active_sku_count === 0 && (!m.active || (m.sku_count ?? 0) > 0);
}

export function visibleModels<T extends CountedModel>(models: T[], showInactive: boolean): T[] {
  return showInactive ? models : models.filter((m) => !isLeftoverModel(m));
}

/** "3" when every code is on; "2 of 3 on" when some are off. */
export function skuCountText(m: CountedModel): string {
  const total = m.sku_count ?? 0;
  if (m.active_sku_count === undefined || m.active_sku_count === total) return String(total);
  return `${m.active_sku_count} of ${total} on`;
}

export function useShowInactiveModels(): [boolean, (on: boolean) => void] {
  const [params, setParams] = useSearchParams();
  const on = params.get(SHOW_INACTIVE_PARAM) === '1';
  const set = (next: boolean) => setParams((p) => {
    const n = new URLSearchParams(p);
    if (next) n.set(SHOW_INACTIVE_PARAM, '1'); else n.delete(SHOW_INACTIVE_PARAM);
    return n;
  }, { replace: true });
  return [on, set];
}

export const ShowInactiveModelsToggle = ({ hidden }: { hidden: number }) => {
  const [on, set] = useShowInactiveModels();
  return (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 'var(--fs-13)' }}>
      <input type="checkbox" checked={on} onChange={(e) => set(e.target.checked)} />
      Show inactive{!on && hidden > 0 ? ` (${hidden} hidden)` : ''}
    </label>
  );
};
