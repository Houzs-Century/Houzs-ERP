// MobileMailCenter — mail client (list / thread / compose). Maps to prototype: #m-mail.
import { useState } from 'react';

export interface MailThread { id: string; from_name: string; subject: string; snippet: string; received_at: string; label?: string; unread?: boolean; body?: string; }

export function MobileMailCenter({ threads, onOpenMenu }: { threads: MailThread[]; onOpenMenu: () => void }) {
  const [view, setView] = useState<'list' | 'thread' | 'compose'>('list');
  const [cur, setCur] = useState<MailThread | null>(null);
  const [folder, setFolder] = useState('Inbox');
  const folders = ['Inbox', 'Starred', 'Sent', 'Drafts', 'Archive'];

  if (view === 'thread' && cur) return (
    <div className="hz-m screen">
      <header className="hdr">
        <button onClick={() => setView('list')} style={{ background: 'none', border: 'none', color: '#16695f', fontWeight: 600, fontSize: 12.5, cursor: 'pointer' }}>&lsaquo; {folder}</button>
        <div className="scr-title" style={{ fontSize: 17, marginTop: 6 }}>{cur.subject}</div>
        <div style={{ fontSize: 11.5, color: '#767b6e', marginTop: 3 }}>{cur.from_name} · {cur.received_at}</div>
      </header>
      <div className="scroll"><div className="card"><div className="card-b" style={{ fontSize: 13, lineHeight: 1.6, color: '#414539' }}>{cur.body ?? cur.snippet}</div></div></div>
      <div className="actbar">
        <button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => setView('compose')}>Reply</button>
        <button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => setView('compose')}>Forward</button>
      </div>
    </div>
  );

  if (view === 'compose') return (
    <div className="hz-m screen">
      <header className="hdr"><button onClick={() => setView('list')} style={{ background: 'none', border: 'none', color: '#767b6e', fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>Cancel</button><div className="scr-title">Compose</div></header>
      <div className="scroll">
        <div className="fld"><span className="fld-l">To</span><input className="fld-i" placeholder="name@houzscentury.com" /></div>
        <div className="fld"><span className="fld-l">Subject</span><input className="fld-i" defaultValue={cur ? 'Re: ' + cur.subject : ''} /></div>
        <div className="fld"><span className="fld-l">Message</span><textarea className="fld-i" rows={8} style={{ resize: 'none' }} /></div>
      </div>
      <div className="actbar"><button className="btn">Send</button></div>
    </div>
  );

  return (
    <div className="hz-m screen">
      <header className="hdr">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div><div className="eyebrow">Comms</div><div className="scr-title">Mail Center</div></div>
          <button onClick={onOpenMenu} style={{ background: 'none', border: 'none', color: '#16695f', cursor: 'pointer' }}><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#16695f" strokeWidth="2" strokeLinecap="round"><path d="M3 6h18M3 12h18M3 18h18" /></svg></button>
        </div>
        <div className="chips" style={{ marginTop: 10, display: 'flex', gap: 7, overflowX: 'auto' }}>
          {folders.map((f) => <button key={f} className={'chip' + (folder === f ? ' on' : '')} onClick={() => setFolder(f)}>{f}</button>)}
        </div>
      </header>
      <div className="scroll">
        {threads.map((t) => (
          <div key={t.id} className="card" style={{ padding: '11px 13px', display: 'flex', gap: 10, cursor: 'pointer' }} onClick={() => { setCur(t); setView('thread'); }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: t.unread ? '#16695f' : 'transparent', flex: 'none', marginTop: 6 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}><span style={{ fontSize: 13, fontWeight: 700, color: '#11140f', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.from_name}</span><span className="money" style={{ fontSize: 10.5, color: '#9aa093', whiteSpace: 'nowrap' }}>{t.received_at}</span></div>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: '#11140f', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.subject}</div>
              <div style={{ fontSize: 11.5, color: '#767b6e', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.snippet}</div>
              {t.label && <span style={{ display: 'inline-block', fontSize: 9, fontWeight: 700, padding: '2px 7px', borderRadius: 5, background: '#e1efed', color: '#0c3f39', marginTop: 6 }}>{t.label}</span>}
            </div>
          </div>
        ))}
      </div>
      <button onClick={() => { setCur(null); setView('compose'); }} style={{ position: 'absolute', right: 16, bottom: 16, width: 52, height: 52, borderRadius: '50%', background: '#16695f', border: 'none', color: '#fff', fontSize: 26, boxShadow: '0 12px 26px -10px rgba(17,24,16,.5)', cursor: 'pointer' }}>+</button>
    </div>
  );
}
