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
 * ASP (Athena's Study Parthenon) – single-file MVP front-end
 * - Supabase backend (optional) for persistence
 * - LocalStorage fallback for demo/offline
 * - Sign in/out within Monday & Wednesday 19:30–21:30 America/New_York
 * - Live timer while signed in (HH:MM:SS)
 * - Auto sign-out at 2 hours (client + DB cron)
 * - Leaderboard by total minutes (all-time)
 * - Simple admin view to see/force sign-outs (guarded by an Admin Key)
 *
 * ENV (optional):
 *  NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY
 *  NEXT_PUBLIC_ASP_ADMIN_KEY (simple client-side guard for admin tools)
 */

// ---------- Helpers ----------
const TZ = "America/New_York"; // enforce ASP timezone
const TWO_HOURS_SEC = 2 * 60 * 60;

function nyNow() {
  // returns a Date object representing current time in America/New_York as wall-clock
  return new Date();
}

function isAspOpen(date = nyNow()) {
  // ASP hours: Monday & Wednesday 19:30–21:30 local
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

// ---------- Persistence boundary ----------
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

// Data shapes
type Klass = '3C' | '4C';

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
  id: string;           // UUID
  cadet_id: string;
  sign_in: string;      // ISO
  sign_out: string | null; // ISO or null if active
  voided?: boolean;
};

// LocalStorage fallback keys
const LS_CADET = "asp_current_cadet";
const LS_ACTIVE_SESSION = "asp_active_session";
const LS_SESSIONS = "asp_sessions"; // historical for leaderboard demo

// small helper for safe error messages
function errMsg(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}

// ---------- Core Component ----------
export default function ASPApp() {
  const [cadet, setCadet] = useState<Cadet | null>(null);
  const [klass, setKlass] = useState<'3C'|'4C'|'none'>("none");
  const [name, setName] = useState("");
  const [company, setCompany] = useState("G1");
  const [activeSession, setActiveSession] = useState<Session | null>(null);
  const [leaderboard, setLeaderboard] = useState<Array<{name:string; klass:'3C'|'4C'; company:string; totalMin:number}>>([]);
  const [adminMode, setAdminMode] = useState(false);
  const [adminKey, setAdminKey] = useState("");
  const [allActive, setAllActive] = useState<Array<{session: Session; cadet: Cadet}>>([]);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  // "now" ticker for live timer (updates every second when signed in)
  const [nowTs, setNowTs] = useState<number>(Date.now());

  // Load cached identity
  useEffect(() => {
    const c = localStorage.getItem(LS_CADET);
    if (c) setCadet(JSON.parse(c));
    const s = localStorage.getItem(LS_ACTIVE_SESSION);
    if (s) setActiveSession(JSON.parse(s));
  }, []);

  // Live timer + auto sign-out at 2 hours (client-side safety)
  useEffect(() => {
    if (!activeSession || activeSession.sign_out) return;

    // 1) tick every second so the HH:MM:SS UI updates
    const intId = window.setInterval(() => setNowTs(Date.now()), 1000);

    // 2) auto sign-out exactly at 2h after sign_in
    const startMs = new Date(activeSession.sign_in).getTime();
    const endMs = startMs + TWO_HOURS_SEC * 1000;
    const delay = Math.max(0, endMs - Date.now());

    const toId = window.setTimeout(async () => {
      const iso = new Date(endMs).toISOString();
      if (hasSupabase && supabase) {
        await supabase.from('sessions').update({ sign_out: iso }).eq('id', activeSession.id);
      } else {
        const hist = JSON.parse(localStorage.getItem(LS_SESSIONS) || "[]") as Session[];
        const idx = hist.findIndex(s => s.id === activeSession.id);
        if (idx>=0) { hist[idx].sign_out = iso; localStorage.setItem(LS_SESSIONS, JSON.stringify(hist)); }
      }
      setActiveSession(null);
      localStorage.removeItem(LS_ACTIVE_SESSION);
      setStatusMsg("Auto signed out after 2 hours.");
      fetchLeaderboard();
      if (adminMode) fetchAllActive();
    }, delay);

    return () => {
      window.clearInterval(intId);
      window.clearTimeout(toId);
    };
  }, [activeSession?.id, activeSession?.sign_in, activeSession?.sign_out, adminMode]);

  // Demo data for leaderboard if no Supabase
  useEffect(() => { fetchLeaderboard(); if (adminMode) fetchAllActive(); }, [adminMode]);

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

    // Fallback to localStorage aggregation (all-time)
    const raw = JSON.parse(localStorage.getItem(LS_SESSIONS) || "[]") as Session[];
    const ids = new Set(raw.map(r => r.cadet_id));
    const rows: Array<{name:string; klass:'3C'|'4C'; company:string; totalMin:number}> = [];
    ids.forEach(id => {
      const c = JSON.parse(localStorage.getItem(`${LS_CADET}_${id}`) || "null") as Cadet | null;
      if (!c) return;
      const total = raw
        .filter(s => s.cadet_id === id)
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
              id: row.id,
              cadet_id: row.cadet_id,
              sign_in: row.sign_in,
              sign_out: row.sign_out,
              voided: row.voided,
            },
            cadet: {
              id: row.cadets.id,
              name: row.cadets.name,
              klass: row.cadets.klass,
              company: row.cadets.company,
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

  // ----- Admin maintenance helpers -----
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
      setStatusMsg(`Removed cadet's leaderboard entry.`);
    } catch (e: unknown) {
      setStatusMsg(`Failed to remove entry: ${errMsg(e)}`);
    } finally {
      fetchLeaderboard();
      fetchAllActive();
    }
  }

  async function resetLeaderboardAll() {
    if (!confirm("Reset leaderboard for everyone? This will void all sessions.")) return;
    try {
      if (hasSupabase && supabase) {
        const { error } = await supabase
          .from("sessions")
          .update({ voided: true })
          .eq("voided", false);
        if (error) throw error;
      } else {
        const hist = JSON.parse(localStorage.getItem(LS_SESSIONS) || "[]") as Session[];
        const updated = hist.map(s => ({ ...s, voided: true }));
        localStorage.setItem(LS_SESSIONS, JSON.stringify(updated));
      }
      setStatusMsg("Leaderboard reset complete.");
    } catch (e: unknown) {
      setStatusMsg(`Reset failed: ${errMsg(e)}`);
    } finally {
      fetchLeaderboard();
      fetchAllActive();
    }
  }

  function withinAspHours() { return isAspOpen(nyNow()); }

  function saveLocalCadet(c: Cadet) {
    localStorage.setItem(LS_CADET, JSON.stringify(c));
    localStorage.setItem(`${LS_CADET}_${c.id}`, JSON.stringify(c));
  }

  async function handleSignIn() {
    if (!name || (klass !== '3C' && klass !== '4C')) { setStatusMsg("Enter your name and class year."); return; }
    if (!withinAspHours() && !adminMode) { setStatusMsg("ASP is closed right now (Mon/Wed 19:30–21:30 ET)."); return; }

    const typedName = name.trim();
    let c: Cadet = { id: crypto.randomUUID(), name: typedName, klass, company };

    if (hasSupabase && supabase) {
      // Try to find an existing cadet by identity so multiple people can sign in from the same device
      const { data: existing } = await supabase
        .from('cadets')
        .select('id')
        .eq('name', typedName)
        .eq('klass', klass)
        .eq('company', company)
        .maybeSingle();

      if (existing) {
        c.id = (existing as { id: string }).id; // reuse the existing cadet's id
      }

      // Upsert by id (safe if found above or newly generated)
      const { error: cadetErr } = await supabase
        .from('cadets')
        .upsert({ id: c.id, name: c.name, klass: c.klass, company: c.company }, { onConflict: 'id' });

      if (cadetErr) { setStatusMsg(`Cadet save failed: ${cadetErr.message}`); return; }
    } else {
      // Local-only fallback: if switching identity, don't reuse the cached cadet
      if (cadet && (cadet.name !== typedName || cadet.klass !== klass || cadet.company !== company)) {
        c.id = crypto.randomUUID(); // new identity → new id
      } else if (cadet) {
        c = cadet; // same identity → reuse
      }
    }

    setCadet(c);
    saveLocalCadet(c);

    const nowIso = new Date().toISOString();
    let newSession: Session = { id: crypto.randomUUID(), cadet_id: c.id, sign_in: nowIso, sign_out: null };

    if (hasSupabase && supabase) {
      // Ensure cadet exists (and surface errors clearly)
      const { error: cadetErr } = await supabase
        .from('cadets')
        .upsert(
          { id: c.id, name: c.name, klass: c.klass, company: c.company },
          { onConflict: 'id' }
        );

      if (cadetErr) {
        setStatusMsg(`Cadet save failed: ${cadetErr.message}`);
        return;
      }

      // Only insert session if cadet write succeeded
      const { data, error: sessionErr } = await supabase
        .from('sessions')
        .insert({ id: newSession.id, cadet_id: c.id, sign_in: nowIso, sign_out: null })
        .select()
        .single();

      if (sessionErr) {
        setStatusMsg(`Sign-in failed: ${sessionErr.message}`);
        return;
      }

      newSession = {
        id: (data as { id: string }).id,
        cadet_id: (data as { cadet_id: string }).cadet_id,
        sign_in: (data as { sign_in: string }).sign_in,
        sign_out: (data as { sign_out: string | null }).sign_out
      };
    } else {
      // local history list
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
    return Math.min(sec, TWO_HOURS_SEC); // cap display at 2h
  }

  function totalFor() {
    // Only local aggregation of cached sessions for current user (used to show lifetime total)
    const c = cadet; if (!c) return 0;
    const sessions = JSON.parse(localStorage.getItem(LS_SESSIONS) || "[]") as Session[];
    return sessions
      .filter(s => s.cadet_id === c.id)
      .reduce((acc, s) => acc + msToMin(new Date(s.sign_out ?? new Date()).getTime() - new Date(s.sign_in).getTime()), 0);
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

  // --- Admin toggle ---
  function disableAdmin() {
    setAdminMode(false);
    setAdminKey('');
    if (typeof window !== 'undefined') {
      localStorage.removeItem('asp_admin_unlocked');
    }
    setStatusMsg('Admin disabled.');
  }

  const openNow = withinAspHours();
  const nextWindow = useMemo(() => {
    // Compute next ASP window (Mon/Wed 19:30–21:30 ET) text
    const now = nyNow();
    const targetDays = [1, 3]; // Mon, Wed
    const candidates: Date[] = [];
    for (let add = 0; add < 8; add++) {
      const d = new Date(now); d.setDate(now.getDate() + add);
      const dow = d.getDay();
      if (targetDays.includes(dow)) {
        // 19:30
        const dt = new Date(d);
        dt.setHours(19,30,0,0);
        candidates.push(dt);
      }
    }
    const upcoming = candidates.find(d => d.getTime() > now.getTime()) || candidates[0];
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday:'long', month:'short', day:'numeric', hour:'numeric', minute:'2-digit' });
    return fmt.format(upcoming);
  }, []);

  const userTotal = totalFor();

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
              <div className="font-medium">Company G1 • 3C & 4C</div>
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
                <SelectTrigger><SelectValue placeholder="Class (3C or 4C)" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="3C">3C</SelectItem>
                  <SelectItem value="4C">4C</SelectItem>
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
              <div className="text-xs text-slate-500">Calculated automatically from your lifetime minutes.</div>
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
                {cadet && <div className="text-sm text-slate-600 mt-2">Lifetime: <span className="font-semibold">{formatHM(userTotal)}</span> • PMI days: <span className="font-semibold">{Math.floor(userTotal/240)}</span></div>}
              </div>
              <div className="text-xs text-slate-600 bg-slate-50 rounded-xl p-3">
                <div className="font-semibold mb-1">Rules</div>
                <ul className="list-disc pl-4 space-y-1">
                  <li>Sign in when you arrive; sign out when you leave.</li>
                  <li>Sessions only count during ASP hours.</li>
                  <li>Leaving without signing out may require admin correction.</li>
                </ul>
              </div>
            </CardContent>
          </Card>

          <Card className="shadow-sm">
            <CardHeader><CardTitle className="text-base flex items-center gap-2"><Trophy className="w-4 h-4"/> Leaderboard</CardTitle></CardHeader>
            <CardContent>
              <Tabs defaultValue="all">
                <TabsList>
                  <TabsTrigger value="all">All</TabsTrigger>
                  <TabsTrigger value="3C">3C</TabsTrigger>
                  <TabsTrigger value="4C">4C</TabsTrigger>
                </TabsList>
                {['all','3C','4C'].map((tab) => (
                  <TabsContent key={tab} value={tab}>
                    <Table>
                      <TableCaption>Total minutes (all-time).</TableCaption>
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
                <div className="space-y-3">
                  {/* Admin status + disable */}
                  <div className="flex items-center justify-between">
                    <div className="text-xs text-green-700 bg-green-50 rounded px-2 py-1">
                      Admin mode enabled
                    </div>
                    <Button size="sm" variant="outline" onClick={disableAdmin}>
                      Disable admin
                    </Button>
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
                        <Button size="sm" variant="destructive" onClick={async ()=>{
                          if (!confirm(`Remove ${r.name}'s sessions from leaderboard?`)) return;
                          if (hasSupabase && supabase) {
                            const { data: cad } = await supabase
                              .from('cadets').select('id').eq('name', r.name).eq('klass', r.klass).eq('company', r.company).single();
                            if (!cad) { setStatusMsg('Could not resolve cadet id.'); return; }
                            await voidCadetSessions((cad as { id: string }).id);
                          } else if (cadet && cadet.name === r.name) {
                            await voidCadetSessions(cadet.id);
                          }
                        }}>Remove Entry</Button>
                      </div>
                    ))}
                    <div className="flex gap-2">
                      <Button variant="destructive" onClick={resetLeaderboardAll}>Reset Leaderboard</Button>
                    </div>
                  </div>

                  <div className="flex items-start gap-2 text-amber-700 bg-amber-50 p-3 rounded-xl">
                    <AlertTriangle className="w-4 h-4 mt-0.5"/>
                    <div className="text-xs">
                      Admin tools are client-guarded only. Use RLS on the backend to enforce security.
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
