'use strict';
const ICON = { CRITICAL: '🔴', HIGH: '🟠', MEDIUM: '🟡', LOW: '🟢' };

function utc(iso) {
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toISOString().slice(11, 16) + ' UTC';
}
function card(headText, fields) {
  const el = document.createElement('div');
  el.className = 'card';
  const head = document.createElement('div');
  head.className = 'head';
  head.textContent = headText;
  el.appendChild(head);
  for (const [label, value] of fields) {
    const l = document.createElement('div');
    l.className = 'label';
    l.textContent = label + ':';
    const v = document.createElement('div');
    v.className = 'value';
    v.textContent = value;
    el.append(l, v);
  }
  return el;
}
function fill(id, items, build, emptyText) {
  const box = document.getElementById(id);
  box.replaceChildren();
  if (!items.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = emptyText;
    box.appendChild(p);
    return;
  }
  items.forEach(i => box.appendChild(build(i)));
}
async function load(file) {
  const res = await fetch(file + '?t=' + Date.now(), { cache: 'no-store' });
  if (!res.ok) throw new Error(file + ' ' + res.status);
  return res.json();
}
async function refresh() {
  try {
    const [active, resolved] = await Promise.all([load('incidents.json'), load('resolved.json')]);
    fill('active', active, i => card(`${ICON[i.severity] || ''} ${i.severity}`, [
      ['Airport', i.airport],
      ['Issue', i.type],
      ['Affected Airlines', i.airlines.length ? i.airlines.join('\n') : 'Not specified'],
      ['Estimated Delay', `${i.delayMinutes} Minutes`],
      ...(i.cancellations ? [['Cancellations', String(i.cancellations)]] : []),
      ['Customer Impact', i.customerImpact],
      ['Verified By', i.verifiedBy.join('\n')],
      ['Status', i.status],
      ['Last Updated', utc(i.lastUpdated)],
      ['Incident ID', i.id]
    ]), 'No active incidents.');
    fill('resolved', resolved, i => card('✅ RESOLVED', [
      ['Airport', i.airport],
      ['Issue', i.type],
      ['Resolved', utc(i.resolved)],
      ['Status', 'RESOLVED']
    ]), 'No resolved incidents.');
  } catch (e) {
    document.getElementById('active').textContent = 'Could not load incident data.';
  }
}
refresh();
setInterval(refresh, 60000);
