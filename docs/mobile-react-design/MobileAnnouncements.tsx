// MobileAnnouncements — view-only (list / detail). Maps to prototype: #m-ann.
// No cover image; attachments only (photo / video / PDF). "Got it" acknowledgement. Audience NOT shown to recipients.
import { useState } from 'react';

export interface Announcement { id: string; title: string; publisher: string; published_at: string; body: string; attachment_name?: string; acknowledged?: boolean; }

export function MobileAnnouncements({ items, onOpenMenu }: { items: Announcement[]; onOpenMenu: () => void }) {
  const [cur, setCur] = useState<Announcement | null>(null);

  if (cur) return (
    <div className="hz-m screen">
      <header className="hdr">
        <button onClick={() => setCur(null)} style={{ background: 'none', border: 'none', color: '#16695f', fontWeight: 600, fontSize: 12.5, cursor: 'pointer' }}>&lsaquo; Announcements</button>
        <div className="scr-title" style={{ marginTop: 6 }}>{cur.title}</div>
        <div style={{ fontSize: 11, color: '#767b6e', marginTop: 4 }}>{cur.publisher} · {cur.published_at}</div>
      </header>
      <div className="scroll">
        <div className="card"><div className="card-b" style={{ fontSize: 13, lineHeight: 1.6, color: '#414539' }}>{cur.body}</div></div>
        {cur.attachment_name && (
          <div className="card"><div className="card-b" style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <span style={{ width: 40, height: 40, borderRadius: 9, background: '#f3ece0', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#8a4b12" strokeWidth="2"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" /><path d="M14 3v5h5" /></svg>
            </span>
            <span style={{ fontSize: 12.5, fontWeight: 600, color: '#11140f' }}>{cur.attachment_name}</span>
          </div></div>
        )}
      </div>
      <div className="actbar"><button className="btn">Got it</button></div>
    </div>
  );

  return (
    <div className="hz-m screen">
      <header className="hdr">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div><div className="scr-title">Announcements</div><div style={{ fontSize: 10.5, color: '#9aa093', marginTop: 3 }}>Published by HQ · you only see ones sent to you</div></div>
          <button onClick={onOpenMenu} style={{ background: 'none', border: 'none', color: '#16695f', cursor: 'pointer' }}><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#16695f" strokeWidth="2" strokeLinecap="round"><path d="M3 6h18M3 12h18M3 18h18" /></svg></button>
        </div>
      </header>
      <div className="scroll">
        {items.map((a) => (
          <div key={a.id} className="card" style={{ padding: 13, cursor: 'pointer' }} onClick={() => setCur(a)}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              <span style={{ fontSize: 14, fontWeight: 800, color: '#11140f' }}>{a.title}</span>
              {!a.acknowledged && <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#b23a3a', flex: 'none', marginTop: 5 }} />}
            </div>
            <div style={{ fontSize: 11, color: '#767b6e', marginTop: 4 }}>{a.publisher} · {a.published_at}</div>
            <div style={{ fontSize: 12, color: '#414539', marginTop: 7, lineHeight: 1.5, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{a.body}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
