/* ==========================================================
   SqueegeeHQ — app.js
   Vanilla JS, Firebase (Firestore + Storage + Anonymous Auth),
   Google Maps JS API. No build step required.
   ========================================================== */

/* ---------------- tiny helpers ---------------- */
const $ = (sel, root=document) => root.querySelector(sel);
const $all = (sel, root=document) => Array.from(root.querySelectorAll(sel));
const pad2 = n => String(n).padStart(2,'0');
const ymd = d => `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
const todayStr = () => ymd(new Date());
const fmtMoney = n => `$${Number(n||0).toFixed(2)}`;
const fmtDateLabel = (dateStr) => {
  const [y,m,d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m-1, d);
  return dt.toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric' });
};
const escapeHtml = (s='') => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

/* --- month / recurring helpers --- */
const DAY_MS = 86400000;
const monthKey = (d) => `${d.getFullYear()}-${pad2(d.getMonth()+1)}`;
const monthLabel = (key) => {
  const [y,m] = key.split('-').map(Number);
  return new Date(y, m-1, 1).toLocaleDateString('en-US', { month:'short', year:'numeric' });
};
const monthLabelLong = (key) => {
  const [y,m] = key.split('-').map(Number);
  return new Date(y, m-1, 1).toLocaleDateString('en-US', { month:'long', year:'numeric' });
};
const addMonthsTs = (ts, n) => {
  const d = new Date(ts);
  d.setMonth(d.getMonth() + n);
  return d.getTime();
};
const daysSince = (ts) => Math.max(0, Math.floor((Date.now() - ts) / DAY_MS));

const TECH_COLORS = ['#37c8ff','#4fe0c4','#ffcc4d','#ff6b6b','#b98bff','#ff9ecb','#8bd17c','#ffa257'];
const VIBE_OPTIONS = ['😊 Friendly','🧐 Detail-oriented','⏰ In a hurry','🐶 Has pets','💬 Chatty','🤐 Quiet','💰 Price-conscious','✨ Wants it perfect'];
const STATUS_META = {
  sale:      { label:'Sale',      emoji:'✅', color:'var(--sale)' },
  attempted: { label:'Attempted', emoji:'🟡', color:'var(--attempted)' },
  lead:      { label:'Lead',      emoji:'🔵', color:'var(--lead)' },
  no:        { label:'No',        emoji:'❌', color:'var(--no)' },
  nosolicit: { label:'No Solicit',emoji:'🚫', color:'var(--nosolicit)' },
};
/* hex versions for map markers + charts */
const STATUS_HEX = {
  sale:'#3ee08a', attempted:'#ffcc4d', lead:'#6ea8ff', no:'#ff6b6b', nosolicit:'#0b0f16'
};
/* No-soliciting doors are excluded from every conversion rate —
   you never knocked them, so they shouldn't drag your numbers down. */
const COUNTED_STATUSES = ['sale','attempted','lead','no'];

function toast(msg, ms=2400){
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(()=> t.classList.add('hidden'), ms);
}

function openModal(html){
  $('#modalSheet').innerHTML = `<div class="modal-handle"></div><button class="modal-close" data-modal-close>✕</button>${html}`;
  $('#modalRoot').classList.remove('hidden');
}
function closeModal(){
  $('#modalRoot').classList.add('hidden');
  $('#modalSheet').innerHTML = '';
}
document.addEventListener('click', (e)=>{
  if(e.target.id === 'modalBackdrop' || e.target.hasAttribute('data-modal-close')) closeModal();
});

/* ---------------- global state ---------------- */
const state = {
  currentUser: null,
  settings: {},
  techs: [],
  jobs: [],
  customers: [],
  pins: [],
  currentView: 'home',
  calSelectedDate: todayStr(),
  calMonthCursor: new Date(),
  calTechFilter: 'all',
  mapReady: false,
  map: null,
  mapType: 'hybrid',
  markers: [],
  myLocation: null,
  myDot: null,
  myAccuracyCircle: null,
  geoWatchId: null,
  tempPin: null,
  pendingPhotoFile: null,
  // recurring / plans
  plansTab: 'followup',        // 'followup' | 'months'
  plansSelectedMonth: null,
  // stats
  statsRange: 'all',           // 'all' | '30' | '7'
  // lasso
  lassoActive: false,
  lassoLayer: null,
  lassoSvg: null,
  lassoPts: [],
  lassoDrawing: false,
  projOverlay: null,
};

/* ---------------- door-to-door stat math ---------------- */
function doorStats(pins){
  const c = { sale:0, attempted:0, lead:0, no:0, nosolicit:0 };
  pins.forEach(p => { if(c[p.status] !== undefined) c[p.status]++; });

  const knocked = c.sale + c.attempted + c.lead + c.no;   // no-soliciting excluded
  const answered = c.sale + c.lead + c.no;                 // someone came to the door
  const interested = c.sale + c.lead;

  const pct = (a,b) => b > 0 ? (a/b*100) : 0;

  return {
    ...c,
    knocked, answered, interested,
    totalLogged: pins.length,
    answerRate:  pct(answered, knocked),
    closeRate:   pct(c.sale, answered),
    leadRate:    pct(c.lead, answered),
    noRate:      pct(c.no, answered),
    doorToSale:  pct(c.sale, knocked),
    interestRate: pct(interested, answered),
  };
}
const pctStr = n => `${n.toFixed(1)}%`;

function calcEarning(job, tech){
  const commissionPct = (tech ? tech.commissionPct : state.settings.defaultCommissionPct) ?? 20;
  const tipsPct = state.settings.tipsPct ?? 100;
  const price = Number(job.price)||0;
  const tip = Number(job.tip)||0;
  return price * (commissionPct/100) + tip * (tipsPct/100);
}
function techById(id){ return state.techs.find(t => t.id === id); }

/* ---------------- Firebase init ---------------- */
let auth, db, storage;
function initFirebase(){
  firebase.initializeApp(FIREBASE_CONFIG);
  auth = firebase.auth();
  db = firebase.firestore();
  storage = firebase.storage();
}

function configLooksUnset(){
  return !FIREBASE_CONFIG || FIREBASE_CONFIG.apiKey === 'PASTE_ME' || !FIREBASE_CONFIG.apiKey;
}

async function boot(){
  if(configLooksUnset()){
    $('#splash').innerHTML = `
      <div class="splash-bubble">🛠️</div>
      <div class="splash-title" style="max-width:320px;">Almost there!</div>
      <div class="splash-sub" style="max-width:300px; margin-top:10px; line-height:1.5;">
        Open <b>firebase-config.js</b> and paste in your Firebase + Google Maps keys.
        Full steps are in SETUP.md.
      </div>`;
    return;
  }
  initFirebase();
  try{
    await auth.signInAnonymously();
  }catch(err){
    console.error(err);
    toast('Could not connect — check your Firebase config.');
  }
  auth.onAuthStateChanged(user=>{
    if(user) attachCoreListeners();
  });
}

let coreListenersAttached = false;
function attachCoreListeners(){
  if(coreListenersAttached) return;
  coreListenersAttached = true;

  db.collection('meta').doc('app').onSnapshot(doc=>{
    state.settings = doc.exists ? doc.data() : {};
    afterInitialLoad();
    if(!$('#app').classList.contains('hidden')) rerenderCurrentView();
  });

  db.collection('techs').orderBy('createdAt','asc').onSnapshot(snap=>{
    state.techs = snap.docs.map(d=>({ id:d.id, ...d.data() }));
    if($('#techLoginForm') && !$('#techLoginForm').classList.contains('hidden')) renderTechPickList();
    if(!$('#app').classList.contains('hidden')) rerenderCurrentView();
  });

  db.collection('jobs').orderBy('date','asc').onSnapshot(snap=>{
    state.jobs = snap.docs.map(d=>({ id:d.id, ...d.data() }));
    if(!$('#app').classList.contains('hidden')) rerenderCurrentView();
  });

  db.collection('customers').onSnapshot(snap=>{
    state.customers = snap.docs.map(d=>({ id:d.id, ...d.data() }));
  });

  db.collection('pins').orderBy('timestamp','desc').onSnapshot(snap=>{
    state.pins = snap.docs.map(d=>({ id:d.id, ...d.data() }));
    if(state.mapReady) drawMapMarkers();
    if(!$('#app').classList.contains('hidden')) rerenderCurrentView();
  });
}

let didInitialLoad = false;
function afterInitialLoad(){
  if(didInitialLoad) return;
  didInitialLoad = true;
  $('#splash').classList.add('hidden');
  const saved = loadSession();
  if(saved){
    completeLogin(saved, true);
  }else{
    $('#loginScreen').classList.remove('hidden');
  }
}

/* ---------------- session ---------------- */
function saveSession(session){ localStorage.setItem('shq_session', JSON.stringify(session)); }
function loadSession(){
  try{ return JSON.parse(localStorage.getItem('shq_session')); }catch(e){ return null; }
}
function clearSession(){ localStorage.removeItem('shq_session'); }

/* ---------------- LOGIN SCREEN ---------------- */
$('#btnChooseOwner').addEventListener('click', chooseOwner);
$('#btnChooseTech').addEventListener('click', chooseTech);
$all('[data-back]').forEach(b => b.addEventListener('click', backToChooser));
$('#ownerLoginBtn').addEventListener('click', submitOwnerLogin);
$('#techLoginBtn').addEventListener('click', submitTechLogin);

function backToChooser(){
  $('#ownerLoginForm').classList.add('hidden');
  $('#techLoginForm').classList.add('hidden');
  $('#roleChooser').classList.remove('hidden');
  $('#ownerLoginMsg').textContent = '';
  $('#techLoginMsg').textContent = '';
}

let isOwnerSetupMode = false;
function chooseOwner(){
  $('#roleChooser').classList.add('hidden');
  $('#ownerLoginForm').classList.remove('hidden');
  isOwnerSetupMode = !state.settings || !state.settings.ownerPasscode;
  $('#ownerSetupExtra').classList.toggle('hidden', !isOwnerSetupMode);
  $('#ownerPasscodeLabel').textContent = isOwnerSetupMode ? 'Create a Passcode' : 'Owner Passcode';
  $('#ownerLoginBtn').textContent = isOwnerSetupMode ? 'Create Owner Account' : "Let's go";
  $('#ownerPasscodeInput').value = '';
  $('#ownerLoginMsg').textContent = '';
}

async function submitOwnerLogin(){
  const code = $('#ownerPasscodeInput').value.trim();
  if(code.length < 4){ $('#ownerLoginMsg').textContent = 'Use at least 4 digits.'; return; }

  if(isOwnerSetupMode){
    const bizName = $('#ownerBizNameInput').value.trim() || 'My Window Cleaning Co.';
    await db.collection('meta').doc('app').set({
      businessName: bizName,
      ownerPasscode: code,
      defaultCommissionPct: 20,
      tipsPct: 100,
      rebookMonths: 4,
      createdAt: Date.now()
    }, { merge:true });
    toast(`Welcome to SqueegeeHQ, ${bizName}! 🎉`);
    completeLogin({ role:'owner' });
  }else{
    if(code !== state.settings.ownerPasscode){
      $('#ownerLoginMsg').textContent = 'Wrong passcode, try again.';
      return;
    }
    completeLogin({ role:'owner' });
  }
}

let selectedTechIdForLogin = null;
function chooseTech(){
  $('#roleChooser').classList.add('hidden');
  $('#techLoginForm').classList.remove('hidden');
  $('#techPasscodeWrap').classList.add('hidden');
  selectedTechIdForLogin = null;
  renderTechPickList();
}
function renderTechPickList(){
  const list = $('#techPickList');
  if(!list) return;
  if(state.techs.length === 0){
    list.innerHTML = `<p class="form-msg" style="color:var(--text-dim);">No techs added yet — ask the owner to add you in the Team tab.</p>`;
    return;
  }
  list.innerHTML = state.techs.map(t => `
    <button class="tech-pick-item ${t.id===selectedTechIdForLogin?'selected':''}" data-tech-id="${t.id}">
      <span class="tech-dot" style="background:${t.color}"></span> ${escapeHtml(t.name)}
    </button>`).join('');
  $all('[data-tech-id]', list).forEach(btn=>{
    btn.addEventListener('click', ()=>{
      selectedTechIdForLogin = btn.getAttribute('data-tech-id');
      renderTechPickList();
      $('#techPasscodeWrap').classList.remove('hidden');
      $('#techPasscodeInput').value = '';
      $('#techPasscodeInput').focus();
    });
  });
}
function submitTechLogin(){
  if(!selectedTechIdForLogin){ $('#techLoginMsg').textContent = 'Pick your name first.'; return; }
  const tech = techById(selectedTechIdForLogin);
  const code = $('#techPasscodeInput').value.trim();
  if(!tech || code !== (tech.passcode || '')){
    $('#techLoginMsg').textContent = 'Wrong passcode, try again.';
    return;
  }
  completeLogin({ role:'tech', techId:tech.id });
}

function completeLogin(session, silent){
  if(session.role === 'owner'){
    state.currentUser = { role:'owner', name: state.settings.businessName || 'Owner' };
  }else{
    const tech = techById(session.techId);
    if(!tech){ clearSession(); $('#loginScreen').classList.remove('hidden'); return; }
    state.currentUser = { role:'tech', techId: tech.id, name: tech.name, color: tech.color, commissionPct: tech.commissionPct };
  }
  saveSession(session);
  $('#loginScreen').classList.add('hidden');
  showApp();
  if(!silent) toast(`Hey ${state.currentUser.name}! 👋`);
}

function logout(){
  clearSession();
  location.reload();
}

/* ---------------- APP SHELL / TABS ---------------- */
const TABS_OWNER = [
  { id:'home', emoji:'🏠', label:'Home' },
  { id:'map', emoji:'📍', label:'Map' },
  { id:'calendar', emoji:'📅', label:'Calendar' },
  { id:'plans', emoji:'🔁', label:'Plans' },
  { id:'stats', emoji:'📊', label:'Stats' },
  { id:'settings', emoji:'⚙️', label:'More' },
];
const TABS_TECH = [
  { id:'calendar', emoji:'📅', label:'Schedule' },
  { id:'earnings', emoji:'💰', label:'Earnings' },
  { id:'settings', emoji:'⚙️', label:'Settings' },
];

function showApp(){
  $('#app').classList.remove('hidden');
  const tabs = state.currentUser.role === 'owner' ? TABS_OWNER : TABS_TECH;
  $('#tabbar').classList.toggle('tabbar-tight', tabs.length > 5);
  $('#tabbar').innerHTML = tabs.map(t => `
    <button class="tab-item" data-tab="${t.id}">
      <span class="tab-emoji">${t.emoji}</span>${t.label}
    </button>`).join('');
  $all('.tab-item').forEach(btn=>{
    btn.addEventListener('click', ()=> switchView(btn.getAttribute('data-tab')));
  });
  $('#topbarAvatar').textContent = state.currentUser.role === 'owner' ? '👑' : '🧽';
  $('#topbarAvatar').addEventListener('click', ()=> switchView('settings'));
  switchView(tabs[0].id);
}

function switchView(viewId){
  state.currentView = viewId;
  $all('.view').forEach(v => v.classList.add('hidden'));
  $(`#view-${viewId}`).classList.remove('hidden');
  $all('.tab-item').forEach(b => b.classList.toggle('active', b.getAttribute('data-tab')===viewId));
  const titles = {
    home:['🏠','Home'], map:['📍','Door-to-Door'],
    calendar:['📅', state.currentUser.role==='owner' ? 'Calendar' : 'My Schedule'],
    plans:['🔁','Recurring Plans'], stats:['📊','Knock Stats'], team:['👥','Team'],
    earnings:['💰','Earnings'],
    settings:['⚙️', state.currentUser.role==='owner' ? 'More' : 'Settings']
  };
  const [emoji, label] = titles[viewId] || ['🫧','SqueegeeHQ'];
  $('#topbarEmoji').textContent = emoji;
  $('#topbarTitle').textContent = label;
  renderCurrentView();
}
function rerenderCurrentView(){ if(state.currentUser) renderCurrentView(); }
function renderCurrentView(){
  if(!state.currentUser) return;
  switch(state.currentView){
    case 'home': renderHome(); break;
    case 'map': renderMapView(); break;
    case 'calendar': renderCalendar(); break;
    case 'plans': renderPlans(); break;
    case 'stats': renderStats(); break;
    case 'team': renderTeam(); break;
    case 'earnings': renderEarnings(); break;
    case 'settings': renderSettings(); break;
  }
}

/* ==========================================================
   RECURRING / PLANS ENGINE
   Derived live from completed jobs — no separate collection,
   so all your existing job history feeds it automatically.
   ========================================================== */

function rebookCycle(){ return Number(state.settings.rebookMonths) || 4; }

function jobCompletedTs(job){
  if(job.completedAt) return job.completedAt;
  if(job.date){
    const [y,m,d] = job.date.split('-').map(Number);
    return new Date(y, m-1, d).getTime();
  }
  return Date.now();
}

function customerKeyOf(job){
  return job.customerId || `${(job.customerName||'').toLowerCase().trim()}|${(job.address||'').toLowerCase().trim()}`;
}

/* One entry per CUSTOMER (their most recent completed clean),
   so a house cleaned 3 times shows up once, not three times. */
function buildPlanEntries(){
  const latest = new Map();
  state.jobs.filter(j => j.status === 'completed').forEach(j=>{
    const key = customerKeyOf(j);
    const ts = jobCompletedTs(j);
    const prev = latest.get(key);
    if(!prev || ts > prev.ts) latest.set(key, { key, job:j, ts });
  });

  const cycle = rebookCycle();
  const now = Date.now();

  return Array.from(latest.values()).map(e=>{
    const cycleForThis = Number(e.job.rebookMonths) || cycle;
    const dueTs = addMonthsTs(e.ts, cycleForThis);
    const days = daysSince(e.ts);
    // already back on the books?
    const rebooked = state.jobs.some(j =>
      j.status === 'scheduled' && customerKeyOf(j) === e.key && jobCompletedTs(j) > e.ts
    );
    let urgency = 'later';
    if(now >= dueTs) urgency = 'due';
    else if(dueTs - now <= 30 * DAY_MS) urgency = 'soon';

    return {
      ...e,
      cycleForThis,
      dueTs,
      dueMonth: monthKey(new Date(dueTs)),
      days,
      rebooked,
      urgency,
      lastContactedAt: e.job.lastContactedAt || null,
    };
  });
}

function renderPlans(){
  const el = $('#plansContent');
  const entries = buildPlanEntries();
  const cycle = rebookCycle();

  if(entries.length === 0){
    el.innerHTML = `
      <div class="empty-state">
        <div class="empty-emoji">🔁</div>
        <div style="font-weight:800; color:var(--text-dim); margin-bottom:6px;">No recurring clients yet</div>
        <div style="font-size:13px;">As soon as a tech marks a job complete, that customer lands here on a ${cycle}-month rebooking clock.</div>
      </div>`;
    return;
  }

  const active = entries.filter(e=>!e.rebooked);
  const dueNow = active.filter(e=>e.urgency==='due');
  const potentialDue = dueNow.reduce((s,e)=> s + (Number(e.job.price)||0), 0);
  const pipeline12mo = entries.reduce((s,e)=> s + (Number(e.job.price)||0), 0);

  el.innerHTML = `
    <div class="stat-grid">
      <div class="stat-card"><div class="stat-emoji">🔔</div><div class="stat-value">${dueNow.length}</div><div class="stat-label">Ready to Reach Out</div></div>
      <div class="stat-card"><div class="stat-emoji">💵</div><div class="stat-value">${fmtMoney(potentialDue)}</div><div class="stat-label">Sitting on the Table</div></div>
      <div class="stat-card"><div class="stat-emoji">👥</div><div class="stat-value">${entries.length}</div><div class="stat-label">Past Clients</div></div>
      <div class="stat-card"><div class="stat-emoji">📈</div><div class="stat-value">${fmtMoney(pipeline12mo)}</div><div class="stat-label">Full Rebook Value</div></div>
    </div>

    <div class="tech-filter-row" style="margin-top:16px;">
      <button class="btn-pill ${state.plansTab==='followup'?'active':''}" data-plans-tab="followup">🔥 Follow Up</button>
      <button class="btn-pill ${state.plansTab==='months'?'active':''}" data-plans-tab="months">📆 By Month</button>
    </div>

    <div id="plansBody"></div>
  `;

  $all('[data-plans-tab]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      state.plansTab = btn.getAttribute('data-plans-tab');
      renderPlans();
    });
  });

  if(state.plansTab === 'followup') renderPlansFollowUp(entries);
  else renderPlansMonths(entries);
}

/* ---- Follow-up list: longest-since-cleaned first ---- */
function renderPlansFollowUp(entries){
  const body = $('#plansBody');
  const cycle = rebookCycle();

  const active = entries.filter(e=>!e.rebooked).sort((a,b)=> b.days - a.days);
  const booked = entries.filter(e=>e.rebooked);

  if(active.length === 0){
    body.innerHTML = `<div class="empty-state"><div class="empty-emoji">🎉</div>Everyone's already rebooked. Great work.</div>`;
    return;
  }

  body.innerHTML = `
    <div class="section-title">Priority — longest since cleaned</div>
    ${active.map(e=>planCardHtml(e)).join('')}
    ${booked.length ? `<div class="section-title">Already Rebooked ✅</div>${booked.map(e=>planCardHtml(e)).join('')}` : ''}
    <p style="text-align:center; color:var(--text-faint); font-size:12px; margin-top:18px;">
      Rebooking cycle is ${cycle} months — change it in Settings.
    </p>
  `;
  attachPlanCardHandlers(body);
}

function planCardHtml(e){
  const j = e.job;
  const urgencyClass = e.rebooked ? 'plan-booked' : `plan-${e.urgency}`;
  const dot = e.rebooked ? '#3ee08a' : (e.urgency==='due' ? '#ff6b6b' : e.urgency==='soon' ? '#ffcc4d' : '#6ea8ff');
  const contacted = e.lastContactedAt
    ? `<span class="plan-contacted">📞 ${daysSince(e.lastContactedAt)}d ago</span>` : '';
  return `
    <button class="job-card plan-card ${urgencyClass}" data-plan-key="${escapeHtml(e.key)}">
      <span class="job-dot" style="background:${dot}"></span>
      <span class="job-info">
        <span class="job-name">${escapeHtml(j.customerName || 'Customer')}</span>
        <span class="job-sub">${escapeHtml(j.address || 'no address')}</span>
        <span class="plan-meta">
          <span class="plan-days">${e.days} days since cleaned</span>
          ${contacted}
        </span>
      </span>
      <span style="text-align:right; flex-shrink:0;">
        <span class="job-price">${fmtMoney(j.price)}</span>
        <span class="plan-due">${e.rebooked ? 'booked' : monthLabel(e.dueMonth)}</span>
      </span>
    </button>`;
}

function attachPlanCardHandlers(root){
  $all('[data-plan-key]', root).forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const key = btn.getAttribute('data-plan-key');
      const entry = buildPlanEntries().find(e=>e.key === key);
      if(entry) openPlanDetail(entry);
    });
  });
}

/* ---- Month calendar: months only, no individual days ---- */
function renderPlansMonths(entries){
  const body = $('#plansBody');
  const now = new Date();
  const startKey = monthKey(now);

  // build 12 months forward from this month
  const months = [];
  for(let i=0; i<12; i++){
    const d = new Date(now.getFullYear(), now.getMonth()+i, 1);
    months.push(monthKey(d));
  }

  // anything overdue (due month already passed) rolls into the current month bucket
  const bucket = {};
  months.forEach(m => bucket[m] = []);
  entries.forEach(e=>{
    if(e.rebooked) return;
    const k = (e.dueMonth < startKey) ? startKey : e.dueMonth;
    if(bucket[k]) bucket[k].push(e);
  });

  if(!state.plansSelectedMonth || !bucket[state.plansSelectedMonth]) state.plansSelectedMonth = startKey;

  body.innerHTML = `
    <div class="section-title">Potential rebookings by month</div>
    <div class="month-grid">
      ${months.map(m=>{
        const list = bucket[m];
        const revenue = list.reduce((s,e)=> s + (Number(e.job.price)||0), 0);
        const isSel = m === state.plansSelectedMonth;
        const isNow = m === startKey;
        return `
          <button class="month-card ${isSel?'selected':''} ${isNow?'is-now':''}" data-month="${m}">
            <span class="month-name">${monthLabel(m).split(' ')[0]}</span>
            <span class="month-year">${m.split('-')[0]}</span>
            <span class="month-count">${list.length}</span>
            <span class="month-rev">${revenue ? fmtMoney(revenue) : '—'}</span>
          </button>`;
      }).join('')}
    </div>
    <div class="section-title">${monthLabelLong(state.plansSelectedMonth)}${state.plansSelectedMonth===startKey ? ' · includes anyone overdue' : ''}</div>
    <div id="monthList"></div>
  `;

  $all('[data-month]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      state.plansSelectedMonth = btn.getAttribute('data-month');
      renderPlans();
    });
  });

  const list = bucket[state.plansSelectedMonth].sort((a,b)=> b.days - a.days);
  const listEl = $('#monthList');
  if(list.length === 0){
    listEl.innerHTML = `<div class="empty-state"><div class="empty-emoji">🗓️</div>Nobody due this month.</div>`;
  }else{
    const rev = list.reduce((s,e)=> s + (Number(e.job.price)||0), 0);
    listEl.innerHTML = `
      <div class="card" style="text-align:center; padding:14px;">
        <b style="font-size:20px; color:var(--accent-2);">${fmtMoney(rev)}</b>
        <div style="font-size:12px; color:var(--text-dim); margin-top:2px;">potential revenue from ${list.length} client${list.length===1?'':'s'}</div>
      </div>
      ${list.map(e=>planCardHtml(e)).join('')}`;
    attachPlanCardHandlers(listEl);
  }
}

function openPlanDetail(e){
  const j = e.job;
  const phone = (state.customers.find(c=>c.id===j.customerId)||{}).phone || '';
  const urgencyText = e.rebooked ? '✅ Already rebooked'
    : e.urgency==='due' ? '🔴 Ready to reach out now'
    : e.urgency==='soon' ? '🟡 Coming due soon'
    : '🔵 Not due yet';

  openModal(`
    <div class="modal-title">${escapeHtml(j.customerName||'Customer')}</div>
    <div style="color:var(--text-dim); font-size:13px; margin-bottom:12px;">${escapeHtml(j.address||'')}</div>
    ${j.photoURL ? `<img src="${j.photoURL}" class="photo-preview" />` : ''}

    <div class="earn-highlight">
      <div class="earn-amt">${e.days}</div>
      <div class="earn-label">days since last cleaned</div>
    </div>

    <div class="card">
      <div class="card-row"><span style="color:var(--text-dim);">Status</span><b>${urgencyText}</b></div>
      <div class="card-row" style="margin-top:8px;"><span style="color:var(--text-dim);">Last cleaned</span><b>${new Date(e.ts).toLocaleDateString()}</b></div>
      <div class="card-row" style="margin-top:8px;"><span style="color:var(--text-dim);">Due month</span><b>${monthLabelLong(e.dueMonth)}</b></div>
      <div class="card-row" style="margin-top:8px;"><span style="color:var(--text-dim);">Last job value</span><b>${fmtMoney(j.price)}</b></div>
      ${e.lastContactedAt ? `<div class="card-row" style="margin-top:8px;"><span style="color:var(--text-dim);">Last contacted</span><b>${daysSince(e.lastContactedAt)} days ago</b></div>` : ''}
    </div>

    ${j.vibes && j.vibes.length ? `<div class="vibe-tags">${j.vibes.map(v=>`<span class="vibe-tag selected">${v}</span>`).join('')}</div>` : ''}
    ${j.notes ? `<div class="card" style="margin-top:12px;"><div style="font-size:12px; color:var(--text-dim); margin-bottom:4px; font-weight:700;">NOTES</div>${escapeHtml(j.notes)}</div>` : ''}

    ${phone ? `<a href="tel:${escapeHtml(phone)}" class="btn-secondary btn-block" style="text-align:center; text-decoration:none; margin-top:14px; display:block;">📞 Call ${escapeHtml(phone)}</a>` : ''}
    <button class="btn-primary" id="btnBookAgain">📅 Book Them Again</button>
    <button class="btn-secondary" id="btnMarkContacted">📞 Mark as Reached Out</button>
    <button class="btn-secondary" id="btnCustomCycle">⏱️ Change Their Cycle (${e.cycleForThis} mo)</button>
  `);

  $('#btnBookAgain').addEventListener('click', ()=>{
    closeModal();
    openJobForm(null, todayStr(), {
      customerName: j.customerName, address: j.address, price: j.price,
      vibes: j.vibes || [], notes: j.notes || '', photoURL: j.photoURL || null,
      lat: j.lat || null, lng: j.lng || null, customerId: j.customerId || null,
    });
  });
  $('#btnMarkContacted').addEventListener('click', async ()=>{
    await db.collection('jobs').doc(j.id).update({ lastContactedAt: Date.now() });
    closeModal();
    toast('Logged — nice follow-up 📞');
  });
  $('#btnCustomCycle').addEventListener('click', ()=>{
    closeModal();
    openCycleForm(j, e.cycleForThis);
  });
}

function openCycleForm(job, current){
  openModal(`
    <div class="modal-title">Rebooking Cycle</div>
    <p style="color:var(--text-dim); font-size:13.5px; line-height:1.5;">
      How often does <b>${escapeHtml(job.customerName||'this customer')}</b> want their windows done?
      This only changes them — everyone else stays on your ${rebookCycle()}-month default.
    </p>
    <div class="form-row">
      <label class="field-label">Months between cleans: <span id="cycleLabel">${current}</span></label>
      <input id="cycleRange" type="range" min="1" max="24" value="${current}" />
    </div>
    <button class="btn-primary" id="cycleSave">Save</button>
  `);
  $('#cycleRange').addEventListener('input', ()=> $('#cycleLabel').textContent = $('#cycleRange').value);
  $('#cycleSave').addEventListener('click', async ()=>{
    await db.collection('jobs').doc(job.id).update({ rebookMonths: Number($('#cycleRange').value) });
    closeModal();
    toast('Cycle updated ⏱️');
  });
}

/* ==========================================================
   KNOCK STATS
   ========================================================== */

function donutSvg(segments, centerTop, centerSub){
  const total = segments.reduce((s,x)=> s + x.value, 0);
  const R = 54, C = 2 * Math.PI * R;
  let offset = 0;
  const arcs = total === 0
    ? `<circle cx="70" cy="70" r="${R}" fill="none" stroke="var(--border)" stroke-width="18" />`
    : segments.filter(s=>s.value>0).map(s=>{
        const frac = s.value / total;
        const dash = `${(frac*C).toFixed(2)} ${(C - frac*C).toFixed(2)}`;
        const el = `<circle cx="70" cy="70" r="${R}" fill="none" stroke="${s.color}" stroke-width="18"
          stroke-dasharray="${dash}" stroke-dashoffset="${(-offset*C).toFixed(2)}"
          transform="rotate(-90 70 70)" stroke-linecap="butt" />`;
        offset += frac;
        return el;
      }).join('');
  return `
    <svg viewBox="0 0 140 140" class="donut">
      ${arcs}
      <text x="70" y="66" text-anchor="middle" class="donut-top">${centerTop}</text>
      <text x="70" y="86" text-anchor="middle" class="donut-sub">${centerSub}</text>
    </svg>`;
}

function funnelRow(label, value, max, color, sublabel){
  const w = max > 0 ? Math.max(2, (value/max)*100) : 2;
  return `
    <div class="funnel-row">
      <div class="funnel-head">
        <span class="funnel-label">${label}</span>
        <span class="funnel-value">${value}${sublabel ? ` <span class="funnel-sub">${sublabel}</span>` : ''}</span>
      </div>
      <div class="funnel-track"><div class="funnel-fill" style="width:${w}%; background:${color};"></div></div>
    </div>`;
}

function weeklyTrendSvg(pins){
  const weeks = [];
  const now = new Date();
  const startOfWeek = new Date(now); startOfWeek.setHours(0,0,0,0);
  startOfWeek.setDate(now.getDate() - now.getDay());
  for(let i=7; i>=0; i--){
    const s = new Date(startOfWeek); s.setDate(startOfWeek.getDate() - i*7);
    const e = new Date(s); e.setDate(s.getDate() + 7);
    const inWeek = pins.filter(p => p.timestamp >= s.getTime() && p.timestamp < e.getTime());
    weeks.push({
      label: `${s.getMonth()+1}/${s.getDate()}`,
      knocked: inWeek.filter(p=>COUNTED_STATUSES.includes(p.status)).length,
      sales: inWeek.filter(p=>p.status==='sale').length,
    });
  }
  const max = Math.max(1, ...weeks.map(w=>w.knocked));
  const W = 320, H = 130, pad = 18;
  const bw = (W - pad*2) / weeks.length;

  const bars = weeks.map((w,i)=>{
    const x = pad + i*bw + bw*0.15;
    const bwid = bw*0.7;
    const kh = (w.knocked/max) * (H - 38);
    const sh = (w.sales/max) * (H - 38);
    return `
      <rect x="${x.toFixed(1)}" y="${(H-22-kh).toFixed(1)}" width="${bwid.toFixed(1)}" height="${Math.max(kh,1).toFixed(1)}" rx="3" fill="#2a3346" />
      <rect x="${x.toFixed(1)}" y="${(H-22-sh).toFixed(1)}" width="${bwid.toFixed(1)}" height="${Math.max(sh,0).toFixed(1)}" rx="3" fill="#3ee08a" />
      <text x="${(x+bwid/2).toFixed(1)}" y="${H-8}" text-anchor="middle" class="chart-x">${w.label}</text>`;
  }).join('');

  return `<svg viewBox="0 0 ${W} ${H}" class="trend-chart">${bars}</svg>`;
}

function renderStats(){
  const el = $('#statsContent');
  const range = state.statsRange;
  const cutoff = range === 'all' ? 0 : Date.now() - Number(range)*DAY_MS;
  const pins = state.pins.filter(p => p.timestamp >= cutoff);
  const allPins = state.pins;

  const s = doorStats(pins);
  const lifetime = doorStats(allPins);

  const segments = [
    { label:'Sales',     value:s.sale,      color:STATUS_HEX.sale },
    { label:'Leads',     value:s.lead,      color:STATUS_HEX.lead },
    { label:'No',        value:s.no,        color:STATUS_HEX.no },
    { label:'No Answer', value:s.attempted, color:STATUS_HEX.attempted },
  ];

  // per-person leaderboard
  const byPerson = {};
  pins.forEach(p=>{
    const who = p.createdBy || 'Unknown';
    byPerson[who] = byPerson[who] || [];
    byPerson[who].push(p);
  });
  const leaderboard = Object.entries(byPerson).map(([name, ps])=>{
    const st = doorStats(ps);
    return { name, ...st };
  }).sort((a,b)=> b.knocked - a.knocked);

  el.innerHTML = `
    <div class="lifetime-card">
      <div class="lifetime-num">${lifetime.knocked.toLocaleString()}</div>
      <div class="lifetime-label">doors knocked, all time</div>
      <div class="lifetime-sub">
        ${lifetime.sale.toLocaleString()} sales · ${lifetime.lead.toLocaleString()} leads
        ${lifetime.nosolicit ? ` · ${lifetime.nosolicit.toLocaleString()} 🚫 skipped` : ''}
      </div>
    </div>

    <div class="tech-filter-row">
      <button class="btn-pill ${range==='all'?'active':''}" data-range="all">All Time</button>
      <button class="btn-pill ${range==='30'?'active':''}" data-range="30">Last 30 Days</button>
      <button class="btn-pill ${range==='7'?'active':''}" data-range="7">Last 7 Days</button>
    </div>

    <div class="section-title">The Big Three</div>
    <div class="stat-grid">
      <div class="stat-card"><div class="stat-emoji">🚪</div><div class="stat-value">${pctStr(s.answerRate)}</div><div class="stat-label">Answer Rate<br><span class="stat-fine">${s.answered} of ${s.knocked} doors opened</span></div></div>
      <div class="stat-card"><div class="stat-emoji">🤝</div><div class="stat-value">${pctStr(s.closeRate)}</div><div class="stat-label">Close Rate<br><span class="stat-fine">${s.sale} of ${s.answered} conversations</span></div></div>
      <div class="stat-card"><div class="stat-emoji">🎯</div><div class="stat-value">${pctStr(s.doorToSale)}</div><div class="stat-label">Door → Sale<br><span class="stat-fine">${s.sale} of ${s.knocked} knocks</span></div></div>
      <div class="stat-card"><div class="stat-emoji">🔵</div><div class="stat-value">${pctStr(s.leadRate)}</div><div class="stat-label">Lead Rate<br><span class="stat-fine">${s.lead} of ${s.answered} conversations</span></div></div>
    </div>

    <div class="section-title">Outcome Breakdown</div>
    <div class="card chart-card">
      ${donutSvg(segments, s.knocked, 'doors knocked')}
      <div class="donut-legend">
        ${segments.map(seg=>`
          <div class="legend-row">
            <span class="legend-dot" style="background:${seg.color}"></span>
            <span class="legend-name">${seg.label}</span>
            <span class="legend-val">${seg.value} · ${s.knocked?((seg.value/s.knocked)*100).toFixed(0):0}%</span>
          </div>`).join('')}
        ${s.nosolicit ? `
          <div class="legend-row" style="opacity:.6; border-top:1px solid var(--border); margin-top:6px; padding-top:8px;">
            <span class="legend-dot" style="background:${STATUS_HEX.nosolicit}; border:1px solid var(--border);"></span>
            <span class="legend-name">No Soliciting</span>
            <span class="legend-val">${s.nosolicit} · excluded</span>
          </div>` : ''}
      </div>
    </div>

    <div class="section-title">Funnel</div>
    <div class="card">
      ${funnelRow('Doors Knocked', s.knocked, s.knocked, 'var(--accent)')}
      ${funnelRow('Someone Answered', s.answered, s.knocked, '#6ea8ff', pctStr(s.answerRate))}
      ${funnelRow('Interested (lead + sale)', s.interested, s.knocked, '#4fe0c4', pctStr(s.interestRate))}
      ${funnelRow('Closed a Sale', s.sale, s.knocked, '#3ee08a', pctStr(s.doorToSale))}
    </div>

    <div class="section-title">Last 8 Weeks</div>
    <div class="card">
      ${weeklyTrendSvg(allPins)}
      <div class="chart-key">
        <span><span class="legend-dot" style="background:#2a3346"></span> doors knocked</span>
        <span><span class="legend-dot" style="background:#3ee08a"></span> sales</span>
      </div>
    </div>

    ${leaderboard.length ? `
      <div class="section-title">By Person</div>
      ${leaderboard.map(p=>`
        <div class="card" style="padding:14px;">
          <div class="card-row"><b>${escapeHtml(p.name)}</b><span class="job-price">${p.sale} sale${p.sale===1?'':'s'}</span></div>
          <div class="card-row" style="margin-top:8px; font-size:12.5px; color:var(--text-dim);">
            <span>${p.knocked} knocks</span>
            <span>${pctStr(p.answerRate)} answered</span>
            <span>${pctStr(p.doorToSale)} closed</span>
          </div>
        </div>`).join('')}` : ''}

    <p style="text-align:center; color:var(--text-faint); font-size:11.5px; margin-top:18px; line-height:1.5;">
      🚫 No-soliciting doors are logged but excluded from every<br>percentage — they never count against you.
    </p>
  `;

  $all('[data-range]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      state.statsRange = btn.getAttribute('data-range');
      renderStats();
    });
  });
}

/* ---------------- HOME (owner dashboard) ---------------- */
function renderHome(){
  const el = $('#homeContent');
  const today = todayStr();
  const todaysJobs = state.jobs.filter(j => j.date === today && j.status !== 'cancelled');
  const now = new Date();
  const weekStart = new Date(now); weekStart.setDate(now.getDate() - now.getDay());
  const weekStartStr = ymd(weekStart);

  const weekJobs = state.jobs.filter(j => j.date >= weekStartStr && j.date <= todayStr());
  const revenueThisWeek = weekJobs.filter(j=>j.status==='completed').reduce((s,j)=> s + (Number(j.price)||0), 0);
  const leadsToday = state.pins.filter(p => ymd(new Date(p.timestamp)) === today).length;
  const salesThisWeek = state.pins.filter(p => p.status==='sale' && p.timestamp >= weekStart.getTime()).length;

  const dueNow = buildPlanEntries().filter(e => !e.rebooked && e.urgency === 'due');

  el.innerHTML = `
    <div class="section-title">Today · ${fmtDateLabel(today)}</div>
    <div class="stat-grid">
      <div class="stat-card"><div class="stat-emoji">🧼</div><div class="stat-value">${todaysJobs.length}</div><div class="stat-label">Jobs Today</div></div>
      <div class="stat-card"><div class="stat-emoji">💵</div><div class="stat-value">${fmtMoney(revenueThisWeek)}</div><div class="stat-label">Earned This Week</div></div>
      <div class="stat-card"><div class="stat-emoji">📍</div><div class="stat-value">${leadsToday}</div><div class="stat-label">Doors Logged Today</div></div>
      <div class="stat-card"><div class="stat-emoji">🎉</div><div class="stat-value">${salesThisWeek}</div><div class="stat-label">Sales This Week</div></div>
    </div>

    ${dueNow.length ? `
      <button class="card rebook-banner" id="rebookBanner">
        <div style="display:flex; align-items:center; gap:12px;">
          <span style="font-size:26px;">🔁</span>
          <span style="text-align:left; flex:1;">
            <span style="display:block; font-weight:800;">${dueNow.length} client${dueNow.length===1?'':'s'} ready to rebook</span>
            <span style="display:block; font-size:12.5px; color:var(--text-dim); margin-top:2px;">
              ${fmtMoney(dueNow.reduce((s,e)=>s+(Number(e.job.price)||0),0))} sitting on the table
            </span>
          </span>
          <span style="color:var(--accent);">›</span>
        </div>
      </button>` : ''}

    <div class="section-title">Today's Schedule</div>
    <div id="homeTodayList"></div>
  `;

  if($('#rebookBanner')) $('#rebookBanner').addEventListener('click', ()=>{
    state.plansTab = 'followup';
    switchView('plans');
  });

  const list = $('#homeTodayList');
  if(todaysJobs.length === 0){
    list.innerHTML = `<div class="empty-state"><div class="empty-emoji">☀️</div>Nothing on the books today.</div>`;
  }else{
    list.innerHTML = todaysJobs.map(j => jobCardHtml(j)).join('');
    attachJobCardHandlers(list);
  }
}

/* ---------------- shared job card ---------------- */
function jobCardHtml(job){
  const tech = techById(job.techId);
  const color = tech ? tech.color : '#666';
  const badgeClass = job.status === 'completed' ? 'badge-completed' : job.status === 'cancelled' ? 'badge-cancelled' : 'badge-scheduled';
  return `
    <button class="job-card" data-job-id="${job.id}">
      <span class="job-dot" style="background:${color}"></span>
      <span class="job-info">
        <span class="job-name">${escapeHtml(job.customerName || 'Untitled')}</span>
        <span class="job-sub">${tech ? escapeHtml(tech.name) : 'Unassigned'} · ${job.time || 'no time'} ${state.currentUser.role==='owner' ? '· '+escapeHtml(job.address||'') : ''}</span>
      </span>
      <span class="job-price">${fmtMoney(job.price)}</span>
      <span class="job-status-badge ${badgeClass}">${job.status}</span>
    </button>`;
}
function attachJobCardHandlers(root){
  $all('[data-job-id]', root).forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const job = state.jobs.find(j => j.id === btn.getAttribute('data-job-id'));
      if(job) openJobDetail(job);
    });
  });
}

/* ---------------- CALENDAR ---------------- */
function renderCalendar(){
  const el = $('#calendarContent');
  const cursor = state.calMonthCursor;
  const year = cursor.getFullYear(), month = cursor.getMonth();
  const mLabel = cursor.toLocaleDateString('en-US', { month:'long', year:'numeric' });

  const firstOfMonth = new Date(year, month, 1);
  const startWeekday = firstOfMonth.getDay();
  const daysInMonth = new Date(year, month+1, 0).getDate();
  const cells = [];
  for(let i=0;i<startWeekday;i++) cells.push(null);
  for(let d=1; d<=daysInMonth; d++) cells.push(new Date(year, month, d));

  const isOwner = state.currentUser.role === 'owner';
  const filterTechId = isOwner ? state.calTechFilter : state.currentUser.techId;

  const jobsFor = (dateStr) => state.jobs.filter(j => j.date === dateStr && (filterTechId==='all' || j.techId === filterTechId));

  el.innerHTML = `
    <div class="cal-header">
      <button class="cal-nav-btn" id="calPrev">‹</button>
      <div class="cal-month-label">${mLabel}</div>
      <button class="cal-nav-btn" id="calNext">›</button>
    </div>
    ${isOwner ? `<div class="tech-filter-row" id="techFilterRow"></div>` : ''}
    <div class="cal-grid">
      ${['S','M','T','W','T','F','S'].map(d=>`<div class="cal-dow">${d}</div>`).join('')}
      ${cells.map(d=>{
        if(!d) return `<div class="cal-day muted"></div>`;
        const dStr = ymd(d);
        const jobsThatDay = jobsFor(dStr);
        const dots = jobsThatDay.slice(0,3).map(j=>{
          const t = techById(j.techId);
          return `<span class="cal-day-dot" style="background:${t?t.color:'#888'}"></span>`;
        }).join('');
        const isToday = dStr === todayStr();
        const isSelected = dStr === state.calSelectedDate;
        return `<button class="cal-day ${isToday?'today':''} ${isSelected?'selected':''}" data-date="${dStr}">
          ${d.getDate()}
          <span class="cal-day-dots">${dots}</span>
        </button>`;
      }).join('')}
    </div>
    ${isOwner ? `<div style="margin-top:16px;"><button class="btn-secondary" id="btnNewJob">+ Schedule a Job</button></div>` : ''}
    <div class="section-title">${fmtDateLabel(state.calSelectedDate)}</div>
    <div id="calDayList"></div>
  `;

  $('#calPrev').addEventListener('click', ()=>{ state.calMonthCursor = new Date(year, month-1, 1); renderCalendar(); });
  $('#calNext').addEventListener('click', ()=>{ state.calMonthCursor = new Date(year, month+1, 1); renderCalendar(); });
  $all('[data-date]').forEach(btn=> btn.addEventListener('click', ()=>{ state.calSelectedDate = btn.getAttribute('data-date'); renderCalendar(); }));
  if(isOwner){
    const row = $('#techFilterRow');
    row.innerHTML = `<button class="btn-pill ${state.calTechFilter==='all'?'active':''}" data-filter="all">All</button>` +
      state.techs.map(t=>`<button class="btn-pill ${state.calTechFilter===t.id?'active':''}" data-filter="${t.id}" style="${state.calTechFilter===t.id?`background:${t.color};color:#08121a;`:''}">${escapeHtml(t.name)}</button>`).join('');
    $all('[data-filter]', row).forEach(btn=> btn.addEventListener('click', ()=>{ state.calTechFilter = btn.getAttribute('data-filter'); renderCalendar(); }));
    $('#btnNewJob').addEventListener('click', ()=> openJobForm(null, state.calSelectedDate));
  }

  const dayList = $('#calDayList');
  const dayJobs = jobsFor(state.calSelectedDate).sort((a,b)=>(a.time||'').localeCompare(b.time||''));
  if(dayJobs.length === 0){
    dayList.innerHTML = `<div class="empty-state"><div class="empty-emoji">🧴</div>No jobs on this day.</div>`;
  }else{
    dayList.innerHTML = dayJobs.map(j=>jobCardHtml(j)).join('');
    attachJobCardHandlers(dayList);
  }
}

/* ---------------- JOB DETAIL / FORM ---------------- */
function openJobDetail(job){
  const tech = techById(job.techId);
  const isOwner = state.currentUser.role === 'owner';
  const isMine = !isOwner && state.currentUser.techId === job.techId;
  const earning = calcEarning(job, tech);
  const dirUrl = job.lat && job.lng
    ? `https://www.google.com/maps/dir/?api=1&destination=${job.lat},${job.lng}`
    : `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(job.address||'')}`;

  const isDone = job.status === 'completed';
  const doneTs = isDone ? jobCompletedTs(job) : null;
  const cyc = Number(job.rebookMonths) || rebookCycle();

  openModal(`
    <div class="modal-title">${escapeHtml(job.customerName||'Job')}</div>
    <div style="color:var(--text-dim); font-size:13px; margin-bottom:10px;">${escapeHtml(job.address||'No address')}</div>
    ${job.photoURL ? `<img src="${job.photoURL}" class="photo-preview" />` : ''}

    <div class="earn-highlight">
      <div class="earn-amt">${fmtMoney(earning)}</div>
      <div class="earn-label">${isOwner ? (tech?escapeHtml(tech.name)+"'s ":'') + 'earning on this job' : 'you earn on this job'}</div>
    </div>

    <div class="card">
      <div class="card-row"><span style="color:var(--text-dim);">Job Price</span><b>${fmtMoney(job.price)}</b></div>
      <div class="card-row" style="margin-top:8px;"><span style="color:var(--text-dim);">Date / Time</span><b>${fmtDateLabel(job.date)} · ${job.time||'—'}</b></div>
      <div class="card-row" style="margin-top:8px;"><span style="color:var(--text-dim);">Tech</span><b>${tech?escapeHtml(tech.name):'Unassigned'}</b></div>
      <div class="card-row" style="margin-top:8px;"><span style="color:var(--text-dim);">Tip</span><b>${fmtMoney(job.tip||0)}</b></div>
      <div class="card-row" style="margin-top:8px;"><span style="color:var(--text-dim);">Status</span><b style="text-transform:capitalize;">${job.status}</b></div>
      ${isDone ? `
        <div class="card-row" style="margin-top:8px;"><span style="color:var(--text-dim);">Since cleaned</span><b>${daysSince(doneTs)} days</b></div>
        <div class="card-row" style="margin-top:8px;"><span style="color:var(--text-dim);">Rebook in</span><b>${monthLabelLong(monthKey(new Date(addMonthsTs(doneTs, cyc))))}</b></div>
      ` : ''}
    </div>

    ${job.vibes && job.vibes.length ? `<div class="vibe-tags">${job.vibes.map(v=>`<span class="vibe-tag selected">${v}</span>`).join('')}</div>` : ''}
    ${job.notes ? `<div class="card" style="margin-top:12px;"><div style="font-size:12px; color:var(--text-dim); margin-bottom:4px; font-weight:700;">NOTES</div>${escapeHtml(job.notes)}</div>` : ''}

    <a href="${dirUrl}" target="_blank" class="btn-secondary btn-block" style="text-align:center; text-decoration:none; margin-top:14px; display:block;">🧭 Open Directions</a>

    ${(isMine && job.status==='scheduled') ? `<button class="btn-primary" id="btnMarkComplete">✅ Mark Job Complete</button>` : ''}
    ${(isOwner) ? `
      ${isDone ? `<button class="btn-primary" id="btnBookAgainJob">🔁 Book Them Again</button>` : ''}
      <button class="btn-secondary" id="btnEditJob">✏️ Edit Job</button>
      <button class="btn-secondary btn-danger" id="btnDeleteJob">🗑️ Delete Job</button>
    ` : ''}
  `);

  if($('#btnMarkComplete')) $('#btnMarkComplete').addEventListener('click', ()=> openCompleteJobFlow(job));
  if($('#btnEditJob')) $('#btnEditJob').addEventListener('click', ()=>{ closeModal(); openJobForm(job); });
  if($('#btnBookAgainJob')) $('#btnBookAgainJob').addEventListener('click', ()=>{
    closeModal();
    openJobForm(null, todayStr(), {
      customerName: job.customerName, address: job.address, price: job.price,
      vibes: job.vibes || [], notes: job.notes || '', photoURL: job.photoURL || null,
      lat: job.lat || null, lng: job.lng || null, customerId: job.customerId || null,
    });
  });
  if($('#btnDeleteJob')) $('#btnDeleteJob').addEventListener('click', async ()=>{
    if(confirm('Delete this job? This cannot be undone.')){
      await db.collection('jobs').doc(job.id).delete();
      closeModal();
      toast('Job deleted.');
    }
  });
}

function openCompleteJobFlow(job){
  const cyc = Number(job.rebookMonths) || rebookCycle();
  openModal(`
    <div class="modal-title">Nice work! 🎉</div>
    <p style="color:var(--text-dim); font-size:14px;">Any tip from the customer?</p>
    <div class="form-row">
      <label class="field-label">Tip Amount ($)</label>
      <input id="tipInput" class="bubble-input" type="number" min="0" step="1" placeholder="0" />
    </div>
    <div class="card" style="font-size:13px; color:var(--text-dim); line-height:1.5;">
      🔁 This customer will pop up in <b style="color:var(--text);">Plans</b> for rebooking in about <b style="color:var(--text);">${cyc} months</b>.
    </div>
    <button class="btn-primary" id="btnConfirmComplete">Mark Complete</button>
  `);
  $('#btnConfirmComplete').addEventListener('click', async ()=>{
    const tip = Number($('#tipInput').value) || 0;
    await db.collection('jobs').doc(job.id).update({ status:'completed', tip, completedAt: Date.now() });
    closeModal();
    toast('Job complete — added to your rebooking list 🫧');
  });
}

function openJobForm(job, presetDate, prefill){
  const isEdit = !!job;
  const p = prefill || {};
  const v = (field, fallback='') => (job ? (job[field] ?? fallback) : (p[field] ?? fallback));

  openModal(`
    <div class="modal-title">${isEdit ? 'Edit Job' : (prefill ? 'Rebook Customer' : 'Schedule a Job')}</div>
    <div class="form-row">
      <label class="field-label">Customer Name</label>
      <input id="jfName" class="bubble-input" value="${escapeHtml(v('customerName'))}" />
    </div>
    <div class="form-row">
      <label class="field-label">Address</label>
      <input id="jfAddress" class="bubble-input" value="${escapeHtml(v('address'))}" />
    </div>
    <div class="form-row form-row-2">
      <div><label class="field-label">Price ($)</label><input id="jfPrice" type="number" min="0" class="bubble-input" value="${v('price','')}" /></div>
      <div><label class="field-label">Assign Tech</label>
        <select id="jfTech" class="bubble-input">
          <option value="">Unassigned</option>
          ${state.techs.map(t=>`<option value="${t.id}" ${job?.techId===t.id?'selected':''}>${escapeHtml(t.name)}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="form-row form-row-2">
      <div><label class="field-label">Date</label><input id="jfDate" type="date" class="bubble-input" value="${job?.date || presetDate || todayStr()}" /></div>
      <div><label class="field-label">Time</label><input id="jfTime" type="time" class="bubble-input" value="${job?.time||''}" /></div>
    </div>
    <div class="form-row">
      <label class="field-label">Customer Vibes</label>
      <div class="vibe-tags" id="jfVibes">
        ${VIBE_OPTIONS.map(o=>`<button type="button" class="vibe-tag ${(v('vibes',[])||[]).includes(o)?'selected':''}" data-vibe="${o}">${o}</button>`).join('')}
      </div>
    </div>
    <div class="form-row">
      <label class="field-label">Notes</label>
      <textarea id="jfNotes" class="bubble-input">${escapeHtml(v('notes'))}</textarea>
    </div>
    <div class="form-row">
      <label class="field-label">House Photo</label>
      <div id="jfPhotoUpload" class="photo-upload">${v('photoURL') ? 'Tap to replace photo' : '📷 Tap to add a photo so techs know where to go'}</div>
      ${v('photoURL') ? `<img src="${v('photoURL')}" class="photo-preview" id="jfPhotoPreview" />` : `<img class="photo-preview hidden" id="jfPhotoPreview" />`}
      <input type="file" id="jfPhotoInput" accept="image/*" capture="environment" class="hidden" />
    </div>
    <button class="btn-primary" id="jfSave">${isEdit ? 'Save Changes' : 'Schedule Job'}</button>
  `);

  let selectedVibes = new Set(v('vibes',[]) || []);
  $all('[data-vibe]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const val = btn.getAttribute('data-vibe');
      if(selectedVibes.has(val)){ selectedVibes.delete(val); btn.classList.remove('selected'); }
      else{ selectedVibes.add(val); btn.classList.add('selected'); }
    });
  });

  state.pendingPhotoFile = null;
  $('#jfPhotoUpload').addEventListener('click', ()=> $('#jfPhotoInput').click());
  $('#jfPhotoInput').addEventListener('change', (e)=>{
    const file = e.target.files[0];
    if(!file) return;
    state.pendingPhotoFile = file;
    const preview = $('#jfPhotoPreview');
    preview.src = URL.createObjectURL(file);
    preview.classList.remove('hidden');
  });

  $('#jfSave').addEventListener('click', async ()=>{
    const name = $('#jfName').value.trim();
    if(!name){ toast('Add a customer name first.'); return; }
    $('#jfSave').textContent = 'Saving…';
    let photoURL = v('photoURL', null) || null;
    if(state.pendingPhotoFile){
      photoURL = await uploadPhoto(state.pendingPhotoFile, 'job-photos');
    }
    const techId = $('#jfTech').value || null;
    const tech = techById(techId);
    const payload = {
      customerName: name,
      address: $('#jfAddress').value.trim(),
      price: Number($('#jfPrice').value) || 0,
      techId: techId,
      techName: tech ? tech.name : null,
      date: $('#jfDate').value || todayStr(),
      time: $('#jfTime').value || '',
      vibes: Array.from(selectedVibes),
      notes: $('#jfNotes').value.trim(),
      photoURL,
      status: job?.status || 'scheduled',
      lat: v('lat', null),
      lng: v('lng', null),
    };
    if(isEdit){
      await db.collection('jobs').doc(job.id).update(payload);
      toast('Job updated ✨');
    }else{
      payload.tip = 0;
      payload.createdAt = Date.now();
      if(p.customerId) payload.customerId = p.customerId;
      await db.collection('jobs').add(payload);
      toast(prefill ? 'Rebooked! 🔁' : 'Job scheduled 🎉');
    }
    closeModal();
  });
}

/* ---------------- MAP (door-to-door) ---------------- */
function renderMapView(){
  $('#mapToolbar').innerHTML = `
    <button class="btn-pill" id="btnLocateMe">🎯 My Location</button>
    <button class="btn-pill ${state.lassoActive?'active':''}" id="btnLasso">${state.lassoActive ? '✖️ Cancel' : '🔲 Lasso Area'}</button>
    <button class="btn-pill" id="btnMapType">${state.mapType === 'roadmap' ? '🛰️ Satellite' : '🗺️ Map View'}</button>
    <span class="btn-pill" style="pointer-events:none;">Tap map to log a door</span>
  `;
  $('#mapLegend').innerHTML = Object.entries(STATUS_META).map(([k,v])=>`
    <span class="map-legend-item"><span class="map-legend-dot" style="background:${v.color}"></span>${v.emoji} ${v.label}</span>
  `).join('');

  $('#btnLocateMe').addEventListener('click', ()=>{
    if(state.myLocation){
      state.map.panTo(state.myLocation);
      state.map.setZoom(18);
    }else{
      navigator.geolocation?.getCurrentPosition(pos=>{
        const here = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        state.map.panTo(here);
        state.map.setZoom(18);
      }, ()=> toast('Turn on location access to see where you are.'));
    }
  });
  $('#btnMapType').addEventListener('click', ()=>{
    state.mapType = state.mapType === 'roadmap' ? 'hybrid' : 'roadmap';
    if(state.map) state.map.setMapTypeId(state.mapType);
    $('#btnMapType').textContent = state.mapType === 'roadmap' ? '🛰️ Satellite' : '🗺️ Map View';
  });
  $('#btnLasso').addEventListener('click', toggleLasso);

  if(!window.google || !window.google.maps){
    loadGoogleMaps(initGoogleMap);
  }else if(!state.mapReady){
    initGoogleMap();
  }else{
    drawMapMarkers();
    setTimeout(()=> google.maps.event.trigger(state.map, 'resize'), 50);
  }
}

function loadGoogleMaps(cb){
  if(!GOOGLE_MAPS_API_KEY || GOOGLE_MAPS_API_KEY === 'PASTE_ME'){
    $('#googleMap').innerHTML = `<div class="empty-state"><div class="empty-emoji">🗺️</div>Add your Google Maps API key in firebase-config.js to enable the map.</div>`;
    return;
  }
  const s = document.createElement('script');
  s.src = `https://maps.googleapis.com/maps/api/js?key=${GOOGLE_MAPS_API_KEY}&libraries=geometry,places`;
  s.async = true;
  s.onload = cb;
  s.onerror = ()=> toast('Google Maps failed to load — check your API key.');
  document.head.appendChild(s);
}

const DARK_MAP_STYLE = [
  { elementType:'geometry', stylers:[{color:'#1a2130'}] },
  { elementType:'labels.text.fill', stylers:[{color:'#9aa7bd'}] },
  { elementType:'labels.text.stroke', stylers:[{color:'#0d1117'}] },
  { featureType:'road', elementType:'geometry', stylers:[{color:'#242c3d'}] },
  { featureType:'water', elementType:'geometry', stylers:[{color:'#0f2a33'}] },
  { featureType:'poi', elementType:'geometry', stylers:[{color:'#1e2635'}] },
  { featureType:'poi.park', elementType:'geometry', stylers:[{color:'#173322'}] },
  { featureType:'administrative', elementType:'geometry', stylers:[{color:'#2a3346'}] },
];

function initGoogleMap(){
  const center = { lat: 39.7392, lng: -104.9903 };
  state.map = new google.maps.Map($('#googleMap'), {
    center,
    zoom: 17,
    mapTypeId: state.mapType,
    styles: DARK_MAP_STYLE,
    disableDefaultUI: true,
    zoomControl: true,
    gestureHandling: 'greedy',
    tilt: 0,
  });
  state.mapReady = true;
  state.geocoder = new google.maps.Geocoder();

  state.map.addListener('click', (e)=>{
    openPinForm({ lat: e.latLng.lat(), lng: e.latLng.lng() });
  });

  // hidden overlay purely to get a pixel↔latlng projection for the lasso
  const o = new google.maps.OverlayView();
  o.onAdd = function(){}; o.draw = function(){}; o.onRemove = function(){};
  o.setMap(state.map);
  state.projOverlay = o;

  drawMapMarkers();
  startLocationTracking(true);
}

/* ==========================================================
   LASSO — circle a neighborhood, get its stats instantly
   ========================================================== */

function ensureLassoLayer(){
  if(state.lassoLayer) return state.lassoLayer;
  const host = $('#googleMap');
  const layer = document.createElement('div');
  layer.className = 'lasso-layer';
  layer.innerHTML = `<svg class="lasso-svg"><polyline class="lasso-path" points="" /></svg>
    <div class="lasso-hint">Draw a circle around the houses</div>`;
  host.appendChild(layer);
  state.lassoLayer = layer;
  state.lassoSvg = layer.querySelector('.lasso-path');

  const ptFrom = (ev)=>{
    const r = layer.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  };

  layer.addEventListener('pointerdown', (ev)=>{
    if(!state.lassoActive) return;
    ev.preventDefault();
    layer.setPointerCapture(ev.pointerId);
    state.lassoDrawing = true;
    state.lassoPts = [ptFrom(ev)];
    state.lassoSvg.setAttribute('points','');
  });

  layer.addEventListener('pointermove', (ev)=>{
    if(!state.lassoActive || !state.lassoDrawing) return;
    ev.preventDefault();
    const p = ptFrom(ev);
    const last = state.lassoPts[state.lassoPts.length-1];
    if(last && Math.hypot(p.x-last.x, p.y-last.y) < 3) return; // thin out
    state.lassoPts.push(p);
    state.lassoSvg.setAttribute('points', state.lassoPts.map(q=>`${q.x},${q.y}`).join(' '));
  });

  const finish = (ev)=>{
    if(!state.lassoActive || !state.lassoDrawing) return;
    state.lassoDrawing = false;
    try{ layer.releasePointerCapture(ev.pointerId); }catch(e){}
    finishLasso();
  };
  layer.addEventListener('pointerup', finish);
  layer.addEventListener('pointercancel', finish);

  return layer;
}

function toggleLasso(){
  if(!state.mapReady){ toast('Map is still loading…'); return; }
  state.lassoActive = !state.lassoActive;
  const layer = ensureLassoLayer();
  layer.classList.toggle('active', state.lassoActive);
  state.lassoPts = [];
  if(state.lassoSvg) state.lassoSvg.setAttribute('points','');

  state.map.setOptions({
    draggable: !state.lassoActive,
    gestureHandling: state.lassoActive ? 'none' : 'greedy',
    zoomControl: !state.lassoActive,
  });

  const btn = $('#btnLasso');
  if(btn){
    btn.classList.toggle('active', state.lassoActive);
    btn.textContent = state.lassoActive ? '✖️ Cancel' : '🔲 Lasso Area';
  }
  if(state.lassoActive) toast('Draw a circle around the houses 🔲');
}

function finishLasso(){
  const pts = state.lassoPts;
  if(pts.length < 3){
    toast('Draw a bigger loop and try again.');
    state.lassoSvg.setAttribute('points','');
    return;
  }
  const proj = state.projOverlay && state.projOverlay.getProjection();
  if(!proj || !google.maps.geometry){
    toast('Map tools still loading — try again in a sec.');
    return;
  }

  const path = pts.map(p => proj.fromContainerPixelToLatLng(new google.maps.Point(p.x, p.y)));
  const poly = new google.maps.Polygon({ paths: path });
  const inside = state.pins.filter(pin =>
    google.maps.geometry.poly.containsLocation(new google.maps.LatLng(pin.lat, pin.lng), poly)
  );

  toggleLasso(); // turn it back off and restore panning
  openLassoResults(inside);
}

function openLassoResults(pins){
  if(pins.length === 0){
    toast('No logged doors inside that area.');
    return;
  }
  const s = doorStats(pins);
  const leads = pins.filter(p=>p.status==='lead').sort((a,b)=> b.timestamp - a.timestamp);
  const attempts = pins.filter(p=>p.status==='attempted').sort((a,b)=> b.timestamp - a.timestamp);
  const salesValue = pins.filter(p=>p.status==='sale')
    .reduce((sum,p)=>{
      const job = p.jobId ? state.jobs.find(j=>j.id===p.jobId) : null;
      return sum + (job ? Number(job.price)||0 : 0);
    }, 0);

  const pinRow = (p)=>`
    <button class="job-card" data-lasso-pin="${p.id}">
      <span class="job-dot" style="background:${STATUS_HEX[p.status]}"></span>
      <span class="job-info">
        <span class="job-name">${escapeHtml(p.address || 'No address')}</span>
        <span class="job-sub">${daysSince(p.timestamp)}d ago · logged by ${escapeHtml(p.createdBy||'—')}</span>
        ${p.notes ? `<span class="job-sub" style="color:var(--text-faint);">${escapeHtml(p.notes)}</span>` : ''}
      </span>
    </button>`;

  openModal(`
    <div class="modal-title">🔲 Neighborhood Stats</div>
    <div style="color:var(--text-dim); font-size:13px; margin-bottom:12px;">${s.totalLogged} doors logged in this area</div>

    <div class="stat-grid">
      <div class="stat-card"><div class="stat-emoji">🚪</div><div class="stat-value">${s.knocked}</div><div class="stat-label">Doors Knocked</div></div>
      <div class="stat-card"><div class="stat-emoji">✅</div><div class="stat-value">${s.sale}</div><div class="stat-label">Sales${salesValue?` · ${fmtMoney(salesValue)}`:''}</div></div>
      <div class="stat-card"><div class="stat-emoji">🤝</div><div class="stat-value">${pctStr(s.closeRate)}</div><div class="stat-label">Close Rate</div></div>
      <div class="stat-card"><div class="stat-emoji">🎯</div><div class="stat-value">${pctStr(s.doorToSale)}</div><div class="stat-label">Door → Sale</div></div>
    </div>

    <div class="card" style="margin-top:14px;">
      ${funnelRow('Knocked', s.knocked, s.knocked, 'var(--accent)')}
      ${funnelRow('Answered', s.answered, s.knocked, '#6ea8ff', pctStr(s.answerRate))}
      ${funnelRow('Leads', s.lead, s.knocked, '#6ea8ff')}
      ${funnelRow('Sales', s.sale, s.knocked, '#3ee08a')}
      ${s.nosolicit ? `<div style="font-size:12px; color:var(--text-faint); margin-top:10px;">🚫 ${s.nosolicit} no-soliciting ${s.nosolicit===1?'house':'houses'} in here — skip those.</div>` : ''}
    </div>

    ${leads.length ? `<div class="section-title">🔵 Leads to Re-Knock (${leads.length})</div>${leads.map(pinRow).join('')}` : ''}
    ${attempts.length ? `<div class="section-title">🟡 Nobody Home — Try Again (${attempts.length})</div>${attempts.map(pinRow).join('')}` : ''}
    ${(!leads.length && !attempts.length) ? `<div class="empty-state" style="padding:22px;"><div class="empty-emoji">✨</div>No open opportunities left in this pocket.</div>` : ''}
  `);

  $all('[data-lasso-pin]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const pin = state.pins.find(p=>p.id === btn.getAttribute('data-lasso-pin'));
      if(pin){ closeModal(); setTimeout(()=>openPinDetail(pin), 180); }
    });
  });
}

function startLocationTracking(recenterOnFirstFix){
  if(!navigator.geolocation || !state.map) return;
  if(state.geoWatchId != null) return;

  state.geoWatchId = navigator.geolocation.watchPosition(pos=>{
    const here = { lat: pos.coords.latitude, lng: pos.coords.longitude };
    state.myLocation = here;

    if(!state.myDot){
      state.myDot = new google.maps.Marker({
        position: here,
        map: state.map,
        zIndex: 9999,
        title: 'You are here',
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          scale: 8,
          fillColor: '#37c8ff',
          fillOpacity: 1,
          strokeColor: '#ffffff',
          strokeWeight: 3,
        },
      });
      state.myAccuracyCircle = new google.maps.Circle({
        map: state.map,
        center: here,
        radius: pos.coords.accuracy || 20,
        strokeColor: '#37c8ff',
        strokeOpacity: 0.35,
        strokeWeight: 1,
        fillColor: '#37c8ff',
        fillOpacity: 0.12,
        clickable: false,
        zIndex: 1,
      });
      if(recenterOnFirstFix) state.map.panTo(here);
    }else{
      state.myDot.setPosition(here);
      state.myAccuracyCircle.setCenter(here);
      state.myAccuracyCircle.setRadius(pos.coords.accuracy || 20);
    }
  }, err=>{
    console.warn('geolocation', err);
    if(err.code === 1) toast('Allow location access to see your dot on the map.');
  }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 });
}

function drawMapMarkers(){
  if(!state.map) return;
  state.markers.forEach(m => m.setMap(null));
  state.markers = [];
  state.pins.forEach(pin=>{
    const meta = STATUS_META[pin.status] || STATUS_META.lead;
    const isNoSolicit = pin.status === 'nosolicit';
    const marker = new google.maps.Marker({
      position: { lat: pin.lat, lng: pin.lng },
      map: state.map,
      title: `${meta.label}${pin.customerName ? ' · '+pin.customerName : ''}`,
      zIndex: isNoSolicit ? 1 : 2,
      icon: {
        path: google.maps.SymbolPath.CIRCLE,
        scale: isNoSolicit ? 7 : 9,
        fillColor: STATUS_HEX[pin.status] || STATUS_HEX.lead,
        fillOpacity: 1,
        strokeColor: isNoSolicit ? '#8792a8' : '#ffffff',
        strokeWeight: 2.5,
      },
    });
    marker.addListener('click', ()=> openPinDetail(pin));
    state.markers.push(marker);
  });
}

function openPinForm(latlng){
  let chosenStatus = null;
  openModal(`
    <div class="modal-title">Log This Door</div>
    <div class="status-pick-row" id="pinStatusRow">
      ${Object.entries(STATUS_META).map(([k,v])=>`
        <button type="button" class="status-pick-btn pick-${k}" data-status="${k}">
          <span class="sp-emoji">${v.emoji}</span>${v.label}
        </button>`).join('')}
    </div>
    <div class="form-row">
      <label class="field-label">Address</label>
      <input id="pinAddress" class="bubble-input" value="Looking up address…" />
    </div>
    <div id="pinExtraFields"></div>
    <button class="btn-primary" id="pinSaveBtn">Save</button>
  `);

  if(state.geocoder){
    state.geocoder.geocode({ location: latlng }, (results, status)=>{
      if(status === 'OK' && results[0]) $('#pinAddress').value = results[0].formatted_address;
      else $('#pinAddress').value = '';
    });
  }

  $all('[data-status]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      chosenStatus = btn.getAttribute('data-status');
      $all('[data-status]').forEach(b=>b.classList.remove('selected'));
      btn.classList.add('selected');
      renderPinExtraFields(chosenStatus);
    });
  });

  $('#pinSaveBtn').addEventListener('click', ()=> savePinForm(latlng, chosenStatus));
}

function renderPinExtraFields(status){
  const wrap = $('#pinExtraFields');
  if(status === 'sale'){
    wrap.innerHTML = `
      <div class="form-row"><label class="field-label">Customer Name</label><input id="pinCustName" class="bubble-input" /></div>
      <div class="form-row form-row-2">
        <div><label class="field-label">Phone</label><input id="pinCustPhone" class="bubble-input" type="tel" /></div>
        <div><label class="field-label">Price ($)</label><input id="pinPrice" class="bubble-input" type="number" min="0" /></div>
      </div>
      <div class="form-row form-row-2">
        <div><label class="field-label">Assign Tech</label>
          <select id="pinTech" class="bubble-input"><option value="">Unassigned</option>${state.techs.map(t=>`<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('')}</select>
        </div>
        <div><label class="field-label">Date</label><input id="pinDate" type="date" class="bubble-input" value="${todayStr()}" /></div>
      </div>
      <div class="form-row"><label class="field-label">Time</label><input id="pinTime" type="time" class="bubble-input" /></div>
      <div class="form-row">
        <label class="field-label">Customer Vibes</label>
        <div class="vibe-tags" id="pinVibes">${VIBE_OPTIONS.map(v=>`<button type="button" class="vibe-tag" data-pvibe="${v}">${v}</button>`).join('')}</div>
      </div>
      <div class="form-row"><label class="field-label">Job Notes</label><textarea id="pinNotes" class="bubble-input"></textarea></div>
      <div class="form-row">
        <label class="field-label">House Photo</label>
        <div id="pinPhotoUpload" class="photo-upload">📷 Tap to add a photo so techs know where to go</div>
        <img class="photo-preview hidden" id="pinPhotoPreview" />
        <input type="file" id="pinPhotoInput" accept="image/*" capture="environment" class="hidden" />
      </div>
    `;
    state.pendingPhotoFile = null;
    $('#pinPhotoUpload').addEventListener('click', ()=> $('#pinPhotoInput').click());
    $('#pinPhotoInput').addEventListener('change', e=>{
      const file = e.target.files[0]; if(!file) return;
      state.pendingPhotoFile = file;
      const p = $('#pinPhotoPreview'); p.src = URL.createObjectURL(file); p.classList.remove('hidden');
    });
    window._pinSelectedVibes = new Set();
    $all('[data-pvibe]').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        const v = btn.getAttribute('data-pvibe');
        if(window._pinSelectedVibes.has(v)){ window._pinSelectedVibes.delete(v); btn.classList.remove('selected'); }
        else{ window._pinSelectedVibes.add(v); btn.classList.add('selected'); }
      });
    });
  }else{
    wrap.innerHTML = `<div class="form-row"><label class="field-label">Notes (optional)</label><textarea id="pinNotes" class="bubble-input" placeholder="Anything worth remembering about this house"></textarea></div>`;
  }
}

async function savePinForm(latlng, status){
  if(!status){ toast('Pick a status first — Sale, Attempted, Lead, or No.'); return; }
  const address = $('#pinAddress').value.trim();
  $('#pinSaveBtn').textContent = 'Saving…';

  const basePin = {
    lat: latlng.lat, lng: latlng.lng, address, status,
    notes: $('#pinNotes') ? $('#pinNotes').value.trim() : '',
    timestamp: Date.now(),
    createdBy: state.currentUser.name,
  };

  if(status === 'sale'){
    const name = $('#pinCustName').value.trim() || 'New Customer';
    const price = Number($('#pinPrice').value) || 0;
    const techId = $('#pinTech').value || null;
    const tech = techById(techId);
    let photoURL = null;
    if(state.pendingPhotoFile) photoURL = await uploadPhoto(state.pendingPhotoFile, 'job-photos');

    const custRef = await db.collection('customers').add({
      name, phone: $('#pinCustPhone').value.trim(), address, lat: latlng.lat, lng: latlng.lng,
      photoURL, vibes: Array.from(window._pinSelectedVibes||[]), notes: basePin.notes, createdAt: Date.now(),
    });

    const jobRef = await db.collection('jobs').add({
      customerId: custRef.id, customerName: name, address, lat: latlng.lat, lng: latlng.lng,
      price, techId, techName: tech ? tech.name : null,
      date: $('#pinDate').value || todayStr(), time: $('#pinTime').value || '',
      vibes: Array.from(window._pinSelectedVibes||[]), notes: basePin.notes, photoURL,
      status: 'scheduled', tip: 0, createdAt: Date.now(),
    });

    await db.collection('pins').add({ ...basePin, customerId: custRef.id, jobId: jobRef.id, customerName: name });
    toast('Sale logged! 🎉 Job added to the calendar.');
  }else{
    await db.collection('pins').add(basePin);
    const msgs = { attempted:'Attempt logged.', lead:'Lead saved 🔵', no:'Noted, moving on!' };
    toast(msgs[status] || 'Saved.');
  }
  closeModal();
}

function openPinDetail(pin){
  const meta = STATUS_META[pin.status] || STATUS_META.lead;
  const linkedJob = pin.jobId ? state.jobs.find(j=>j.id===pin.jobId) : null;
  openModal(`
    <div class="modal-title">${meta.emoji} ${meta.label}</div>
    <div style="color:var(--text-dim); font-size:13px; margin-bottom:10px;">${escapeHtml(pin.address||'')}</div>
    ${pin.notes ? `<div class="card">${escapeHtml(pin.notes)}</div>` : ''}
    <div style="color:var(--text-faint); font-size:12px; margin-top:10px;">Logged by ${escapeHtml(pin.createdBy||'—')} · ${new Date(pin.timestamp).toLocaleString()}</div>
    ${linkedJob ? `<button class="btn-primary" id="btnViewLinkedJob">View Job Details</button>` : ''}
    ${state.currentUser.role==='owner' ? `<button class="btn-secondary btn-danger" id="btnDeletePin">🗑️ Delete Entry</button>` : ''}
  `);
  if($('#btnViewLinkedJob')) $('#btnViewLinkedJob').addEventListener('click', ()=>{ closeModal(); openJobDetail(linkedJob); });
  if($('#btnDeletePin')) $('#btnDeletePin').addEventListener('click', async ()=>{
    if(confirm('Delete this map entry?')){ await db.collection('pins').doc(pin.id).delete(); closeModal(); toast('Removed.'); }
  });
}

/* ---------------- PHOTO UPLOAD ---------------- */
async function uploadPhoto(file, folder){
  try{
    const ref = storage.ref().child(`${folder}/${Date.now()}_${file.name}`);
    await ref.put(file);
    return await ref.getDownloadURL();
  }catch(err){
    console.error(err);
    toast('Photo upload failed — saved without photo.');
    return null;
  }
}

/* ---------------- TEAM (owner) ---------------- */
function renderTeam(){
  const el = $('#teamContent');
  el.innerHTML = `
    <button class="back-link" id="teamBack" style="margin-bottom:6px;">‹ Back to More</button>
    <div class="section-title">Cleaning Techs</div>
    <div id="teamList"></div>
    <button class="btn-primary" id="btnAddTech">+ Add a Cleaning Tech</button>
  `;
  $('#teamBack').addEventListener('click', ()=> switchView('settings'));
  const list = $('#teamList');
  if(state.techs.length === 0){
    list.innerHTML = `<div class="empty-state"><div class="empty-emoji">🧽</div>No techs yet — add your first one below.</div>`;
  }else{
    list.innerHTML = state.techs.map(t=>{
      const jobsThisMonth = state.jobs.filter(j=> j.techId===t.id && j.status==='completed' && j.date.startsWith(todayStr().slice(0,7)));
      const paidThisMonth = jobsThisMonth.reduce((s,j)=> s + calcEarning(j,t), 0);
      return `
      <div class="card" data-tech-card="${t.id}">
        <div class="card-row">
          <span style="display:flex; align-items:center; gap:10px; font-weight:800;"><span class="tech-dot" style="background:${t.color}"></span>${escapeHtml(t.name)}</span>
          <button class="btn-pill" data-edit-tech="${t.id}">✏️ Edit</button>
        </div>
        <div class="card-row" style="margin-top:10px; font-size:13px; color:var(--text-dim);">
          <span>📱 ${escapeHtml(t.phone||'—')}</span>
          <span>${t.commissionPct ?? 20}% commission + ${state.settings.tipsPct ?? 100}% tips</span>
        </div>
        <div class="card-row" style="margin-top:10px; font-size:13px;">
          <span style="color:var(--text-dim);">This month</span>
          <b>${jobsThisMonth.length} jobs · ${fmtMoney(paidThisMonth)} earned</b>
        </div>
      </div>`;
    }).join('');
    $all('[data-edit-tech]', list).forEach(btn=> btn.addEventListener('click', ()=> openTechForm(techById(btn.getAttribute('data-edit-tech')))));
  }
  $('#btnAddTech').addEventListener('click', ()=> openTechForm(null));
}

function openTechForm(tech){
  const isEdit = !!tech;
  const usedColors = state.techs.map(t=>t.color);
  const nextColor = tech?.color || TECH_COLORS.find(c=>!usedColors.includes(c)) || TECH_COLORS[state.techs.length % TECH_COLORS.length];
  const defaultPasscode = tech?.passcode || String(Math.floor(1000+Math.random()*9000));

  openModal(`
    <div class="modal-title">${isEdit ? 'Edit Tech' : 'Add a Cleaning Tech'}</div>
    <div class="form-row"><label class="field-label">Name</label><input id="tfName" class="bubble-input" value="${escapeHtml(tech?.name||'')}" /></div>
    <div class="form-row"><label class="field-label">Phone</label><input id="tfPhone" class="bubble-input" type="tel" value="${escapeHtml(tech?.phone||'')}" /></div>
    <div class="form-row">
      <label class="field-label">Commission Rate: <span id="tfPctLabel">${tech?.commissionPct ?? state.settings.defaultCommissionPct ?? 20}</span>% + ${state.settings.tipsPct ?? 100}% of tips</label>
      <input id="tfPct" type="range" min="0" max="100" value="${tech?.commissionPct ?? state.settings.defaultCommissionPct ?? 20}" />
    </div>
    <div class="form-row"><label class="field-label">Login Passcode</label><input id="tfPasscode" class="bubble-input passcode-input" style="letter-spacing:4px; font-size:18px;" value="${defaultPasscode}" maxlength="6" /></div>
    <div class="form-row">
      <label class="field-label">Color Tag</label>
      <div style="display:flex; gap:8px; flex-wrap:wrap;">
        ${TECH_COLORS.map(c=>`<button type="button" data-color="${c}" style="width:34px;height:34px;border-radius:50%;background:${c};border:3px solid ${c===nextColor?'#fff':'transparent'};"></button>`).join('')}
      </div>
    </div>
    <button class="btn-primary" id="tfSave">${isEdit?'Save Changes':'Add Tech'}</button>
    ${isEdit ? `<button class="btn-secondary btn-danger" id="tfDelete">🗑️ Remove Tech</button>` : ''}
  `);

  let chosenColor = nextColor;
  $('#tfPct').addEventListener('input', ()=> $('#tfPctLabel').textContent = $('#tfPct').value);
  $all('[data-color]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      chosenColor = btn.getAttribute('data-color');
      $all('[data-color]').forEach(b=> b.style.borderColor = 'transparent');
      btn.style.borderColor = '#fff';
    });
  });

  $('#tfSave').addEventListener('click', async ()=>{
    const name = $('#tfName').value.trim();
    if(!name){ toast('Enter a name.'); return; }
    const payload = {
      name, phone: $('#tfPhone').value.trim(), commissionPct: Number($('#tfPct').value),
      passcode: $('#tfPasscode').value.trim() || defaultPasscode, color: chosenColor,
    };
    if(isEdit){
      await db.collection('techs').doc(tech.id).update(payload);
      toast('Tech updated.');
    }else{
      payload.createdAt = Date.now();
      await db.collection('techs').add(payload);
      toast(`${name} added! Passcode: ${payload.passcode}`, 4000);
    }
    closeModal();
  });
  if($('#tfDelete')) $('#tfDelete').addEventListener('click', async ()=>{
    if(confirm(`Remove ${tech.name}? Their past jobs stay on record.`)){
      await db.collection('techs').doc(tech.id).delete();
      closeModal();
      toast('Tech removed.');
    }
  });
}

/* ---------------- EARNINGS (tech) ---------------- */
function renderEarnings(){
  const el = $('#earningsContent');
  const tech = techById(state.currentUser.techId);
  const myJobs = state.jobs.filter(j => j.techId === state.currentUser.techId && j.status === 'completed');

  const now = new Date();
  const weekStart = new Date(now); weekStart.setDate(now.getDate() - now.getDay());
  const weekStartStr = ymd(weekStart);
  const mStr = todayStr().slice(0,7);

  const weekJobs = myJobs.filter(j => j.date >= weekStartStr);
  const monthJobs = myJobs.filter(j => j.date.startsWith(mStr));
  const weekTotal = weekJobs.reduce((s,j)=> s + calcEarning(j, tech), 0);
  const monthTotal = monthJobs.reduce((s,j)=> s + calcEarning(j, tech), 0);

  el.innerHTML = `
    <div class="stat-grid">
      <div class="stat-card"><div class="stat-emoji">📅</div><div class="stat-value">${fmtMoney(weekTotal)}</div><div class="stat-label">This Week</div></div>
      <div class="stat-card"><div class="stat-emoji">🗓️</div><div class="stat-value">${fmtMoney(monthTotal)}</div><div class="stat-label">This Month</div></div>
    </div>
    <div class="section-title">Completed Jobs</div>
    <div id="earningsList"></div>
  `;
  const list = $('#earningsList');
  const sorted = [...myJobs].sort((a,b)=> b.date.localeCompare(a.date));
  if(sorted.length===0){
    list.innerHTML = `<div class="empty-state"><div class="empty-emoji">🧾</div>No completed jobs yet.</div>`;
  }else{
    list.innerHTML = sorted.map(j=>{
      const earning = calcEarning(j, tech);
      return `
      <button class="job-card" data-job-id="${j.id}">
        <span class="job-dot" style="background:${tech?tech.color:'#666'}"></span>
        <span class="job-info">
          <span class="job-name">${escapeHtml(j.customerName)}</span>
          <span class="job-sub">${fmtDateLabel(j.date)} · ${fmtMoney(j.price)} job ${j.tip?('+ '+fmtMoney(j.tip)+' tip'):''}</span>
        </span>
        <span class="job-price">${fmtMoney(earning)}</span>
      </button>`;
    }).join('');
    attachJobCardHandlers(list);
  }
}

/* ---------------- SETTINGS ---------------- */
function renderSettings(){
  const el = $('#settingsContent');
  const isOwner = state.currentUser.role === 'owner';

  if(isOwner){
    el.innerHTML = `
      <button class="card nav-card" id="goTeam">
        <span style="font-size:22px;">👥</span>
        <span style="flex:1; text-align:left;">
          <span style="display:block; font-weight:800;">Team</span>
          <span style="display:block; font-size:12.5px; color:var(--text-dim);">${state.techs.length} cleaning tech${state.techs.length===1?'':'s'} · commissions & passcodes</span>
        </span>
        <span style="color:var(--accent);">›</span>
      </button>

      <div class="section-title">Business</div>
      <div class="card">
        <label class="field-label">Business Name</label>
        <input id="setBizName" class="bubble-input" value="${escapeHtml(state.settings.businessName||'')}" />
        <label class="field-label">Default Commission % (new techs)</label>
        <input id="setDefaultPct" class="bubble-input" type="number" min="0" max="100" value="${state.settings.defaultCommissionPct ?? 20}" />
        <label class="field-label">Tips Policy (% of tips tech keeps)</label>
        <input id="setTipsPct" class="bubble-input" type="number" min="0" max="100" value="${state.settings.tipsPct ?? 100}" />
        <label class="field-label">Rebooking Cycle (months between cleans)</label>
        <input id="setRebook" class="bubble-input" type="number" min="1" max="24" value="${state.settings.rebookMonths ?? 4}" />
        <button class="btn-primary" id="btnSaveBiz">Save</button>
      </div>
      <div class="section-title">Security</div>
      <div class="card">
        <label class="field-label">Change Owner Passcode</label>
        <input id="setNewPasscode" class="bubble-input passcode-input" maxlength="6" placeholder="New passcode" />
        <button class="btn-secondary" id="btnSavePasscode">Update Passcode</button>
      </div>
      <button class="btn-secondary btn-danger" id="btnLogout" style="margin-top:20px;">🚪 Sign Out</button>
      <p style="text-align:center; color:var(--text-faint); font-size:12px; margin-top:24px;">SqueegeeHQ · made for window cleaning crews 🫧</p>
    `;
    $('#goTeam').addEventListener('click', ()=> switchView('team'));
    $('#btnSaveBiz').addEventListener('click', async ()=>{
      await db.collection('meta').doc('app').set({
        businessName: $('#setBizName').value.trim(),
        defaultCommissionPct: Number($('#setDefaultPct').value)||20,
        tipsPct: Number($('#setTipsPct').value)||100,
        rebookMonths: Number($('#setRebook').value)||4,
      }, { merge:true });
      toast('Saved!');
    });
    $('#btnSavePasscode').addEventListener('click', async ()=>{
      const code = $('#setNewPasscode').value.trim();
      if(code.length<4){ toast('Use at least 4 digits.'); return; }
      await db.collection('meta').doc('app').set({ ownerPasscode: code }, { merge:true });
      toast('Passcode updated.');
      $('#setNewPasscode').value='';
    });
  }else{
    const tech = techById(state.currentUser.techId);
    el.innerHTML = `
      <div class="section-title">My Profile</div>
      <div class="card">
        <div class="card-row"><span style="color:var(--text-dim);">Name</span><b>${escapeHtml(tech?.name||'')}</b></div>
        <div class="card-row" style="margin-top:8px;"><span style="color:var(--text-dim);">Commission</span><b>${tech?.commissionPct ?? 20}% + ${state.settings.tipsPct ?? 100}% tips</b></div>
      </div>
      <div class="section-title">Security</div>
      <div class="card">
        <label class="field-label">Change My Passcode</label>
        <input id="setTechPasscode" class="bubble-input passcode-input" maxlength="6" placeholder="New passcode" />
        <button class="btn-secondary" id="btnSaveTechPasscode">Update Passcode</button>
      </div>
      <button class="btn-secondary btn-danger" id="btnLogout" style="margin-top:20px;">🚪 Sign Out</button>
    `;
    $('#btnSaveTechPasscode').addEventListener('click', async ()=>{
      const code = $('#setTechPasscode').value.trim();
      if(code.length<4){ toast('Use at least 4 digits.'); return; }
      await db.collection('techs').doc(tech.id).update({ passcode: code });
      toast('Passcode updated.');
      $('#setTechPasscode').value='';
    });
  }
  $('#btnLogout').addEventListener('click', logout);
}

/* ---------------- boot ---------------- */
document.addEventListener('DOMContentLoaded', boot);

if('serviceWorker' in navigator){
  window.addEventListener('load', ()=>{
    navigator.serviceWorker.register('sw.js').catch(()=>{});
  });
}
