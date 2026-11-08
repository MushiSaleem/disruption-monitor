
'use strict';
/*
 * Travel Disruption Verification Engine - runs inside GitHub Actions (nothing to install).
 * Reads sources.json, verifies incidents (2+ independent sources), writes
 * incidents.json, resolved.json and state.json.
 */
const fs = require('fs');
const path = require('path');

const WATCH = ['LHR','JFK','EWR','ATL','ORD','DFW','LAX','FRA','AMS','CDG','SIN','HKG','HND','NRT','DOH','DXB','SYD'];
const AIRPORT_NAMES = {
  heathrow:'LHR', kennedy:'JFK', newark:'EWR', hartsfield:'ATL', atlanta:'ATL', "o'hare":'ORD', ohare:'ORD',
  'dallas/fort worth':'DFW', 'dallas fort worth':'DFW', 'los angeles':'LAX', frankfurt:'FRA',
  schiphol:'AMS', amsterdam:'AMS', 'charles de gaulle':'CDG', changi:'SIN', singapore:'SIN',
  'hong kong':'HKG', haneda:'HND', narita:'NRT', hamad:'DOH', doha:'DOH', dubai:'DXB', sydney:'SYD'
};
const AIRLINES = {
  'british airways':'BA','qatar airways':'QR','virgin atlantic':'VS','american airlines':'AA','lufthansa':'LH',
  'air france':'AF','klm':'KL','emirates':'EK','singapore airlines':'SQ','turkish airlines':'TK','etihad':'EY',
  'delta':'DL','united airlines':'UA','jetblue':'B6','southwest':'WN','qantas':'QF','cathay pacific':'CX',
  'japan airlines':'JL','all nippon':'NH','virgin australia':'VA','jetstar':'JQ','alaska airlines':'AS'
};

// Only these events are monitored. First match wins. key = AIRPORT_CODE
const TYPES = [
  { code:'GROUND_STOP', re:/ground stop/,                                   label:()=>'Ground Stop' },
  { code:'RUNWAY',      re:/runway (is |has been )?(clos|shut)|runway closure|closure of (the )?runway/, label:()=>'Runway Closure' },
  { code:'CLOSURE',     re:/airport (is |has been |remains )?(temporarily )?(clos|shut)|airport closure|closed to (all )?(traffic|flights)/, label:()=>'Airport Closure' },
  { code:'ASH',         re:/volcanic ash|ash cloud/,                        label:()=>'Volcanic Ash' },
  { code:'AIRSPACE',    re:/airspace (restriction|closure|closed)|restricted airspace|no-fly/, label:()=>'Airspace Restriction' },
  { code:'GROUNDING',   re:/grounded|grounding of|aircraft grounding/,      label:()=>'Aircraft Grounding' },
  { code:'SECURITY',    re:/security (incident|alert|breach)|evacuat|suspicious (item|package)|bomb/, label:()=>'Security Incident' },
  { code:'ATC',         re:/air traffic|\batc\b|\bnats\b/,                  label:t=>/strike|industrial action/.test(t)?'ATC Strike':'ATC Failure' },
  { code:'SYSTEM',      re:/sabre|amadeus|travelport|system outage|it outage|check-in system|reservation system|departure control|technical (failure|outage)|network outage/,
                       label:t=>/sabre/.test(t)?'Sabre Outage':/amadeus/.test(t)?'Amadeus Outage':/travelport/.test(t)?'Travelport Outage':'Airline System Outage' },
  { code:'WEATHER',     re:/weather|thunderstorm|tstms|storm|snow|fog|high wind|cyclone|typhoon|hurricane|flood|blizzard/,
                       label:t=>/typhoon/.test(t)?'Typhoon':/cyclone|hurricane/.test(t)?'Cyclone':'Severe Weather' }
];
const DISRUPT = /delay|cancel|clos|stop|suspend|outage|disrupt|divert|ground|evacuat|restrict|unavailable|strike|shut|ash/;
const STRONG  = /cancel|closed|closure|ground stop|suspend|outage|strike|evacuat|shut/;
const IGNORE  = /press release|profit|earnings|new route|aircraft order|appoint|announces? (plans|partnership)|opinion|blog|rumou?r|marketing|sponsor|award/;
const RESOLVED_RE = /resumed|back to normal|operating normally|operating as normal|fully operational|lifted|restored|resolved|cleared|reopened/;
const SEVERE_WX = /severe|cyclone|typhoon|hurricane|tropical storm|blizzard|ice storm/;

const MISS_LIMIT = 3;         // clean checks in a row (3 x 10 min = 30 min) -> resolved
const DELAY_JUMP = 30;        // minutes
const CANCEL_JUMP = 25;       // flights = "significant"
const ORDER = ['LOW','MEDIUM','HIGH','CRITICAL'];
const IMPACT = { CRITICAL:'Travel Not Advised', HIGH:'Rebook Recommended', MEDIUM:'Expect Delays', LOW:'Monitor' };

// ---------- helpers ----------
function findAirports(text) {
  const out = new Set(WATCH.filter(c => new RegExp('\\b' + c + '\\b').test(text)));
  const low = text.toLowerCase();
  for (const [n, c] of Object.entries(AIRPORT_NAMES)) if (low.includes(n)) out.add(c);
  return [...out];
}
function parseMinutes(text) {
  const low = text.toLowerCase(); const vals = [];
  let rest = low.replace(/(\d+)\s*(?:hours?|hrs?)\s*(?:and\s*)?(\d+)\s*min\w*/g, (_, h, m) => { vals.push(+h * 60 + +m); return ' '; });
  for (const m of rest.matchAll(/(\d+(?:\.\d+)?)\s*(?:hours?|hrs?)\b/g)) vals.push(Math.round(+m[1] * 60));
  for (const m of rest.matchAll(/(\d+)\s*(?:minutes?|mins?)\b/g)) vals.push(+m[1]);
  return vals.length ? Math.max(...vals) : null;
}
function parseCancels(text) {
  const low = text.toLowerCase(); const vals = [];
  for (const m of low.matchAll(/(\d+)\s+(?:\w+\s+){0,2}?cancel/g)) vals.push(+m[1]);
  for (const m of low.matchAll(/cancel\w*\s+(?:of\s+)?(\d+)/g)) vals.push(+m[1]);
  return vals.length ? Math.max(...vals) : null;
}
function chunks(html) {
  html = html.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ')
             .replace(/<br\s*\/?>|<\/(p|li|div|h\d|tr)>/gi, '\n');
  const text = html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;/g, "'");
  return text.split('\n').map(s => s.replace(/\s+/g, ' ').trim()).filter(s => s.length > 30);
}

// Turn raw text into a report, or null if it is not a monitored operational disruption.
function makeReport(src, airport, text, opts = {}) {
  const low = text.toLowerCase();
  if (!opts.force) {
    if (!DISRUPT.test(low)) return null;
    if (IGNORE.test(low) && !STRONG.test(low)) return null;
  }
  const type = TYPES.find(t => t.re.test(opts.typeText ? opts.typeText.toLowerCase() : low));
  if (!type) return null;                                   // not one of the monitored events
  const delay = opts.delay != null ? opts.delay : parseMinutes(text);
  const cancels = parseCancels(text);
  if (type.code === 'WEATHER' && !(SEVERE_WX.test(low) || (delay || 0) >= 30 || (cancels || 0) > 10)) return null;
  return {
    group: src.group || src.id, source: src.name, airport, type: type.code, label: type.label(low),
    airlines: [...new Set([
      ...Object.entries(AIRLINES).filter(([n]) => low.includes(n)).map(([, c]) => c),
      ...Object.values(AIRLINES).filter(c => new RegExp('\\b' + c + '\\b').test(text))])].sort(),
    delay: delay || 0, cancels: cancels || 0, resolved: RESOLVED_RE.test(low)
  };
}

// ---------- connectors ----------
function parseFaa(xml, src) {
  const out = [];
  for (const block of xml.split(/<Delay_type>/i).slice(1)) {
    const name = ((block.match(/<Name>([\s\S]*?)<\/Name>/i) || [])[1] || '').trim();
    const segs = block.split(/<ARPT>/i).slice(1);
    for (const seg of segs) {
      const code = (seg.split(/<\/ARPT>/i)[0] || '').trim().toUpperCase();
      if (!WATCH.includes(code)) continue;
      const reason = ((seg.match(/<Reason>([\s\S]*?)<\/Reason>/i) || [])[1] || '').trim();
      const avg = (seg.match(/<Avg>([\s\S]*?)<\/Avg>/i) || [])[1];
      const delay = parseMinutes(avg || seg.replace(/<[^>]+>/g, ' '));
      let typeText = `${reason}`;
      if (/ground stop/i.test(name)) typeText = 'ground stop ' + reason;
      else if (/closure/i.test(name)) typeText = 'airport closure ' + reason;
      const r = makeReport(src, code, `${name} ${reason} ${seg.replace(/<[^>]+>/g, ' ')}`, { force: true, typeText, delay });
      if (r) out.push(r);
    }
  }
  return out;
}
function parseWeb(body, src) {
  let texts;
  try {                                           // Atlassian Statuspage JSON (unresolved incidents)
    const j = JSON.parse(body);
    texts = (j.incidents || []).filter(i => !['resolved', 'postmortem'].includes(i.status))
      .map(i => `${i.name}. ${((i.incident_updates || [])[0] || {}).body || ''}`);
  } catch { texts = chunks(body); }
  const out = [];
  for (const t of texts) {
    const airports = src.airport ? [src.airport] : findAirports(t);
    for (const a of airports) { const r = makeReport(src, a, t); if (r) out.push(r); }
  }
  return out;
}
async function collect(sources, fetchText, log) {
  const reports = []; let allOk = true;
  for (const src of sources) {
    if (!src.url) continue;                                     // not configured yet
    if (String(src.kind || '').toLowerCase() === 'news') { log(`skip ${src.name}: news is never a source`); continue; }
    try {
      const body = await fetchText(src.url);
      reports.push(...(src.format === 'faa' ? parseFaa(body, src) : parseWeb(body, src)));
    } catch (e) { allOk = false; log(`source failed: ${src.name}: ${e.message}`); }
  }
  return { reports, allOk };
}

// ---------- verification ----------
function verify(reports) {
  const groups = {};
  for (const r of reports) (groups[`${r.airport}_${r.type}`] ||= []).push(r);
  const out = {};
  for (const [key, rs] of Object.entries(groups)) {
    const indep = new Set(rs.map(r => r.group));
    if (indep.size < 2) continue;                               // never from a single source
    out[key] = {
      airport: rs[0].airport, label: rs[0].label,
      airlines: [...new Set(rs.flatMap(r => r.airlines))].sort(),
      delay: Math.max(...rs.map(r => r.delay)), cancels: Math.max(...rs.map(r => r.cancels)),
      verifiedBy: [...new Set(rs.map(r => r.source))].sort(),
      resolved: rs.every(r => r.resolved), type: rs[0].type
    };
  }
  return out;
}
function severity(type, delay, cancels) {
  if (type === 'CLOSURE' || type === 'GROUND_STOP' || delay >= 120 || cancels > 200) return 'CRITICAL';
  if (delay >= 60 || cancels > 50) return 'HIGH';
  if (delay >= 30 || cancels > 10) return 'MEDIUM';
  return 'LOW';
}

// ---------- one cycle (pure: easy to test) ----------
function processCycle(data, reports, allOk, nowIso) {
  const { incidents, resolved, state } = data;
  const confirmed = verify(reports);
  const byKey = k => incidents.find(i => i.id === state.keyToId[k]);

  const close = (key, inc) => {
    resolved.unshift({ id: inc.id, airport: inc.airport, type: inc.type, resolved: nowIso, status: 'RESOLVED' });
    incidents.splice(incidents.indexOf(inc), 1);
    delete state.keyToId[key]; delete state.misses[key];
    resolved.length = Math.min(resolved.length, 100);
  };

  for (const [key, c] of Object.entries(confirmed)) {
    const inc = byKey(key);
    if (!inc) {
      if (c.resolved) continue;                                 // old "back to normal" text: nothing to open
      state.counter += 1;
      const id = 'INC-' + String(state.counter).padStart(4, '0');
      const sev = severity(c.type, c.delay, c.cancels);
      incidents.push({ id, airport: c.airport, type: c.label, severity: sev, status: 'NEW', airlines: c.airlines,
        delayMinutes: c.delay, cancellations: c.cancels, customerImpact: IMPACT[sev],
        verifiedBy: c.verifiedBy, lastUpdated: nowIso });
      state.keyToId[key] = id; state.misses[key] = 0;
      continue;
    }
    state.misses[key] = 0;
    if (c.resolved) { close(key, inc); continue; }
    // numbers only grow while an incident is open, so small wobbles never cause updates
    const airlines = [...new Set([...inc.airlines, ...c.airlines])].sort();
    const delay = Math.max(inc.delayMinutes, c.delay);
    const cancels = Math.max(inc.cancellations, c.cancels);
    let sev = severity(c.type, delay, cancels);
    if (ORDER.indexOf(sev) < ORDER.indexOf(inc.severity)) sev = inc.severity;
    const changed = sev !== inc.severity || airlines.join() !== inc.airlines.join()
      || delay - inc.delayMinutes > DELAY_JUMP || cancels - inc.cancellations > CANCEL_JUMP;
    inc.verifiedBy = [...new Set([...inc.verifiedBy, ...c.verifiedBy])].sort();
    if (changed) {
      Object.assign(inc, { severity: sev, airlines, delayMinutes: delay, cancellations: cancels,
        customerImpact: IMPACT[sev], status: 'UPDATED', lastUpdated: nowIso });
    } else if (inc.status === 'NEW' || inc.status === 'UPDATED') {
      inc.status = 'ACTIVE';                                    // quiet: no change to lastUpdated
    }
  }

  // Not reported any more: after MISS_LIMIT clean checks it is resolved.
  // If any source failed to load, that check does not count.
  for (const key of Object.keys(state.keyToId)) {
    if (key in confirmed || !allOk) continue;
    state.misses[key] = (state.misses[key] || 0) + 1;
    const inc = byKey(key);
    if (inc && state.misses[key] >= MISS_LIMIT) close(key, inc);
  }
  incidents.sort((a, b) => ORDER.indexOf(b.severity) - ORDER.indexOf(a.severity) || b.lastUpdated.localeCompare(a.lastUpdated));
}

// ---------- entry point used by the GitHub Action ----------
async function main({ root, core, fetchText, now }) {
  const log = m => (core ? core.info(m) : console.log(m));
  const rd = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(root, f), 'utf8')); } catch { return d; } };
  const wr = (f, v) => {
    const text = JSON.stringify(v, null, 2) + '\n', p = path.join(root, f);
    if (!fs.existsSync(p) || fs.readFileSync(p, 'utf8') !== text) fs.writeFileSync(p, text);
  };
  fetchText = fetchText || (async url => {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 DisruptionVerifier/3.0' }, signal: AbortSignal.timeout(25000) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.text();
  });
  const data = {
    incidents: rd('incidents.json', []), resolved: rd('resolved.json', []),
    state: Object.assign({ counter: 0, keyToId: {}, misses: {} }, rd('state.json', {}))
  };
  const { sources } = rd('sources.json', { sources: [] });
  const { reports, allOk } = await collect(sources, fetchText, log);
  processCycle(data, reports, allOk, (now || new Date()).toISOString());
  wr('incidents.json', data.incidents); wr('resolved.json', data.resolved); wr('state.json', data.state);
  log(`reports=${reports.length} active=${data.incidents.length} resolved=${data.resolved.length} allSourcesOk=${allOk}`);
}

module.exports = main;
module.exports.processCycle = processCycle;
module.exports.verify = verify;
module.exports.makeReport = makeReport;
module.exports.parseFaa = parseFaa;
