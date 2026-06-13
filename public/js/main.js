// ---------- shared constants ----------
const AMENITIES = [
  "WiFi", "AC", "Power Backup", "Food/Meals", "Laundry", "Parking",
  "CCTV", "Geyser", "TV", "Fridge", "Housekeeping", "Attached Bathroom",
  "Lift", "Daily Cleaning"
];

const API_BASE = 'https://apna-kamra.up.railway.app';
const API = API_BASE + '/api';

async function apiGet(url){
  const res = await fetch(url);
  if(!res.ok) throw new Error((await res.json()).error || 'Request failed');
  return res.json();
}
async function apiSend(url, method, body){
  const res = await fetch(url, {
    method,
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if(!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function fmtPrice(n){
  if(!n) return '—';
  return '₹' + Number(n).toLocaleString('en-IN');
}

function amenityTags(list, max){
  const arr = max ? list.slice(0,max) : list;
  let html = arr.map(a=>`<span class="tag">${a}</span>`).join('');
  if(max && list.length > max) html += `<span class="tag accent">+${list.length - max} more</span>`;
  return html;
}

// ---------- Impression Tracker ----------
const ImpressionTracker = (() => {
  const seen = new Set();
  const pending = new Set();
  let observer;

  function init(){
    observer = new IntersectionObserver((entries)=>{
      entries.forEach(entry=>{
        if(entry.isIntersecting){
          const id = entry.target.getAttribute('data-pid');
          if(id && !seen.has(id)){
            seen.add(id);
            pending.add(id);
          }
        }
      });
    }, { threshold: 0.4 });

    setInterval(flush, 2000);
  }

  function observe(el){
    if(observer) observer.observe(el);
  }

  function flush(){
    if(!pending.size) return;
    const ids = Array.from(pending).map(Number);
    pending.clear();
    fetch(API + '/impressions', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ ids })
    }).catch(()=>{});
  }

  // mark instantly (used on property detail page load)
  function markNow(id){
    if(id && !seen.has(String(id))){
      seen.add(String(id));
      fetch(API + '/impressions', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ ids:[Number(id)] })
      }).catch(()=>{});
    }
  }

  return { init, observe, markNow };
})();

document.addEventListener('DOMContentLoaded', ()=> ImpressionTracker.init());

// ---------- Theme Toggle ----------
function initTheme(){
  const saved = localStorage.getItem('ak_theme') || 'dark';
  document.documentElement.setAttribute('data-theme', saved);
  updateThemeIcon(saved);
}
function toggleTheme(){
  const current = document.documentElement.getAttribute('data-theme') || 'dark';
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('ak_theme', next);
  updateThemeIcon(next);
}
function updateThemeIcon(theme){
  document.querySelectorAll('.theme-toggle').forEach(btn=>{
    btn.textContent = theme === 'dark' ? '☀️ Light' : '🌙 Dark';
  });
}
initTheme();
document.addEventListener('DOMContentLoaded', ()=>{
  document.querySelectorAll('.theme-toggle').forEach(btn=>{
    btn.addEventListener('click', toggleTheme);
  });
  updateThemeIcon(document.documentElement.getAttribute('data-theme') || 'dark');
});
