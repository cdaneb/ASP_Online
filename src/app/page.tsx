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

// ---------- Config / helpers ----------
const TZ = "America/New_York";
const TWO_HOURS_MIN = 120;
const TWO_HOURS_SEC = TWO_HOURS_MIN * 60;

type Klass = '1C' | '2C' | '3C' | '4C';
const ALL_KLASSES: Klass[] = ['1C','2C','3C','4C'];
const TABS: Array<'all' | Klass> = ['all', ...ALL_KLASSES];

function nyNow() { return new Date(); }

// ASP hours: Monday & Wednesday 19:30–21:30 ET
function isAspOpen(date = nyNow()) {
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
function errMsg(e: unknown) { return e instanceof Error ? e.message : String(e); }

// Name normalization: trim, collapse spaces
function normalizeName(raw: string) {
  return raw.trim().replace(/\s+/g, " ");
}

// ET helpers
function etParts(d: Date) {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  const parts = fmt.formatToParts(d).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {} as Record<string,string>);
  return {
    y: parseInt(parts.year!,10),
    m: parseInt(parts.month!,10),
    da: parseInt(parts.day!,10),
    h: parseInt(parts.hour!,10),
    mi: parseInt(parts.minute!,10),
  };
}
function etDateKey(d: Date) {
  const { y,m,da } = etParts(d);
  return `${y}-${pad2(m)}-${pad2(da)}`; // YYYY-MM-DD (ET)
}
function minutesOfDayET(d: Date) {
  const { h, mi } = etParts(d);
  return h*60 + mi;
}
const ASP_START_MIN = 19*60 + 30; // 1170
const ASP_END_MIN   = 21*60 + 30; // 1290
function overlapMinutesET(aStartMin: number, aEndMin: number, bStartMin: number, bEndMin: number) {
  const a1 = Math.max(aStartMin, bStartMin);
  const b1 = Math.min(aEndMin, bEndMin);
  return Math.max(0, b1 - a1);
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
interface LeaderboardRowDBv1 { name: string; klass: Klass; company: string; total_min: number; }
interface LeaderboardRowDBv2 extends LeaderboardRowDBv1 { cadet_id: string; }

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
type OverrideRow = { cadet_id: string; minutes_override: number };

// ---------- Component ----------
export default function ASPApp() {
  const [cadet, setCadet] = useState<Cadet | null>(null);
  const [klass, setKlass] = useState<Klass | 'none'>("none");
  const [name, setName] = useState("");
  const [company, setCompany] = useState("G1");
  const [activeSession, setActiveSession] = useState<Session | null>(null);

  const [leaderboard, setLeaderboard] = useState<Array<{cadetId?: string; name:string; klass:Klass; company:string; totalMin:number}>>([]);
  const [overridesMap, setOverridesMap] = useState<Record<string, number>>({}); // cadet_id -> minutes_override

  const [adminMode, setAdminMode] = useState(false);
  const [adminKey, setAdminKey] = useState("");
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [nowTs, setNowTs] = useState<number>(Date.now());

  // Admin editing state
  const [editCadet, setEditCadet] = useState<Cadet | null>(null);
  const [editSessions, setEditSessions] = useState<Session[]>([]);
  const [editDraft, setEditDraft] = useState<Record<string, {sign_in: string; sign_out: string | null}>>({});
  const [editOverride, setEditOverride] = useState<string>("");
  const [savingEdits, setSavingEdits] = useState(false);

  // Load cached identity / session
  useEffect(() => {
    const c = localStorage.getItem("asp_current_cadet");
    if (c) setCadet(JSON.parse(c));
    const s = localStorage.getItem("asp_active_session");
    if (s) setActiveSession(JSON.parse(s));
  }, []);

  // Live ticker + client auto sign-out at 2h
  useEffect(() => {
    if (!activeSession || activeSession.sign_out) return;
    const intId = window.setInterval(() => setNowTs(Date.now()), 1000);

    const startMs = new Date(activeSession.sign_in).getTime();
    const end2h = startMs + TWO_HOURS_SEC * 1000;
    const delay = Math.max(0, end2h - Date.now());

    const toId = window.setTimeout(async () => {
      const iso = new Date(end2h).toISOString();
      if (hasSupabase && supabase) {
        await supabase.from('sessions').update({ sign_out: iso }).eq('id', activeSession.id);
      } else {
        const hist = JSON.parse(localStorage.getItem("asp_sessions") || "[]") as Session[];
        const idx = hist.findIndex(s => s.id === activeSession.id);
        if (idx>=0) { hist[idx].sign_out = iso; localStorage.setItem("asp_sessions", JSON.stringify(hist)); }
      }
      setActiveSession(null);
      localStorage.removeItem("asp_active_session");
      setStatusMsg("Auto signed out at 2 hours.");
      fetchLeaderboard();
    }, delay);

    return () => { window.clearInterval(intId); window.clearTimeout(toId); };
  }, [activeSession]);

  // Initial loads
  useEffect(() => { void fetchLeaderboard(); }, []);
  useEffect(() => {
    if (!hasSupabase || !supabase) return;
    (async () => {
      const { data } = await supabase.from('leaderboard_overrides').select('cadet_id, minutes_override');
      if (Array.isArray(data)) {
        const map: Record<string, number> = {};
        (data as OverrideRow[]).forEach(r => { map[r.cadet_id] = Number(r.minutes_override); });
        setOverridesMap(map);
      }
    })();
  }, [leaderboard.length]);

  // ---------- Data loads ----------
  async function fetchLeaderboard() {
    if (hasSupabase && supabase) {
      const v2 = await supabase.rpc('asp_leaderboard_all_time_v2');
      if (!v2.error && Array.isArray(v2.data)) {
        const rows = v2.data as unknown as LeaderboardRowDBv2[];
        setLeaderboard(rows.map(r => ({
          cadetId: r.cadet_id,
          name: r.name,
          klass: r.klass,
          company: r.company,
          totalMin: Math.floor(Number(r.total_min)),
        })));
        return;
      }

      const v1 = await supabase.rpc('asp_leaderboard_all_time');
      if (!v1.error && Array.isArray(v1.data)) {
        const base = v1.data as unknown as LeaderboardRowDBv1[];
        const withIds: Array<{cadetId?: string; name:string; klass:Klass; company:string; totalMin:number}> = [];
        for (const r of base) {
          const { data: cad } = await supabase
            .from('cadets')
            .select('id')
            .eq('klass', r.klass)
            .eq('company', r.company)
            .ilike('name', r.name)
            .limit(1);
          const cadId = Array.isArray(cad) && cad.length ? (cad[0] as {id:string}).id : undefined;
          withIds.push({ cadetId: cadId, name: r.name, klass: r.klass, company: r.company, totalMin: Math.floor(Number(r.total_min)) });
        }
        setLeaderboard(withIds);
        return;
      }
    }

    // Local fallback (demo only)
    const raw = JSON.parse(localStorage.getItem("asp_sessions") || "[]") as Session[];
    const ids = new Set(raw.map(r => r.cadet_id));
    const rows: Array<{name:string; klass:Klass; company:string; totalMin:number}> = [];
    ids.forEach(id => {
      const c = JSON.parse(localStorage.getItem(`asp_current_cadet_${id}`) || "null") as Cadet | null;
      if (!c) return;
      const total = raw.filter(s => s.cadet_id === id)
        .reduce((acc, s) => acc + msToMin(new Date(s.sign_out ?? new Date()).getTime() - new Date(s.sign_in).getTime()), 0);
      rows.push({ name: c.name, klass: c.klass, company: c.company, totalMin: total });
    });
    rows.sort((a,b) => b.totalMin - a.totalMin);
    setLeaderboard(rows);
  }

  // ---------- Identity / session utils ----------
  function saveLocalCadet(c: Cadet) {
    localStorage.setItem("asp_current_cadet", JSON.stringify(c));
    localStorage.setItem(`asp_current_cadet_${c.id}`, JSON.stringify(c));
  }

  function minutesTonightET(sessions: Session[], now: Date): number {
    const tonightKey = etDateKey(now);
    let sum = 0;
    for (const s of sessions) {
      const sin = new Date(s.sign_in);
      const sout = new Date(s.sign_out ?? now);
      if (etDateKey(sin) !== tonightKey) continue;
      const a = minutesOfDayET(sin);
      const b = minutesOfDayET(sout);
      const seg = overlapMinutesET(a, b, ASP_START_MIN, ASP_END_MIN);
      sum += seg;
    }
    return Math.min(sum, TWO_HOURS_MIN);
  }

  // ---------- Handlers ----------
  async function handleSignIn() {
    if (!name || klass === 'none') { setStatusMsg("Enter your name and class year."); return; }
    if (!isAspOpen(nyNow())) { setStatusMsg("ASP is closed right now (Mon/Wed 19:30–21:30 ET)."); return; }

    const canonicalName = normalizeName(name);
    const c: Cadet = { id: crypto.randomUUID(), name: canonicalName, klass: klass as Klass, company };

    if (hasSupabase && supabase) {
      // 1) Find existing cadet (exact normalized match first, then case-insensitive)
      let resolvedId: string | null = null;
      const exact = await supabase.from('cadets').select('id,name,klass,company').eq('name', canonicalName).eq('klass', c.klass).eq('company', c.company).maybeSingle();
      if (!exact.error && exact.data) {
        resolvedId = (exact.data as {id:string}).id;
      } else {
        const ci = await supabase.from('cadets').select('id,name,klass,company').ilike('name', canonicalName).eq('klass', c.klass).eq('company', c.company).limit(1);
        if (!ci.error && Array.isArray(ci.data) && ci.data.length) resolvedId = (ci.data[0] as {id:string}).id;
      }
      if (resolvedId) c.id = resolvedId;

      // 2) Upsert (also normalizes stored name to canonical)
      const { error: cadetErr } = await supabase
        .from('cadets')
        .upsert({ id: c.id, name: canonicalName, klass: c.klass, company: c.company }, { onConflict: 'id' });
      if (cadetErr) { setStatusMsg(`Cadet save failed: ${cadetErr.message}`); return; }

      // 3) If there is an already open session → resume (prevents overlap)
      const open = await supabase
        .from('sessions').select('id,cadet_id,sign_in,sign_out').eq('cadet_id', c.id).is('sign_out', null).maybeSingle();
      if (!open.error && open.data) {
        const existing = open.data as Session;
        setCadet(c); saveLocalCadet(c);
        setActiveSession(existing);
        localStorage.setItem("asp_active_session", JSON.stringify(existing));
        setStatusMsg("Resumed your active session.");
        void fetchLeaderboard();
        return;
      }

      // 4) Guard: if they already hit 120 min in tonight’s window, block another sign-in
      const since = new Date(Date.now() - 36*60*60*1000).toISOString();
      const recent = await supabase
        .from('sessions')
        .select('id,cadet_id,sign_in,sign_out,voided')
        .eq('cadet_id', c.id)
        .eq('voided', false)
        .gte('sign_in', since)
        .order('sign_in', { ascending: false });

      if (!recent.error && Array.isArray(recent.data)) {
        const mins = minutesTonightET(recent.data as Session[], nyNow());
        if (mins >= TWO_HOURS_MIN) {
          setStatusMsg("You’ve already logged 2 hours tonight. See you next time!");
          return;
        }
      }

      // 5) Create new session
      const nowIso = new Date().toISOString();
      const inserted = await supabase
        .from('sessions')
        .insert({ id: crypto.randomUUID(), cadet_id: c.id, sign_in: nowIso, sign_out: null })
        .select()
        .single();
      if (inserted.error || !inserted.data) { setStatusMsg(`Sign-in failed: ${inserted.error?.message ?? 'unknown error'}`); return; }

      const newSession = inserted.data as Session;
      setCadet(c); saveLocalCadet(c);
      setActiveSession(newSession);
      localStorage.setItem("asp_active_session", JSON.stringify(newSession));
      setStatusMsg("Signed in. Have a great study session!");
      void fetchLeaderboard();
      return;
    }

    // Local fallback
    const hist = JSON.parse(localStorage.getItem("asp_sessions") || "[]") as Session[];
    const nowIso = new Date().toISOString();
    const newSession: Session = { id: crypto.randomUUID(), cadet_id: c.id, sign_in: nowIso, sign_out: null };
    hist.push(newSession);
    localStorage.setItem("asp_sessions", JSON.stringify(hist));
    setCadet(c); saveLocalCadet(c);
    setActiveSession(newSession);
    localStorage.setItem("asp_active_session", JSON.stringify(newSession));
    setStatusMsg("Signed in (local mode).");
    void fetchLeaderboard();
  }

  async function handleSignOut() {
    if (!activeSession) return;
    const nowIso = new Date().toISOString();

    if (hasSupabase && supabase) {
      const { error } = await supabase.from('sessions').update({ sign_out: nowIso }).eq('id', activeSession.id).select().single();
      if (error) { setStatusMsg(`Sign-out failed: ${error.message}`); return; }
    } else {
      const hist = JSON.parse(localStorage.getItem("asp_sessions") || "[]") as Session[];
      const idx = hist.findIndex(s => s.id === activeSession.id);
      if (idx >= 0) { hist[idx].sign_out = nowIso; localStorage.setItem("asp_sessions", JSON.stringify(hist)); }
    }

    setActiveSession(null);
    localStorage.removeItem("asp_active_session");
    setStatusMsg("Signed out. Nice work!");
    void fetchLeaderboard();
  }

  function currentElapsedSec() {
    if (!activeSession) return 0;
    const start = new Date(activeSession.sign_in).getTime();
    const end = activeSession.sign_out ? new Date(activeSession.sign_out).getTime() : nowTs;
    const sec = Math.max(0, Math.floor((end - start) / 1000));
    return Math.min(sec, TWO_HOURS_SEC);
  }

  // ---------- Admin key guard ----------
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

  // ---------- Derived UI values ----------
  const openNow = isAspOpen(nyNow());
  const nextWindow = useMemo(() => {
    const now = nyNow();
    const targetDays = [1, 3]; // Mon, Wed
    const candidates: Date[] = [];
    for (let add = 0; add < 8; add++) {
      const d = new Date(now); d.setDate(now.getDate() + add);
      const dow = d.getDay();
      if (targetDays.includes(dow)) { const dt = new Date(d); dt.setHours(19,30,0,0); candidates.push(dt); }
    }
    const upcoming = candidates.find(d => d.getTime() > now.getTime()) || candidates[0];
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday:'long', month:'short', day:'numeric', hour:'numeric', minute:'2-digit' });
    return fmt.format(upcoming);
  }, []);

  const userTotalLocal = (() => {
    if (!cadet) return 0;
    const sessions = JSON.parse(localStorage.getItem("asp_sessions") || "[]") as Session[];
    return sessions
      .filter(s => s.cadet_id === cadet.id)
      .reduce((acc, s) => acc + msToMin(new Date(s.sign_out ?? new Date()).getTime() - new Date(s.sign_in).getTime()), 0);
  })();

  // ---------- Admin edit flow ----------
  type CadBrief = { id: string; name: string; klass: Klass; company: string };

  async function openEditForLeaderboardRow(row: {cadetId?:string; name:string; klass:Klass; company:string}) {
    if (!hasSupabase || !supabase) { setStatusMsg("Editing requires Supabase."); return; }

    // Resolve cadet id
    let cadId = row.cadetId;
    if (!cadId) {
      const { data: exact } = await supabase
        .from('cadets').select('id,name,klass,company')
        .eq('name', row.name).eq('klass', row.klass).eq('company', row.company).limit(1);
      if (Array.isArray(exact) && exact.length) cadId = (exact[0] as {id:string}).id;
      if (!cadId) {
        const { data: ci } = await supabase
          .from('cadets').select('id,name,klass,company')
          .ilike('name', row.name).eq('klass', row.klass).eq('company', row.company).limit(1);
        if (Array.isArray(ci) && ci.length) cadId = (ci[0] as {id:string}).id;
      }
    }
    if (!cadId) { setStatusMsg("Could not resolve cadet id."); return; }

    // Load cadet
    const { data: cadRow } = await supabase.from('cadets').select('id,name,klass,company').eq('id', cadId).maybeSingle();
    if (!cadRow) { setStatusMsg("Cadet not found."); return; }
    const cad = cadRow as CadBrief;

    // Load recent sessions
    const { data: sess, error } = await supabase
      .from('sessions')
      .select('id,cadet_id,sign_in,sign_out,voided')
      .eq('cadet_id', cad.id)
      .order('sign_in', { ascending: false })
      .limit(50);
    if (error) { setStatusMsg(`Load sessions failed: ${error.message}`); return; }
    const typed = (sess ?? []) as Session[];

    // Load existing override (if any)
    let overrideVal = "";
    const { data: ov } = await supabase
      .from('leaderboard_overrides')
      .select('minutes_override')
      .eq('cadet_id', cad.id)
      .maybeSingle();
    if (ov && typeof (ov as {minutes_override:number}).minutes_override !== "undefined") {
      overrideVal = String((ov as {minutes_override:number}).minutes_override);
    }

    setEditCadet({ id: cad.id, name: cad.name, klass: cad.klass, company: cad.company });
    setEditSessions(typed);
    const draft: Record<string, {sign_in:string; sign_out:string | null}> = {};
    typed.forEach(s => {
      const sin = new Date(s.sign_in); const sout = s.sign_out ? new Date(s.sign_out) : null;
      const fmt = (d: Date) => {
        const y = d.getFullYear(); const m = pad2(d.getMonth()+1); const da = pad2(d.getDate());
        const h = pad2(d.getHours()); const mi = pad2(d.getMinutes());
        return `${y}-${m}-${da}T${h}:${mi}`;
      };
      draft[s.id] = { sign_in: fmt(sin), sign_out: sout ? fmt(sout) : "" };
    });
    setEditDraft(draft);
    setEditOverride(overrideVal);
  }

  async function saveEdits() {
    if (!hasSupabase || !supabase || !editCadet) return;
    setSavingEdits(true);
    try {
      // 1) Save session edits
      const updates = Object.entries(editDraft).map(([id, v]) => ({
        id,
        sign_in: new Date(v.sign_in).toISOString(),
        sign_out: v.sign_out ? new Date(v.sign_out).toISOString() : null,
      }));
      for (const u of updates) {
        const { error } = await supabase.from('sessions').update({ sign_in: u.sign_in, sign_out: u.sign_out }).eq('id', u.id);
        if (error) throw error;
      }

      // 2) Save manual override (if provided)
      const trimmed = editOverride.trim();
      if (trimmed.length) {
        const minutes = Math.max(0, Math.floor(Number(trimmed)));
        const { error: ovErr } = await supabase
          .from('leaderboard_overrides')
          .upsert({ cadet_id: editCadet.id, minutes_override: minutes }, { onConflict: 'cadet_id' });
        if (ovErr) throw ovErr;
      } else {
        await supabase.from('leaderboard_overrides').delete().eq('cadet_id', editCadet.id);
      }

      setStatusMsg("Saved edits.");
      setEditCadet(null);
      setEditSessions([]);
      setEditDraft({});
      setEditOverride("");
      await fetchLeaderboard();
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
    setEditOverride("");
  }

  // ---------- Render ----------
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
              <div className={`text-xs inline-flex px-2 py-1 rounded-full ${isAspOpen()? 'bg-green-100 text-green-700':'bg-amber-100 text-amber-700'}`}>{isAspOpen()? 'Open now':'Closed'}</div>
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
                <div className="text-2xl font-semibold">{formatHMS((() => {
                  if (!activeSession) return 0;
                  const start = new Date(activeSession.sign_in).getTime();
                  const end = activeSession.sign_out ? new Date(activeSession.sign_out).getTime() : nowTs;
                  const sec = Math.max(0, Math.floor((end - start) / 1000));
                  return Math.min(sec, TWO_HOURS_SEC);
                })())}</div>
                <div className="text-sm text-slate-600">{activeSession ? `Signed in at ${new Date(activeSession.sign_in).toLocaleTimeString('en-US', { timeZone: TZ, hour:'numeric', minute:'2-digit' })} ET` : 'Not currently signed in'}</div>
                {cadet && <div className="text-sm text-slate-600 mt-2">Lifetime (local): <span className="font-semibold">{formatHM((() => {
                  if (!cadet) return 0;
                  const sessions = JSON.parse(localStorage.getItem("asp_sessions") || "[]") as Session[];
                  return sessions
                    .filter(s => s.cadet_id === cadet.id)
                    .reduce((acc, s) => acc + msToMin(new Date(s.sign_out ?? new Date()).getTime() - new Date(s.sign_in).getTime()), 0);
                })())}</span> • PMI days: <span className="font-semibold">{Math.floor((() => {
                  if (!cadet) return 0;
                  const sessions = JSON.parse(localStorage.getItem("asp_sessions") || "[]") as Session[];
                  const mins = sessions
                    .filter(s => s.cadet_id === cadet.id)
                    .reduce((acc, s) => acc + msToMin(new Date(s.sign_out ?? new Date()).getTime() - new Date(s.sign_in).getTime()), 0);
                  return mins/240;
                })())}</span></div>}
              </div>
              <div className="text-xs text-slate-600 bg-slate-50 rounded-xl p-3">
                <div className="font-semibold mb-1">Rules</div>
                <ul className="list-disc pl-4 space-y-1">
                  <li>One active session per cadet.</li>
                  <li>Auto sign-out at 2h and at 21:30 ET.</li>
                  <li>New sign-ins are blocked after 2h total for the night.</li>
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
                {TABS.map((tab) => {
                  const rows = leaderboard.filter(r => tab==='all' ? true : r.klass===tab)
                    .map(r => {
                      const override = r.cadetId ? overridesMap[r.cadetId] : undefined;
                      const total = typeof override === 'number' ? override : r.totalMin;
                      return { ...r, total };
                    })
                    .sort((a,b) => b.total - a.total);
                  return (
                    <TabsContent key={tab} value={tab}>
                      <Table>
                        <TableCaption>All-time minutes (DB-capped to ASP window; manual overrides applied when set).</TableCaption>
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
                          {rows.map((r, idx) => (
                            <TableRow key={`${r.name}-${idx}`}>
                              <TableCell>{idx+1}</TableCell>
                              <TableCell className="font-medium">{r.name}</TableCell>
                              <TableCell>{r.klass}</TableCell>
                              <TableCell>{r.company}</TableCell>
                              <TableCell className="text-right">{formatHM(r.total)}</TableCell>
                              <TableCell className="text-right">{Math.floor(r.total/240)}</TableCell>
                            </TableRow>
                          ))}
                          {rows.length===0 && (
                            <TableRow><TableCell colSpan={6} className="text-center text-slate-500">No data yet.</TableCell></TableRow>
                          )}
                        </TableBody>
                      </Table>
                    </TabsContent>
                  );
                })}
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
                  <div className="flex items-center justify-between">
                    <div className="text-xs text-green-700 bg-green-50 rounded px-2 py-1">Admin mode enabled</div>
                    <Button size="sm" variant="outline" onClick={disableAdmin}>Disable admin</Button>
                  </div>

                  {/* Leaderboard maintenance (Edit + Remove remain) */}
                  <div className="space-y-2">
                    <div className="text-slate-600 mt-2">Leaderboard maintenance:</div>
                    {leaderboard.slice(0, 30).map((r, i) => (
                      <div key={`${r.name}-${i}`} className="flex items-center justify-between bg-slate-50 rounded-xl p-3">
                        <div>
                          <div className="font-medium">{r.name}</div>
                          <div className="text-xs text-slate-600">{r.klass} • {r.company}</div>
                        </div>
                        <div className="flex gap-2">
                          <Button size="sm" variant="outline" onClick={()=>openEditForLeaderboardRow(r)}>Edit</Button>
                          <Button size="sm" variant="destructive" onClick={async ()=>{
                            if (!hasSupabase || !supabase) return;
                            if (!confirm(`Remove ${r.name} from leaderboard? This voids sessions (not overrides).`)) return;
                            let cadId = r.cadetId;
                            if (!cadId) {
                              const { data: cad } = await supabase
                                .from('cadets').select('id').ilike('name', r.name).eq('klass', r.klass).eq('company', r.company).limit(1);
                              if (Array.isArray(cad) && cad.length) cadId = (cad[0] as {id:string}).id;
                            }
                            if (!cadId) { setStatusMsg("Could not resolve cadet id."); return; }
                            await supabase.from("sessions").update({ voided: true }).eq("cadet_id", cadId).eq("voided", false);
                            setStatusMsg("Removed cadet sessions.");
                            await fetchLeaderboard();
                          }}>Remove</Button>
                        </div>
                      </div>
                    ))}
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

                      <div className="text-xs text-slate-600 mb-2">
                        Times are in your device&rsquo;s local timezone. Totals are capped to the ASP window on the server.
                      </div>

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

                      <div className="mt-4">
                        <div className="font-medium mb-1">Manual total override</div>
                        <div className="text-xs text-slate-600 mb-2">
                          Set an absolute **total minutes** for this cadet&rsquo;s leaderboard line (leave blank to use calculated total).
                        </div>
                        <div className="flex items-center gap-2">
                          <Input
                            type="number"
                            min={0}
                            placeholder="Minutes (e.g., 240)"
                            value={editOverride}
                            onChange={(e)=>setEditOverride(e.target.value)}
                            className="max-w-[200px]"
                          />
                          <div className="text-xs text-slate-500">
                            That&rsquo;s ~{Math.floor(Number(editOverride||"0")/60)}h {Number(editOverride||"0")%60}m
                          </div>
                        </div>
                      </div>

                      <div className="text-xs text-amber-700 bg-amber-50 rounded px-2 py-1 mt-3 inline-block">
                        Note: Overrides affect leaderboard display only; underlying sessions remain unchanged.
                      </div>
                    </div>
                  )}

                  <div className="flex items-start gap-2 text-amber-700 bg-amber-50 p-3 rounded-xl">
                    <AlertTriangle className="w-4 h-4 mt-0.5"/>
                    <div className="text-xs">
                      Admin tools are client-guarded only. Use RLS/SQL for true enforcement.
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
