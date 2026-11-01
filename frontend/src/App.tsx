/**
 * Smart Gate Keeper — single-file React (TypeScript) prototype.
 *
 * npm i react react-dom qrcode.react html5-qrcode lucide-react
 * Tailwind CSS must be enabled in the host project.
 *
 * Backend: if the FastAPI server (main.py) is reachable at VITE_API_URL
 * (default http://localhost:8000) it is used. Otherwise the app transparently
 * falls back to an in-browser mock engine (localStorage) so the demo always works.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Html5Qrcode } from 'html5-qrcode';
import {
  QrCode, ScanLine, LayoutDashboard, ShieldCheck, ShieldX, Users, LogIn, LogOut,
  ShieldAlert, Search, Timer, Camera, CameraOff, Keyboard, RefreshCw, Wifi, WifiOff,
  Sparkles, Play, Bug,
} from 'lucide-react';

/* ============================== Types ============================== */
type Tab = 'pass' | 'scanner' | 'admin';
type PassType = 'Student Daily' | 'Visitor Pre-Approved';

interface PassPayload { usn: string; timestamp: number; pass_id: string; secret_token: string }
interface IssuedPass {
  pass_id: string; name: string; usn: string; department: string; pass_type: PassType;
  issued_at: number; expires_at: number; payload: PassPayload;
}
interface LogEntry {
  id: number; usn: string; name: string; pass_type: string; direction: 'IN' | 'OUT' | '—';
  timestamp: string; gate: number; status: 'Granted' | 'Denied'; reason: string;
}
interface Stats { inside: number; check_ins_today: number; check_outs_today: number; failed_scans: number }
interface VerifyReq { qr_payload?: string; usn?: string; gate: number }
interface VerifyResult {
  granted: boolean; message: string; reason: string; direction: LogEntry['direction'];
  user: { name: string; usn: string; department: string; pass_type: string } | null;
  log: LogEntry;
}

const PASS_TTL_SEC = 15 * 60;
const DEPARTMENTS = ['Computer Science', 'Electronics', 'Mechanical', 'Civil', 'Business Administration', 'Visitor / External'];
const PASS_TYPES: PassType[] = ['Student Daily', 'Visitor Pre-Approved'];

/* ====================== Mock engine (offline fallback) ====================== */
const MOCK_KEY = 'sgk_mock_db_v1';
const MOCK_SECRET = 'sgk-demo-secret'; // demo only — real signing happens server-side in main.py

interface MockUser { usn: string; name: string; department: string; pass_type: PassType; active_pass_id: string; active_pass_ts: number }
interface MockDB { users: Record<string, MockUser>; logs: LogEntry[]; seq: number }

const mockHash = (s: string): string => {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
};
const mockSign = (usn: string, pid: string, ts: number) => mockHash(`${MOCK_SECRET}|${usn}|${pid}|${ts}`);
const loadDB = (): MockDB => {
  try { const r = localStorage.getItem(MOCK_KEY); if (r) return JSON.parse(r); } catch { /* ignore */ }
  return { users: {}, logs: [], seq: 0 };
};
const saveDB = (db: MockDB) => { try { localStorage.setItem(MOCK_KEY, JSON.stringify(db)); } catch { /* ignore */ } };
const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
const randHex = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');

const mock = {
  generate(b: { name: string; usn: string; department: string; pass_type: PassType }): IssuedPass {
    const db = loadDB();
    const usn = b.usn.trim().toUpperCase();
    const pass_id = randHex(16);
    const ts = Math.floor(Date.now() / 1000);
    db.users[usn] = { usn, name: b.name, department: b.department, pass_type: b.pass_type, active_pass_id: pass_id, active_pass_ts: ts };
    saveDB(db);
    return {
      pass_id, name: b.name, usn, department: b.department, pass_type: b.pass_type,
      issued_at: ts, expires_at: ts + PASS_TTL_SEC,
      payload: { usn, timestamp: ts, pass_id, secret_token: mockSign(usn, pass_id, ts) },
    };
  },
  verify(req: VerifyReq): VerifyResult {
    const db = loadDB();
    const now = Math.floor(Date.now() / 1000);
    let usn = 'UNKNOWN';
    let user: MockUser | undefined;
    let deny: string | null = null;

    if (req.qr_payload) {
      let p: any = null;
      try { p = JSON.parse(req.qr_payload); } catch { /* malformed */ }
      if (!p || !p.usn || !p.pass_id || !p.timestamp || !p.secret_token) deny = 'Malformed QR code';
      else {
        usn = String(p.usn).trim().toUpperCase();
        user = db.users[usn];
        if (mockSign(p.usn, p.pass_id, p.timestamp) !== p.secret_token) deny = 'Invalid signature';
        else if (now - p.timestamp > PASS_TTL_SEC) deny = 'Pass expired';
        else if (p.timestamp - now > 30) deny = 'Pass timestamp in the future';
        else if (!user) deny = 'Unknown user';
        else if (user.active_pass_id !== p.pass_id) deny = 'Pass superseded by a newer one';
      }
    } else if (req.usn) {
      usn = req.usn.trim().toUpperCase();
      user = db.users[usn];
      if (!user) deny = 'USN not registered';
      else if (now - user.active_pass_ts > PASS_TTL_SEC) deny = 'No active pass (expired)';
    } else deny = 'Empty scan';

    let direction: LogEntry['direction'] = '—';
    if (!deny && user) {
      const last = db.logs.find(l => l.usn === usn && l.status === 'Granted');
      direction = last?.direction === 'IN' ? 'OUT' : 'IN';
    }
    const log: LogEntry = {
      id: ++db.seq, usn, name: user?.name ?? 'Unknown', pass_type: user?.pass_type ?? '-',
      direction, timestamp: new Date().toISOString(), gate: req.gate,
      status: deny ? 'Denied' : 'Granted', reason: deny ?? 'Verified',
    };
    db.logs.unshift(log);
    db.logs = db.logs.slice(0, 500);
    saveDB(db);

    const kind = user?.pass_type.startsWith('Visitor') ? 'Visitor' : 'Student';
    return {
      granted: !deny,
      message: deny ? 'ACCESS DENIED - Pass Expired or Invalid' : `ACCESS GRANTED - ${kind} Verified`,
      reason: log.reason, direction,
      user: user ? { name: user.name, usn: user.usn, department: user.department, pass_type: user.pass_type } : null,
      log,
    };
  },
  logs(q: string, limit: number): LogEntry[] {
    const s = q.trim().toLowerCase();
    return loadDB().logs
      .filter(l => !s || l.usn.toLowerCase().includes(s) || l.name.toLowerCase().includes(s))
      .slice(0, limit);
  },
  stats(): Stats {
    const db = loadDB();
    const t0 = startOfToday();
    const today = db.logs.filter(l => new Date(l.timestamp).getTime() >= t0);
    const lastByUser = new Map<string, LogEntry>();
    for (const l of db.logs) if (l.status === 'Granted' && !lastByUser.has(l.usn)) lastByUser.set(l.usn, l);
    return {
      inside: [...lastByUser.values()].filter(l => l.direction === 'IN').length,
      check_ins_today: today.filter(l => l.status === 'Granted' && l.direction === 'IN').length,
      check_outs_today: today.filter(l => l.status === 'Granted' && l.direction === 'OUT').length,
      failed_scans: today.filter(l => l.status === 'Denied').length,
    };
  },
};

/* ============================ API layer ============================ */
const API_BASE: string = (import.meta as any).env?.VITE_API_URL || 'http://localhost:8000';
let apiSource: 'api' | 'mock' = 'mock';

class HttpError extends Error {}

async function call<T>(path: string, init: RequestInit | undefined, fallback: () => T): Promise<T> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    const r = await fetch(API_BASE + path, {
      ...init, headers: { 'Content-Type': 'application/json' }, signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!r.ok) throw new HttpError(String(r.status));
    apiSource = 'api';
    return (await r.json()) as T;
  } catch (e) {
    if (e instanceof HttpError) throw e; // real server rejected the request: surface it
    apiSource = 'mock'; // network failure: use offline mock
    return fallback();
  }
}

const api = {
  generate: (b: { name: string; usn: string; department: string; pass_type: PassType }) =>
    call<IssuedPass>('/api/pass/generate', { method: 'POST', body: JSON.stringify(b) }, () => mock.generate(b)),
  verify: (b: VerifyReq) =>
    call<VerifyResult>('/api/pass/verify', { method: 'POST', body: JSON.stringify(b) }, () => mock.verify(b)),
  logs: (q: string, limit = 200) =>
    call<LogEntry[]>(`/api/logs?q=${encodeURIComponent(q)}&limit=${limit}`, undefined, () => mock.logs(q, limit)),
  stats: () => call<Stats>('/api/stats/campus-count', undefined, () => mock.stats()),
};

/* ============================== Helpers ============================== */
function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
const fmtClock = (secs: number) => {
  const s = Math.max(0, Math.ceil(secs));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
const fmtTime = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

const card = 'rounded-2xl border border-slate-700 bg-slate-800/60 backdrop-blur shadow-xl';
const input =
  'w-full rounded-xl border border-slate-600 bg-slate-900/70 px-4 py-2.5 text-slate-100 placeholder-slate-500 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/30';
const btnPrimary =
  'inline-flex items-center justify-center gap-2 rounded-xl bg-[#4F46E5] px-5 py-2.5 font-semibold text-white shadow-lg shadow-indigo-900/40 transition hover:bg-indigo-500 active:scale-[.98] disabled:cursor-not-allowed disabled:opacity-50';
const btnGhost =
  'inline-flex items-center justify-center gap-2 rounded-xl border border-slate-600 bg-slate-800 px-4 py-2 text-sm font-medium text-slate-200 transition hover:border-slate-500 hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40';

/* ============================ Pass module ============================ */
function PassModule({ pass, setPass }: { pass: IssuedPass | null; setPass: (p: IssuedPass) => void }) {
  const [form, setForm] = useState({ name: '', usn: '', department: DEPARTMENTS[0], pass_type: 'Student Daily' as PassType });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const now = useNow();

  const remaining = pass ? Math.max(0, pass.expires_at - now / 1000) : 0;
  const expired = !!pass && remaining <= 0;
  const pct = pass ? (remaining / PASS_TTL_SEC) * 100 : 0;
  const barColor = remaining > 300 ? 'bg-emerald-500' : remaining > 60 ? 'bg-amber-500' : 'bg-rose-500';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim() || !form.usn.trim()) { setErr('Name and Roll Number / USN are required.'); return; }
    setErr(''); setBusy(true);
    try {
      setPass(await api.generate({ ...form, name: form.name.trim(), usn: form.usn.trim().toUpperCase() }));
    } catch { setErr('Could not generate the pass. Please try again.'); }
    finally { setBusy(false); }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <form onSubmit={submit} className={`${card} space-y-5 p-6`}>
        <div>
          <h2 className="text-xl font-bold text-white">Generate Pass</h2>
          <p className="mt-1 text-sm text-slate-400">Passes are valid for 15 minutes and are tied to one person.</p>
        </div>

        <label className="block space-y-1.5">
          <span className="text-sm font-medium text-slate-300">Full name</span>
          <input className={input} placeholder="e.g. Ananya Rao" value={form.name}
            onChange={e => setForm({ ...form, name: e.target.value })} />
        </label>
        <label className="block space-y-1.5">
          <span className="text-sm font-medium text-slate-300">Roll Number / USN</span>
          <input className={`${input} uppercase`} placeholder="e.g. 1MS22CS042" value={form.usn}
            onChange={e => setForm({ ...form, usn: e.target.value })} />
        </label>
        <label className="block space-y-1.5">
          <span className="text-sm font-medium text-slate-300">Department</span>
          <select className={input} value={form.department} onChange={e => setForm({ ...form, department: e.target.value })}>
            {DEPARTMENTS.map(d => <option key={d}>{d}</option>)}
          </select>
        </label>
        <div className="space-y-1.5">
          <span className="text-sm font-medium text-slate-300">Pass type</span>
          <div className="grid grid-cols-2 gap-2">
            {PASS_TYPES.map(t => (
              <button type="button" key={t} onClick={() => setForm({ ...form, pass_type: t })}
                className={`rounded-xl border px-3 py-2.5 text-sm font-medium transition ${
                  form.pass_type === t
                    ? 'border-indigo-500 bg-indigo-500/15 text-indigo-200'
                    : 'border-slate-600 bg-slate-900/50 text-slate-400 hover:border-slate-500'}`}>
                {t}
              </button>
            ))}
          </div>
        </div>

        {err && <p className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-300">{err}</p>}
        <button className={`${btnPrimary} w-full`} disabled={busy}>
          {busy ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
          Generate Dynamic Pass
        </button>
      </form>

      <div className="flex items-start justify-center">
        {!pass ? (
          <div className={`${card} flex h-full min-h-[360px] w-full flex-col items-center justify-center gap-3 border-dashed p-8 text-center`}>
            <QrCode className="h-14 w-14 text-slate-600" />
            <p className="text-slate-400">Your pass will appear here.</p>
          </div>
        ) : (
          <div className="w-full max-w-sm overflow-hidden rounded-3xl bg-white text-slate-900 shadow-2xl shadow-black/40">
            <div className="bg-gradient-to-r from-[#4F46E5] to-indigo-400 px-6 py-4 text-white">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-widest opacity-90">Smart Gate Keeper</span>
                <span className="rounded-full bg-white/20 px-2.5 py-0.5 text-xs font-semibold">{pass.pass_type}</span>
              </div>
              <h3 className="mt-2 text-2xl font-bold leading-tight">{pass.name}</h3>
              <p className="text-sm opacity-90">{pass.usn} · {pass.department}</p>
            </div>

            <div className="flex flex-col items-center px-6 py-6">
              <div className="relative rounded-2xl border border-slate-200 p-3">
                <QRCodeSVG value={JSON.stringify(pass.payload)} size={208} level="M" />
                {expired && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 rounded-2xl bg-white/90 backdrop-blur-sm">
                    <ShieldX className="h-10 w-10 text-[#F43F5E]" />
                    <span className="font-bold text-[#F43F5E]">PASS EXPIRED</span>
                  </div>
                )}
              </div>

              <div className="mt-5 w-full">
                <div className="mb-1.5 flex items-center justify-between text-sm">
                  <span className="flex items-center gap-1.5 font-medium text-slate-500"><Timer className="h-4 w-4" /> Valid for</span>
                  <span className={`font-mono text-lg font-bold ${expired ? 'text-[#F43F5E]' : 'text-slate-900'}`}>{fmtClock(remaining)}</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-slate-200">
                  <div className={`h-full rounded-full transition-all duration-1000 ease-linear ${barColor}`} style={{ width: `${pct}%` }} />
                </div>
              </div>
              <p className="mt-4 font-mono text-[11px] text-slate-400">PASS · {pass.pass_id}</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ========================= Result overlay (modal) ========================= */
function ResultOverlay({ result, onClose }: { result: VerifyResult; onClose: () => void }) {
  const ok = result.granted;
  return (
    <div className={`fixed inset-0 z-50 flex items-center justify-center p-4 backdrop-blur-sm ${ok ? 'bg-emerald-950/80' : 'bg-rose-950/80'}`}
      onClick={onClose} role="dialog" aria-live="assertive">
      <style>{`
        @keyframes sgk-pop{0%{transform:scale(.8);opacity:0}100%{transform:scale(1);opacity:1}}
        @keyframes sgk-shrink{from{width:100%}to{width:0}}
      `}</style>
      <div className="w-full max-w-md overflow-hidden rounded-3xl bg-slate-900 text-center shadow-2xl"
        style={{ animation: 'sgk-pop .25s ease-out', border: `2px solid ${ok ? '#10B981' : '#F43F5E'}` }}
        onClick={e => e.stopPropagation()}>
        <div className={`px-8 pb-6 pt-10 ${ok ? 'bg-emerald-500/10' : 'bg-rose-500/10'}`}>
          <div className={`mx-auto flex h-24 w-24 items-center justify-center rounded-full ${ok ? 'bg-[#10B981]' : 'bg-[#F43F5E]'} shadow-lg`}>
            {ok ? <ShieldCheck className="h-14 w-14 text-white" /> : <ShieldX className="h-14 w-14 text-white" />}
          </div>
          <h2 className={`mt-5 text-3xl font-extrabold tracking-tight ${ok ? 'text-[#10B981]' : 'text-[#F43F5E]'}`}>
            {ok ? 'ACCESS GRANTED' : 'ACCESS DENIED'}
          </h2>
          <p className="mt-1 text-lg font-medium text-slate-200">
            {ok ? result.message.replace('ACCESS GRANTED - ', '') : 'Pass Expired or Invalid'}
          </p>
        </div>

        <div className="space-y-2 px-8 py-5 text-sm">
          {ok && result.user ? (
            <>
              <p className="text-xl font-bold text-white">{result.user.name}</p>
              <p className="text-slate-400">{result.user.usn} · {result.user.department}</p>
              <span className={`mt-2 inline-flex items-center gap-1.5 rounded-full px-3 py-1 font-semibold ${
                result.direction === 'IN' ? 'bg-emerald-500/15 text-emerald-300' : 'bg-sky-500/15 text-sky-300'}`}>
                {result.direction === 'IN' ? <LogIn className="h-4 w-4" /> : <LogOut className="h-4 w-4" />}
                {result.direction === 'IN' ? 'CHECKED IN' : 'CHECKED OUT'} · Gate {result.log.gate}
              </span>
            </>
          ) : (
            <p className="text-slate-300">Reason: <span className="font-semibold text-rose-300">{result.reason}</span></p>
          )}
        </div>
        <div className="h-1.5 bg-slate-800">
          <div className={`h-full ${ok ? 'bg-[#10B981]' : 'bg-[#F43F5E]'}`} style={{ animation: 'sgk-shrink 3s linear forwards' }} />
        </div>
      </div>
    </div>
  );
}

/* ============================ Scanner module ============================ */
function ScannerModule({ lastPass, onVerified }: { lastPass: IssuedPass | null; onVerified: () => void }) {
  const [gate, setGate] = useState(1);
  const [cameraOn, setCameraOn] = useState(true);
  const [camState, setCamState] = useState<'starting' | 'live' | 'denied'>('starting');
  const [manual, setManual] = useState('');
  const [result, setResult] = useState<VerifyResult | null>(null);

  const busy = useRef(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout>>();
  const gateRef = useRef(gate);
  gateRef.current = gate;

  const dismiss = useCallback(() => {
    clearTimeout(closeTimer.current);
    setResult(null);
    busy.current = false;
  }, []);

  const verify = useCallback(async (req: Omit<VerifyReq, 'gate'>) => {
    if (busy.current) return;
    busy.current = true;
    try {
      const res = await api.verify({ ...req, gate: gateRef.current });
      setResult(res);
      onVerified();
      closeTimer.current = setTimeout(dismiss, 3000);
    } catch {
      busy.current = false;
    }
  }, [dismiss, onVerified]);

  const verifyRef = useRef(verify);
  verifyRef.current = verify;

  // Webcam scanning via html5-qrcode
  useEffect(() => {
    if (!cameraOn) return;
    setCamState('starting');
    const scanner = new Html5Qrcode('sgk-qr-reader');
    let cancelled = false;
    let running = false;

    scanner
      .start({ facingMode: 'environment' }, { fps: 10, qrbox: { width: 240, height: 240 } },
        text => verifyRef.current({ qr_payload: text }), () => { /* per-frame misses are normal */ })
      .then(() => {
        running = true;
        if (cancelled) scanner.stop().then(() => scanner.clear()).catch(() => {});
        else setCamState('live');
      })
      .catch(() => { if (!cancelled) { setCamState('denied'); setCameraOn(false); } });

    return () => {
      cancelled = true;
      if (running) scanner.stop().then(() => scanner.clear()).catch(() => {});
    };
  }, [cameraOn]);

  useEffect(() => () => clearTimeout(closeTimer.current), []);

  const simulateValid = () => lastPass && verify({ qr_payload: JSON.stringify(lastPass.payload) });
  const simulateForged = () => lastPass &&
    verify({ qr_payload: JSON.stringify({ ...lastPass.payload, secret_token: 'forged' + lastPass.payload.secret_token.slice(6) }) });

  return (
    <div className="grid gap-6 lg:grid-cols-5">
      <div className={`${card} p-6 lg:col-span-3`}>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-xl font-bold text-white">Scan &amp; Verify</h2>
            <p className="text-sm text-slate-400">Hold the QR pass in front of the camera.</p>
          </div>
          <div className="flex items-center gap-2">
            <select className={`${input} !w-auto !py-2`} value={gate} onChange={e => setGate(Number(e.target.value))} aria-label="Gate number">
              {[1, 2, 3, 4].map(g => <option key={g} value={g}>Gate {g}</option>)}
            </select>
            <button className={btnGhost} onClick={() => setCameraOn(v => !v)}>
              {cameraOn ? <CameraOff className="h-4 w-4" /> : <Camera className="h-4 w-4" />}
              {cameraOn ? 'Stop' : 'Start'}
            </button>
          </div>
        </div>

        <div className="relative aspect-video overflow-hidden rounded-2xl border border-slate-700 bg-black">
          <div id="sgk-qr-reader" className="h-full w-full [&_video]:h-full [&_video]:w-full [&_video]:object-cover" />
          {camState !== 'live' && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-slate-950/90 p-6 text-center">
              {camState === 'starting' && cameraOn ? (
                <><RefreshCw className="h-8 w-8 animate-spin text-indigo-400" /><p className="text-slate-300">Starting camera…</p></>
              ) : (
                <>
                  <CameraOff className="h-9 w-9 text-slate-500" />
                  <p className="text-slate-300">
                    {camState === 'denied' ? 'Camera unavailable or permission denied.' : 'Camera is off.'}
                  </p>
                  <p className="text-sm text-slate-500">Use manual entry or the simulator below.</p>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="space-y-6 lg:col-span-2">
        <form className={`${card} space-y-3 p-6`} onSubmit={e => { e.preventDefault(); if (manual.trim()) { verify({ usn: manual }); setManual(''); } }}>
          <h3 className="flex items-center gap-2 font-semibold text-white"><Keyboard className="h-4 w-4 text-indigo-400" /> Manual USN entry</h3>
          <input className={`${input} uppercase`} placeholder="Enter USN" value={manual} onChange={e => setManual(e.target.value)} />
          <button className={`${btnPrimary} w-full`} disabled={!manual.trim()}>Verify</button>
          <p className="text-xs text-slate-500">Works only if the person has an unexpired pass.</p>
        </form>

        <div className={`${card} space-y-3 p-6`}>
          <h3 className="flex items-center gap-2 font-semibold text-white"><Play className="h-4 w-4 text-indigo-400" /> Scan simulator</h3>
          <p className="text-xs text-slate-400">
            {lastPass ? <>Uses the latest pass for <b className="text-slate-200">{lastPass.usn}</b>. After 15 min it should be denied.</>
              : 'Generate a pass first, then simulate scanning it here.'}
          </p>
          <div className="grid grid-cols-2 gap-2">
            <button className={btnGhost} disabled={!lastPass} onClick={simulateValid}><ScanLine className="h-4 w-4" /> Scan pass</button>
            <button className={btnGhost} disabled={!lastPass} onClick={simulateForged}><Bug className="h-4 w-4" /> Forged QR</button>
          </div>
        </div>
      </div>

      {result && <ResultOverlay result={result} onClose={dismiss} />}
    </div>
  );
}

/* ============================== Admin module ============================== */
function Kpi({ icon: Icon, label, value, tone }: { icon: React.ElementType; label: string; value: number; tone: string }) {
  return (
    <div className={`${card} flex items-center gap-4 p-5`}>
      <div className={`flex h-12 w-12 items-center justify-center rounded-xl ${tone}`}><Icon className="h-6 w-6" /></div>
      <div>
        <p className="text-3xl font-extrabold tabular-nums text-white">{value}</p>
        <p className="text-sm text-slate-400">{label}</p>
      </div>
    </div>
  );
}

function AdminModule({ stats, logs }: { stats: Stats; logs: LogEntry[] }) {
  const [q, setQ] = useState('');
  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? logs.filter(l => [l.usn, l.name, String(l.id), l.pass_type].some(v => v.toLowerCase().includes(s))) : logs;
  }, [logs, q]);

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi icon={Users} label="On campus now (live)" value={stats.inside} tone="bg-indigo-500/15 text-indigo-300" />
        <Kpi icon={LogIn} label="Check-ins today" value={stats.check_ins_today} tone="bg-emerald-500/15 text-[#10B981]" />
        <Kpi icon={LogOut} label="Check-outs today" value={stats.check_outs_today} tone="bg-sky-500/15 text-sky-300" />
        <Kpi icon={ShieldAlert} label="Failed security scans" value={stats.failed_scans} tone="bg-rose-500/15 text-[#F43F5E]" />
      </div>

      <div className={`${card} overflow-hidden`}>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-700 p-5">
          <h2 className="text-lg font-bold text-white">Real-Time Access Log</h2>
          <div className="relative w-full sm:w-72">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
            <input className={`${input} !pl-9`} placeholder="Search USN, name or log ID" value={q} onChange={e => setQ(e.target.value)} />
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="bg-slate-900/60 text-xs uppercase tracking-wider text-slate-400">
              <tr>
                {['Log ID', 'USN / Name', 'Pass Type', 'Check-in Time', 'Gate', 'Status'].map(h => <th key={h} className="px-5 py-3 font-semibold">{h}</th>)}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700/60">
              {rows.length === 0 && (
                <tr><td colSpan={6} className="px-5 py-12 text-center text-slate-500">No scans recorded yet.</td></tr>
              )}
              {rows.map(l => (
                <tr key={l.id} className="text-slate-200 transition hover:bg-slate-700/30">
                  <td className="px-5 py-3 font-mono text-slate-400">#{String(l.id).padStart(4, '0')}</td>
                  <td className="px-5 py-3"><p className="font-semibold text-white">{l.name}</p><p className="text-xs text-slate-400">{l.usn}</p></td>
                  <td className="px-5 py-3">{l.pass_type}</td>
                  <td className="px-5 py-3">
                    <span className="font-mono">{fmtTime(l.timestamp)}</span>
                    {l.direction !== '—' && (
                      <span className={`ml-2 rounded px-1.5 py-0.5 text-[10px] font-bold ${l.direction === 'IN' ? 'bg-emerald-500/15 text-emerald-300' : 'bg-sky-500/15 text-sky-300'}`}>{l.direction}</span>
                    )}
                  </td>
                  <td className="px-5 py-3">Gate {l.gate}</td>
                  <td className="px-5 py-3">
                    <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-bold ${l.status === 'Granted' ? 'bg-emerald-500/15 text-[#10B981]' : 'bg-rose-500/15 text-[#F43F5E]'}`}>{l.status}</span>
                    {l.status === 'Denied' && <p className="mt-1 text-[11px] text-slate-500">{l.reason}</p>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/* ================================= App ================================= */
export default function App() {
  const [tab, setTab] = useState<Tab>('pass');
  const [pass, setPass] = useState<IssuedPass | null>(null);
  const [stats, setStats] = useState<Stats>({ inside: 0, check_ins_today: 0, check_outs_today: 0, failed_scans: 0 });
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [source, setSource] = useState<'api' | 'mock'>('mock');

  const refresh = useCallback(async () => {
    try {
      const [s, l] = await Promise.all([api.stats(), api.logs('', 200)]);
      setStats(s); setLogs(l); setSource(apiSource);
    } catch { /* keep previous data */ }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [refresh]);

  const tabs: { id: Tab; label: string; icon: React.ElementType }[] = [
    { id: 'pass', label: 'Student Pass', icon: QrCode },
    { id: 'scanner', label: 'Security Gate Scanner', icon: ScanLine },
    { id: 'admin', label: 'Admin Live Log', icon: LayoutDashboard },
  ];

  return (
    <div className="min-h-screen bg-[#0F172A] font-sans text-slate-100 antialiased" style={{ fontFamily: 'Inter, system-ui, sans-serif' }}>
      <header className="sticky top-0 z-40 border-b border-slate-800 bg-[#0F172A]/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#4F46E5] shadow-lg shadow-indigo-900/50">
              <ShieldCheck className="h-6 w-6 text-white" />
            </div>
            <div>
              <h1 className="text-lg font-extrabold leading-tight tracking-tight">Smart Gate Keeper</h1>
              <p className="text-xs text-slate-400">Campus access &amp; visitor management</p>
            </div>
          </div>

          <nav className="order-3 flex w-full gap-1 rounded-2xl border border-slate-700 bg-slate-800/60 p-1 md:order-none md:w-auto">
            {tabs.map(({ id, label, icon: Icon }) => (
              <button key={id} onClick={() => setTab(id)}
                className={`flex flex-1 items-center justify-center gap-2 whitespace-nowrap rounded-xl px-3 py-2 text-sm font-semibold transition md:flex-none ${
                  tab === id ? 'bg-[#4F46E5] text-white shadow' : 'text-slate-400 hover:text-slate-200'}`}>
                <Icon className="h-4 w-4" /><span className="hidden sm:inline">{label}</span>
              </button>
            ))}
          </nav>

          <div className="flex items-center gap-2 text-xs">
            <span className="rounded-full border border-slate-700 bg-slate-800 px-3 py-1.5 font-semibold text-slate-200">
              <Users className="mr-1 inline h-3.5 w-3.5 text-indigo-300" />{stats.inside} on campus
            </span>
            <span className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 font-semibold ${
              source === 'api' ? 'bg-emerald-500/15 text-emerald-300' : 'bg-amber-500/15 text-amber-300'}`}
              title={source === 'api' ? `Connected to ${API_BASE}` : 'Backend unreachable — using in-browser demo data'}>
              {source === 'api' ? <Wifi className="h-3.5 w-3.5" /> : <WifiOff className="h-3.5 w-3.5" />}
              {source === 'api' ? 'API live' : 'Demo mode'}
            </span>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-8">
        {tab === 'pass' && <PassModule pass={pass} setPass={setPass} />}
        {tab === 'scanner' && <ScannerModule lastPass={pass} onVerified={refresh} />}
        {tab === 'admin' && <AdminModule stats={stats} logs={logs} />}
      </main>
    </div>
  );
}
