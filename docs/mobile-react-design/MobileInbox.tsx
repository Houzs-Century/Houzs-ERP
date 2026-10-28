// MobileInbox — notifications feed. Maps to prototype: #inbox.
export interface Notification { title: string; body: string; time: string; unread?: boolean; group: 'Today' | 'Earlier'; }
export function MobileInbox({ items, onOpenMenu, onMarkAllRead, onOpen }:
  { items: Notification[]; onOpenMenu: () => void; onMarkAllRead: () => void; onOpen: (n: Notification) => void }) {
  const groups: ('Today' | 'Earlier')[] = ['Today', 'Earlier'];
  return (
    <div className="hz-m screen">
      <header className="hdr">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div><div className="eyebrow">Activity</div><div className="scr-title">Inbox</div></div>
          <button onClick={onMarkAllRead} style={{ background: 'none', border: 'none', color: '#16695f', fontWeight: 600, fontSize: 12.5, cursor: 'pointer' }}>Mark all read</button>
        </div>
      </header>
      <div className="scroll">
        {groups.map((g) => {
          const rows = items.filter((n) => n.group === g);
          if (!rows.length) return null;
          return (
            <div key={g}>
              <div className="fld-l" style={{ marginBottom: 8 }}>{g}</div>
              {rows.map((n, i) => (
                <div key={i} className="card" style={{ padding: '12px 13px', display: 'flex', gap: 10, cursor: 'pointer' }} onClick={() => onOpen(n)}>
                  <span style={{ width: 7, height: 7, borderRadius: '50%', background: n.unread ? '#b23a3a' : 'transparent', flex: 'none', marginTop: 5 }} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 700, color: '#11140f' }}>{n.title}</div>
                    <div style={{ fontSize: 11.5, color: '#767b6e', marginTop: 2, lineHeight: 1.4 }}>{n.body}</div>
                    <div className="money" style={{ fontSize: 10, color: '#9aa093', marginTop: 3 }}>{n.time}</div>
                  </div>
                </div>
              ))}
            </div>
          );
        })}
        {items.length === 0 && <div className="empty"><div className="empty-t">No notifications</div></div>}
      </div>
    </div>
  );
}
