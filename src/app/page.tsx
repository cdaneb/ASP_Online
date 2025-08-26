'use client';
import React, { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { createClient } from "@supabase/supabase-js";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AlertTriangle, Clock, LogIn, LogOut, Medal, Shield, Trophy } from "lucide-react";

/**
 * ASP (Athena’s Study Parthenon) front-end
 * - Supabase optional (NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY)
 * - Sign-in only during Mon/Wed 19:30–21:30 ET (client guard)
 * - Live HH:MM:SS timer while signed in
 * - Auto sign-out at 2 hours (client) + server-side at 21:30 ET
 * - Leaderboard = sum of minutes capped to ASP window (via RPC)
 * - Admin: force sign-out, remove entry (void), reset, and EDIT sessions
 *
 * Admin guard: NEXT_PUBLIC_ASP_ADMIN_KEY (client-side).
 */

// ---------- Config / helpers ----------
const TZ = "America/New_York";
const TWO_HOURS_SEC = 2 * 60 * 60;

function nyNow() { return new Date(); }

function isAspOpen(date = nyNow()) {
  // ASP hours: Monday & Wednesday 19:30–21:30 ET
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false });
  const parts = fmt.formatToParts(date).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {} as Record<string,string>);
  const weekday = (parts.weekday || "").toLowerCase();
  const hour = parseInt(parts.hour || "0", 10);
  const minute = parseInt(parts.minute || "0", 10);
  const isMon = weekday.startsWith("mon");
  const isWed = weekday.startsWith("wed");
  const minutes = hour * 60 + minute;
  const start = 19 * 60 + 30;
  const end = 21 * 60 + 30;
  return (isMon || isWed) && minutes >= start && minutes < end;
}

function pad2(n: number) { return n.toString().padStart(2, '0'); }
function formatHMS(totalSeconds: number) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
}

function formatHM(totalMinutes: number) {
  const h = Math.floor(totalMinutes / 60);
  const m = Math.floor(totalMinutes % 60);
  return `${h}h ${m}m`;
}

function msToMin(ms: number) { return Math.max(0, Math.floor(ms / 60000)); }

// datetime-local helpers (use user’s local zone for inputs)
function isoToLocalInput(iso: string) {
  const d = new Date(iso);
  const y = d.getFullYear();
  const m = pad2(d.getMonth() + 1);
  const da = pad2(d.getDate());
  const h = pad2(d.getHours());
  const mi = pad2(d.getMinutes());
  return `${y}-${m}-${da}T${h}:${mi}`;
}
function localInputToIso(val: string) {
  return new Date(val).toISOString();
}

// ---------- Supabase client ----------
declare global {
  interface Window {
    env?: {
      NEXT_PUBLIC_SUPABASE_URL?: string;
      NEXT_PUBLIC_SUPABASE_ANON_KEY?: string;
      NEXT_PUBLIC_ASP_ADMIN_KEY?: string;
    };
  }
}

const supabaseUrl =
  typeof window !== "undefined"
    ? (window as Window).env?.NEXT_PUBLIC_SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL
    : process.env.NEXT_PUBLIC_SUPABASE_URL;

const supabaseKey =
  typeof window !== "undefined"
    ? (window as Window).env?.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    : process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

const hasSupabase = !!(supabaseUrl && supabaseKey);
const supabase = hasSupabase ? createClient(supabaseUrl!, supabaseKey!) : null;

// ---------- Types ----------
type Klass = '1C' | '2C' | '3C' | '4C';
const ALL_KLASSES: Klass[] = ['1C','2C','3C','4C'];
const TABS: Array<'all' | Klass> = ['all', ...ALL_KLASSES];

interface LeaderboardRow {
  name: string;
  klass: Klass;
  company: string;
  total_min: number; // from the RPC
}
interface ActiveRow {
  id: string;
  cadet_id: string;
  sign_in: string;
  sign_out: string | null;
  voided?: boolean;
  cadets: { id: string; name: string; klass: Klass; company: string };
}
export type Cadet = {
  id: string;
  name: string;
  klass: Klass;
  company: string;
  created_at?: string;
};
export type Session = {
  id: string;
  cadet_id: string;
  sign_in: string;          // ISO
  sign_out: string | null;  // ISO
  voided?: boolean;
};

// LocalStorage keys
const LS_CADET = "asp_current_cadet";
const LS_ACTIVE_SESSION = "asp_active_session";
const LS_SESSIONS = "asp_sessions"; // local demo history

function errMsg(e: unknown) { return e instanceof Error ? e.message : String(e); }

// ---------- Component ----------
export default function ASPApp() {
  const [cadet, setCadet] = useState<Cadet | null>(null);
  const [klass, setKlass] = useState<Klass | 'none'>("none");
  const [name, setName] = useState("");
  const [company, setCompany] = useState("G1");
  const [activeSession, setActiveSession] = useState<Session | null>(null);
  const [leaderboard, setLeaderboard] = useState<Array<{name:string; klass:Klass; company:string; totalMin:number}>>([]);
  const [adminMode, setAdminMode] = useState(false);
  const [adminKey, setAdminKey] = useState("");
  const [allActive, setAllActive] = useState<Array<{session: Session; cadet: Cadet}>>([]);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [nowTs, setNowTs] = useState<number>(Date.now());

  // Admin edit UI state
  const [editCadet, setEditCadet] = useState<Cadet | null>(null);
  const [editSessions, setEditSessions] = useState<Session[]>([]);
  const [editDraft, setEditDraft] = useState<Record<string, {sign_in: string; sign_out: string | null}>>({});
  const [savingEdits, setSavingEdits] = useState(false);

  // Load cached identity
  useEffect(() => {
    const c = localStorage.getItem(LS_CADET);
    if (c) setCadet(JSON.parse(c));
    const s = localStorage.getItem(LS_ACTIVE_SESSION);
    if (s) setActiveSession(JSON.parse(s));
  }, []);

  // Live ticker + client auto sign-out at 2h
  useEffect(() => {
    if (!activeSession || activeSession.sign_out) return;

    const intId = window.setInterval(() => setNowTs(Date.now()), 1000);

    // 2h cap client-side
    const startMs = new Date(activeSession.sign_in).getTime();
    const end2h = startMs + TWO_HOURS_SEC * 1000;
    const delay = Math.max(0, end2h - Date.now());

    const toId = window.setTimeout(async () => {
      const iso = new Date(end2h).toISOString();
      if (hasSupabase && supabase) {
        await supabase.from('sessions').update({ sign_out: iso }).eq('id', activeSession.id);
      } else {
        const hist = JSON.parse(localStorage.getItem(LS_SESSIONS) || "[]") as Session[];
        const idx = hist.findIndex(s => s.id === activeSession.id);
        if (idx>=0) { hist[idx].sign_out = iso; localStorage.setItem(LS_SESSIONS, JSON.stringify(hist)); }
      }
      setActiveSession(null);
      localStorage.removeItem(LS_ACTIVE_SESSION);
      setStatusMsg("Auto signed out at 2 hours.");
      fetchLeaderboard();
      if (adminMode) fetchAllActive();
    }, delay);

    return () => { window.clearInterval(intId); window.clearTimeout(toId); };
  }, [activeSession, adminMode]); // include activeSession to satisfy react-hooks/exhaustive-deps

  // Initial / admin refresh loads
  useEffect(() => { fetchLeaderboard(); if (adminMode) fetchAllActive(); }, [adminMode]);

  // ---------- Data loads ----------
  async function fetchLeaderboard() {
    if (hasSupabase && supabase) {
      const { data, error } = await supabase.rpc('asp_leaderboard_all_time');
      if (!error && data) {
        const typed = data as unknown as LeaderboardRow[];
        setLeaderboard(
          typed.map(r => ({
            name: r.name,
            klass: r.klass,
            company: r.company,
            totalMin: Math.floor(r.total_min),
          }))
        );
        return;
      }
    }
    // local fallback (not window-capped, for demo only)
    const raw = JSON.parse(localStorage.getItem(LS_SESSIONS) || "[]") as Session[];
    const ids = new Set(raw.map(r => r.cadet_id));
    const rows: Array<{name:string; klass:Klass; company:string; totalMin:number}> = [];
    ids.forEach(id => {
      const c = JSON.parse(localStorage.getItem(`${LS_CADET}_${id}`) || "null") as Cadet | null;
      if (!c) return;
      const total = raw.filter(s => s.cadet_id === id)
        .reduce((acc, s) => acc + msToMin(new Date(s.sign_out ?? new Date()).getTime() - new Date(s.sign_in).getTime()), 0);
      rows.push({ name: c.name, klass: c.klass, company: c.company, totalMin: total });
    });
    rows.sort((a,b) => b.totalMin - a.totalMin);
    setLeaderboard(rows);
  }

  async function fetchAllActive() {
    if (hasSupabase && supabase) {
      const { data, error } = await supabase
        .from('sessions')
        .select('id, cadet_id, sign_in, sign_out, voided, cadets(name, klass, company, id)')
        .is('sign_out', null);

      if (!error && data) {
        const rows = data as unknown as ActiveRow[];
        setAllActive(
          rows.map(row => ({
            session: {
              id: row.id, cadet_id: row.cadet_id, sign_in: row.sign_in,
              sign_out: row.sign_out, voided: row.voided,
            },
            cadet: {
              id: row.cadets.id, name: row.cadets.name, klass: row.cadets.klass, company: row.cadets.company,
            }
          }))
        );
        return;
      }
    } else {
      const s = JSON.parse(localStorage.getItem(LS_ACTIVE_SESSION) || "null") as Session | null;
      const c = (s && JSON.parse(localStorage.getItem(`${LS_CADET}_${s.cadet_id}`) || "null")) as Cadet | null;
      if (s && c) setAllActive([{ session: s, cadet: c }]); else setAllActive([]);
    }
  }

  // ---------- Admin helpers ----------
  async function voidCadetSessions(cadetId: string) {
    try {
      if (hasSupabase && supabase) {
        const { error } = await supabase
          .from("sessions")
          .update({ voided: true })
          .eq("cadet_id", cadetId)
          .eq("voided", false);
        if (error) throw error;
      } else {
        const hist = JSON.parse(localStorage.getItem(LS_SESSIONS) || "[]") as Session[];
        const updated = hist.map(s => s.cadet_id === cadetId ? { ...s, voided: true } : s);
        localStorage.setItem(LS_SESSIONS, JSON.stringify(updated));
      }
      setStatusMsg("Removed cadet from leaderboard.");
    } catch (e) {
      setStatusMsg(`Failed to remove entry: ${errMsg(e)}`);
    } finally {
      fetchLeaderboard();
      fetchAllActive();
    }
  }

  // Edit sessions (load last 20)
  type CadBrief = { id: string; name: string; klass: Klass; company: string };

  async function openEditForLeaderboardRow(row: {name:string; klass:Klass; company:string}) {
    if (!hasSupabase || !supabase) { setStatusMsg("Editing requires Supabase."); return; }

    // resolve cadet id (exact then case-insensitive)
    const { data: exact } = await supabase
      .from('cadets')
      .select('id,name,klass,company')
      .eq('name', row.name)
      .eq('klass', row.klass)
      .eq('company', row.company)
      .limit(1);

    let cad: CadBrief | null = null;
    if (Array.isArray(exact) && exact.length > 0) {
      const [row0] = exact as unknown as CadBrief[];
      cad = row0;
    } else {
      const { data: ci } = await supabase
        .from('cadets')
        .select('id,name,klass,company')
        .ilike('name', row.name)
        .eq('klass', row.klass)
        .eq('company', row.company)
        .limit(1);

      if (Array.isArray(ci) && ci.length > 0) {
        const [row1] = ci as unknown as CadBrief[];
        cad = row1;
      }
    }

    if (!cad) { setStatusMsg("Could not resolve cadet id."); return; }

    const { data: sess, error } = await supabase
      .from('sessions')
      .select('id,cadet_id,sign_in,sign_out,voided')
      .eq('cadet_id', cad.id)
      .order('sign_in', { ascending: false })
      .limit(20);

    if (error) { setStatusMsg(`Load sessions failed: ${error.message}`); return; }

    const typed = (sess ?? []) as unknown as Session[];
    setEditCadet({ id: cad.id, name: cad.name, klass: cad.klass, company: cad.company });
    setEditSessions(typed);
    const draft: Record<string, {sign_in:string; sign_out:string | null}> = {};
    typed.forEach(s => {
      draft[s.id] = {
        sign_in: isoToLocalInput(s.sign_in),
        sign_out: s.sign_out ? isoToLocalInput(s.sign_out) : "",
      };
    });
    setEditDraft(draft);
  }

  async function saveEdits() {
    if (!hasSupabase || !supabase || !editCadet) return;
    setSavingEdits(true);
    try {
      const updates = Object.entries(editDraft).map(([id, v]) => ({
        id,
        sign_in: localInputToIso(v.sign_in),
        sign_out: v.sign_out ? localInputToIso(v.sign_out) : null,
      }));
      for (const u of updates) {
        const { error } = await supabase.from('sessions').update({ sign_in: u.sign_in, sign_out: u.sign_out }).eq('id', u.id);
        if (error) throw error;
      }
      setStatusMsg("Saved edits.");
      setEditCadet(null);
      setEditSessions([]);
      setEditDraft({});
      fetchLeaderboard();
      if (adminMode) fetchAllActive();
    } catch (e) {
      setStatusMsg(`Save failed: ${errMsg(e)}`);
    } finally {
      setSavingEdits(false);
    }
  }

  function cancelEdits() {
    setEditCadet(null);
    setEditSessions([]);
    setEditDraft({});
  }

  // ---------- Identity / session ----------
  function withinAspHours() { return isAspOpen(nyNow()); }

  function saveLocalCadet(c: Cadet) {
    localStorage.setItem(LS_CADET, JSON.stringify(c));
    localStorage.setItem(`${LS_CADET}_${c.id}`, JSON.stringify(c));
  }

  async function handleSignIn() {
    if (!name || klass === 'none') { setStatusMsg("Enter your name and class year."); return; }
    if (!withinAspHours() && !adminMode) { setStatusMsg("ASP is closed right now (Mon/Wed 19:30–21:30 ET)."); return; }

    const typedName = name.trim();
    let c: Cadet = { id: crypto.randomUUID(), name: typedName, klass: klass as Klass, company };

    if (hasSupabase && supabase) {
      // Resolve or create cadet
      const { data: existing } = await supabase
        .from('cadets')
        .select('id')
        .eq('name', typedName).eq('klass', klass as Klass).eq('company', company)
        .maybeSingle();
      if (existing) c.id = (existing as {id:string}).id;

      const { error: cadetErr } = await supabase
        .from('cadets')
        .upsert({ id: c.id, name: c.name, klass: c.klass, company: c.company }, { onConflict: 'id' });
      if (cadetErr) { setStatusMsg(`Cadet save failed: ${cadetErr.message}`); return; }

      // Resume already-open session instead of creating a new one (prevents overlaps)
      const { data: openSess } = await supabase
        .from('sessions')
        .select('id,cadet_id,sign_in,sign_out')
        .eq('cadet_id', c.id)
        .is('sign_out', null)
        .maybeSingle();

      if (openSess) {
        const existingSession = openSess as Session;
        setCadet(c); saveLocalCadet(c);
        setActiveSession(existingSession);
        localStorage.setItem(LS_ACTIVE_SESSION, JSON.stringify(existingSession));
        setStatusMsg("Resumed your active session.");
        fetchLeaderboard();
        return;
      }
    } else {
      // local-only fallback reuse
      if (cadet && (cadet.name !== typedName || cadet.klass !== klass || cadet.company !== company)) {
        c.id = crypto.randomUUID();
      } else if (cadet) {
        c = cadet;
      }
    }

    setCadet(c);
    saveLocalCadet(c);

    const nowIso = new Date().toISOString();
    let newSession: Session = { id: crypto.randomUUID(), cadet_id: c.id, sign_in: nowIso, sign_out: null };

    if (hasSupabase && supabase) {
      const { data, error: sessionErr } = await supabase
        .from('sessions')
        .insert({ id: newSession.id, cadet_id: c.id, sign_in: nowIso, sign_out: null })
        .select()
        .single();
      if (sessionErr) { setStatusMsg(`Sign-in failed: ${sessionErr.message}`); return; }
      newSession = {
        id: (data as { id: string }).id,
        cadet_id: (data as { cadet_id: string }).cadet_id,
        sign_in: (data as { sign_in: string }).sign_in,
        sign_out: (data as { sign_out: string | null }).sign_out
      };
    } else {
      const hist = JSON.parse(localStorage.getItem(LS_SESSIONS) || "[]") as Session[];
      hist.push(newSession);
      localStorage.setItem(LS_SESSIONS, JSON.stringify(hist));
    }

    setActiveSession(newSession);
    localStorage.setItem(LS_ACTIVE_SESSION, JSON.stringify(newSession));
    setStatusMsg("Signed in. Have a great study session!");
    fetchLeaderboard();
  }

  async function handleSignOut() {
    if (!activeSession) return;
    const nowIso = new Date().toISOString();
    let updated: Session = { ...activeSession, sign_out: nowIso };

    if (hasSupabase && supabase) {
      const { data, error } = await supabase.from('sessions').update({ sign_out: nowIso }).eq('id', activeSession.id).select().single();
      if (error) { setStatusMsg(`Sign-out failed: ${error.message}`); return; }
      updated = {
        id: (data as { id: string }).id,
        cadet_id: (data as { cadet_id: string }).cadet_id,
        sign_in: (data as { sign_in: string }).sign_in,
        sign_out: (data as { sign_out: string | null }).sign_out
      };
    } else {
      const hist = JSON.parse(localStorage.getItem(LS_SESSIONS) || "[]") as Session[];
      const idx = hist.findIndex(s => s.id === activeSession.id);
      if (idx >= 0) { hist[idx] = updated; localStorage.setItem(LS_SESSIONS, JSON.stringify(hist)); }
    }

    setActiveSession(null);
    localStorage.removeItem(LS_ACTIVE_SESSION);
    setStatusMsg("Signed out. Nice work!");
    fetchLeaderboard();
    if (adminMode) fetchAllActive();
  }

  function currentElapsedSec() {
    if (!activeSession) return 0;
    const start = new Date(activeSession.sign_in).getTime();
    const end = activeSession.sign_out ? new Date(activeSession.sign_out).getTime() : nowTs;
    const sec = Math.max(0, Math.floor((end - start) / 1000));
    return Math.min(sec, TWO_HOURS_SEC);
  }

  // Admin key guard (trim + persist)
  const ADMIN_KEY = (process.env.NEXT_PUBLIC_ASP_ADMIN_KEY ?? '').trim();
  useEffect(() => {
    if (typeof window !== 'undefined' && localStorage.getItem('asp_admin_unlocked') === '1') {
      setAdminMode(true);
    }
  }, []);
  useEffect(() => {
    const entered = adminKey.trim();
    if (entered && ADMIN_KEY && entered === ADMIN_KEY) {
      setAdminMode(true);
      if (typeof window !== 'undefined') localStorage.setItem('asp_admin_unlocked', '1');
    }
  }, [adminKey, ADMIN_KEY]);
  function disableAdmin() {
    setAdminMode(false);
    setAdminKey('');
    if (typeof window !== 'undefined') localStorage.removeItem('asp_admin_unlocked');
    setStatusMsg('Admin disabled.');
  }

  const openNow = isAspOpen(nyNow());
  const nextWindow = useMemo(() => {
    const now = nyNow();
    const targetDays = [1, 3]; // Mon, Wed
    const candidates: Date[] = [];
    for (let add = 0; add < 8; add++) {
      const d = new Date(now); d.setDate(now.getDate() + add);
      const dow = d.getDay();
      if (targetDays.includes(dow)) {
        const dt = new Date(d); dt.setHours(19,30,0,0);
        candidates.push(dt);
      }
    }
    const upcoming = candidates.find(d => d.getTime() > now.getTime()) || candidates[0];
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday:'long', month:'short', day:'numeric', hour:'numeric', minute:'2-digit' });
    return fmt.format(upcoming);
  }, []);
  const userTotal = ((): number => {
    const c = cadet; if (!c) return 0;
    const sessions = JSON.parse(localStorage.getItem(LS_SESSIONS) || "[]") as Session[];
    return sessions
      .filter(s => s.cadet_id === c.id)
      .reduce((acc, s) => acc + msToMin(new Date(s.sign_out ?? new Date()).getTime() - new Date(s.sign_in).getTime()), 0);
  })();

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-slate-100 text-slate-900 p-6">
      <motion.div initial={{opacity:0, y:8}} animate={{opacity:1, y:0}} className="max-w-5xl mx-auto grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* Left: Identity & Controls */}
        <div className="md:col-span-1 space-y-4">
          <Card className="shadow-sm">
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><Trophy className="w-5 h-5"/> Athena&rsquo;s Study Parthenon</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="font-medium">Company G1 • 1C–4C</div>
              <div className="flex items-center gap-2 text-slate-600"><Clock className="w-4 h-4"/> Mon & Wed 19:30–21:30 (ET)</div>
              <div className="text-slate-600">Next session: <span className="font-semibold">{nextWindow}</span></div>
              <div className={`text-xs inline-flex px-2 py-1 rounded-full ${openNow? 'bg-green-100 text-green-700':'bg-amber-100 text-amber-700'}`}>{openNow? 'Open now':'Closed'}</div>
            </CardContent>
          </Card>

          <Card className="shadow-sm">
            <CardHeader><CardTitle className="text-base">Your Info</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <Input placeholder="Full name" value={name} onChange={(e)=>setName(e.target.value)} />
              <Select value={klass} onValueChange={(v) => setKlass(v as Klass)}>
                <SelectTrigger><SelectValue placeholder="Class (1C–4C)" /></SelectTrigger>
                <SelectContent>
                  {ALL_KLASSES.map(k => <SelectItem key={k} value={k}>{k}</SelectItem>)}
                </SelectContent>
              </Select>
              <Input placeholder="Company" value={company} onChange={(e)=>setCompany(e.target.value)} />
              {!activeSession ? (
                <Button onClick={handleSignIn} className="w-full"><LogIn className="w-4 h-4 mr-2"/> Sign In</Button>
              ) : (
                <Button onClick={handleSignOut} variant="destructive" className="w-full"><LogOut className="w-4 h-4 mr-2"/> Sign Out</Button>
              )}
              {statusMsg && <div className="text-xs text-slate-600">{statusMsg}</div>}
            </CardContent>
          </Card>

          <Card className="shadow-sm">
            <CardHeader><CardTitle className="text-base flex items-center gap-2"><Medal className="w-4 h-4"/> Incentives</CardTitle></CardHeader>
            <CardContent className="text-sm space-y-2">
              <p><span className="font-semibold">Rule:</span> Every <span className="font-semibold">4 hours (240 min)</span> in ASP = <span className="font-semibold">1 day of PMI</span>.</p>
              <div className="text-xs text-slate-500">Calculated automatically from your all-time minutes.</div>
            </CardContent>
          </Card>
        </div>

        {/* Right: Session + Leaderboard */}
        <div className="md:col-span-2 space-y-4">
          <Card className="shadow-sm">
            <CardHeader><CardTitle className="text-base flex items-center gap-2"><Clock className="w-4 h-4"/> Live Session</CardTitle></CardHeader>
            <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-4 items-start">
              <div className="md:col-span-2">
                <div className="text-2xl font-semibold">{formatHMS(currentElapsedSec())}</div>
                <div className="text-sm text-slate-600">{activeSession ? `Signed in at ${new Date(activeSession.sign_in).toLocaleTimeString('en-US', { timeZone: TZ, hour:'numeric', minute:'2-digit' })} ET` : 'Not currently signed in'}</div>
                {cadet && <div className="text-sm text-slate-600 mt-2">Lifetime (local): <span className="font-semibold">{formatHM(userTotal)}</span> • PMI days: <span className="font-semibold">{Math.floor(userTotal/240)}</span></div>}
              </div>
              <div className="text-xs text-slate-600 bg-slate-50 rounded-xl p-3">
                <div className="font-semibold mb-1">Rules</div>
                <ul className="list-disc pl-4 space-y-1">
                  <li>One active session per cadet.</li>
                  <li>Auto sign-out at 2h and at 21:30 ET.</li>
                  <li>Leaderboard counts only minutes inside ASP window.</li>
                </ul>
              </div>
            </CardContent>
          </Card>

          <Card className="shadow-sm">
            <CardHeader><CardTitle className="text-base flex items-center gap-2"><Trophy className="w-4 h-4"/> Leaderboard</CardTitle></CardHeader>
            <CardContent>
              <Tabs defaultValue="all">
                <TabsList>
                  {TABS.map(tab => (<TabsTrigger key={tab} value={tab}>{tab === 'all' ? 'All' : tab}</TabsTrigger>))}
                </TabsList>
                {TABS.map((tab) => (
                  <TabsContent key={tab} value={tab}>
                    <Table>
                      <TableCaption>All-time minutes (window-capped via server RPC).</TableCaption>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-16">Rank</TableHead>
                          <TableHead>Name</TableHead>
                          <TableHead>Class</TableHead>
                          <TableHead>Company</TableHead>
                          <TableHead className="text-right">Total</TableHead>
                          <TableHead className="text-right">PMI Days</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {leaderboard.filter(r => tab==='all' ? true : r.klass===tab).map((r, idx) => (
                          <TableRow key={`${r.name}-${idx}`}>
                            <TableCell>{idx+1}</TableCell>
                            <TableCell className="font-medium">{r.name}</TableCell>
                            <TableCell>{r.klass}</TableCell>
                            <TableCell>{r.company}</TableCell>
                            <TableCell className="text-right">{formatHM(r.totalMin)}</TableCell>
                            <TableCell className="text-right">{Math.floor(r.totalMin/240)}</TableCell>
                          </TableRow>
                        ))}
                        {leaderboard.filter(r => tab==='all' ? true : r.klass===tab).length===0 && (
                          <TableRow><TableCell colSpan={6} className="text-center text-slate-500">No data yet.</TableCell></TableRow>
                        )}
                      </TableBody>
                    </Table>
                  </TabsContent>
                ))}
              </Tabs>
            </CardContent>
          </Card>

          {/* Admin tools */}
          <Card className="shadow-sm">
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2"><Shield className="w-4 h-4"/> Admin</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              {!adminMode ? (
                <div className="flex gap-2 items-center">
                  <Input type="password" placeholder="Enter Admin Key" value={adminKey} onChange={(e)=>setAdminKey(e.target.value)} />
                  <div className="text-xs text-slate-500">Set NEXT_PUBLIC_ASP_ADMIN_KEY to enable.</div>
                </div>
              ) : (
                <div className="space-y-4">
                  {/* Admin status + disable */}
                  <div className="flex items-center justify-between">
                    <div className="text-xs text-green-700 bg-green-50 rounded px-2 py-1">Admin mode enabled</div>
                    <Button size="sm" variant="outline" onClick={disableAdmin}>Disable admin</Button>
                  </div>

                  <div className="text-slate-600">Active sessions:</div>
                  <div className="space-y-2">
                    {allActive.length===0 && <div className="text-xs text-slate-500">None</div>}
                    {allActive.map(({session, cadet}) => {
                      const mins = msToMin(new Date().getTime() - new Date(session.sign_in).getTime());
                      return (
                        <div key={session.id} className="flex items-center justify-between bg-slate-50 rounded-xl p-3">
                          <div>
                            <div className="font-medium">{cadet.name}</div>
                            <div className="text-xs text-slate-600">{cadet.klass} • {cadet.company} • {formatHM(mins)}</div>
                          </div>
                          <Button size="sm" variant="outline" onClick={async ()=>{
                            if (hasSupabase && supabase) {
                              await supabase.from('sessions').update({ sign_out: new Date().toISOString() }).eq('id', session.id);
                            } else {
                              const hist = JSON.parse(localStorage.getItem(LS_SESSIONS) || "[]") as Session[];
                              const idx = hist.findIndex(s => s.id === session.id);
                              if (idx>=0) { hist[idx].sign_out = new Date().toISOString(); localStorage.setItem(LS_SESSIONS, JSON.stringify(hist)); localStorage.removeItem(LS_ACTIVE_SESSION); }
                            }
                            fetchAllActive();
                            fetchLeaderboard();
                          }}>Force Sign Out</Button>
                        </div>
                      );
                    })}
                  </div>

                  {/* Leaderboard maintenance */}
                  <div className="space-y-2">
                    <div className="text-slate-600 mt-4">Leaderboard maintenance:</div>
                    {leaderboard.length===0 && <div className="text-xs text-slate-500">No entries yet.</div>}
                    {leaderboard.slice(0, 20).map((r, i) => (
                      <div key={`${r.name}-${i}`} className="flex items-center justify-between bg-slate-50 rounded-xl p-3">
                        <div>
                          <div className="font-medium">{r.name}</div>
                          <div className="text-xs text-slate-600">{r.klass} • {r.company} • {formatHM(r.totalMin)} ({Math.floor(r.totalMin/240)} PMI day(s))</div>
                        </div>
                        <div className="flex gap-2">
                          <Button size="sm" variant="outline" onClick={()=>openEditForLeaderboardRow(r)}>Edit</Button>
                          <Button size="sm" variant="destructive" onClick={async ()=>{
                            if (!confirm(`Remove ${r.name} from leaderboard?`)) return;
                            if (hasSupabase && supabase) {
                              const { data: cad } = await supabase
                                .from('cadets').select('id').eq('name', r.name).eq('klass', r.klass).eq('company', r.company).limit(1);
                              if (cad && cad.length) {
                                await voidCadetSessions((cad[0] as {id:string}).id);
                              } else {
                                const { data: ci } = await supabase
                                  .from('cadets').select('id').ilike('name', r.name).eq('klass', r.klass).eq('company', r.company).limit(1);
                                if (ci && ci.length) await voidCadetSessions((ci[0] as {id:string}).id);
                                else setStatusMsg("Could not resolve cadet id.");
                              }
                            } else if (cadet && cadet.name === r.name) {
                              await voidCadetSessions(cadet.id);
                            } else {
                              setStatusMsg("Local mode: remove is limited.");
                            }
                          }}>Remove</Button>
                        </div>
                      </div>
                    ))}
                    <div className="flex gap-2">
                      <Button variant="destructive" onClick={async ()=>{
                        if (!confirm("Reset leaderboard for everyone? This will void all sessions.")) return;
                        try {
                          if (hasSupabase && supabase) {
                            const { error } = await supabase.from("sessions").update({ voided: true }).eq("voided", false);
                            if (error) throw error;
                          } else {
                            const hist = JSON.parse(localStorage.getItem(LS_SESSIONS) || "[]") as Session[];
                            const updated = hist.map(s => ({ ...s, voided: true }));
                            localStorage.setItem(LS_SESSIONS, JSON.stringify(updated));
                          }
                          setStatusMsg("Leaderboard reset complete.");
                        } catch (e) {
                          setStatusMsg(`Reset failed: ${errMsg(e)}`);
                        } finally {
                          fetchLeaderboard();
                          fetchAllActive();
                        }
                      }}>Reset Leaderboard</Button>
                    </div>
                  </div>

                  {/* Edit panel */}
                  {editCadet && (
                    <div className="mt-4 border rounded-xl p-3 bg-slate-50">
                      <div className="flex items-center justify-between mb-2">
                        <div className="font-medium">Edit sessions for {editCadet.name} ({editCadet.klass} • {editCadet.company})</div>
                        <div className="flex gap-2">
                          <Button size="sm" variant="outline" onClick={cancelEdits} disabled={savingEdits}>Cancel</Button>
                          <Button size="sm" onClick={saveEdits} disabled={savingEdits}>{savingEdits ? "Saving..." : "Save changes"}</Button>
                        </div>
                      </div>
                      <div className="text-xs text-slate-600 mb-2">Times are in your device&rsquo;s local timezone. Leaderboard caps minutes to ASP window (ET) server-side.</div>
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Sign In</TableHead>
                            <TableHead>Sign Out</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {editSessions.map(s => (
                            <TableRow key={s.id}>
                              <TableCell>
                                <Input
                                  type="datetime-local"
                                  value={editDraft[s.id]?.sign_in ?? ""}
                                  onChange={(e)=>setEditDraft(d => ({...d, [s.id]: {sign_in: e.target.value, sign_out: d[s.id]?.sign_out ?? ""}}))}
                                />
                              </TableCell>
                              <TableCell>
                                <Input
                                  type="datetime-local"
                                  value={editDraft[s.id]?.sign_out ?? ""}
                                  onChange={(e)=>setEditDraft(d => ({...d, [s.id]: {sign_in: d[s.id]?.sign_in ?? "", sign_out: e.target.value}}))}
                                />
                              </TableCell>
                            </TableRow>
                          ))}
                          {editSessions.length === 0 && (
                            <TableRow><TableCell colSpan={2} className="text-center text-slate-500">No sessions to edit.</TableCell></TableRow>
                          )}
                        </TableBody>
                      </Table>
                      <div className="text-xs text-amber-700 bg-amber-50 rounded px-2 py-1 mt-2 inline-block">
                        Note: After edits, the leaderboard uses the server function that caps minutes per ASP night.
                      </div>
                    </div>
                  )}

                  <div className="flex items-start gap-2 text-amber-700 bg-amber-50 p-3 rounded-xl">
                    <AlertTriangle className="w-4 h-4 mt-0.5"/>
                    <div className="text-xs">
                      Admin tools are client-guarded only. Use RLS for true security.
                    </div>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </motion.div>
    </div>
  );
}
