// ---------- shared constants ----------
const AMENITIES = [
  "WiFi", "AC", "Power Backup", "Food/Meals", "Laundry", "Parking",
  "CCTV", "Geyser", "TV", "Fridge", "Housekeeping", "Attached Bathroom",
  "Lift", "Daily Cleaning"
];

const API_BASE = 'https://apna-kamra-production.up.railway.app';
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

// ---------- General FAQs (shown on every property page) ----------
const GENERAL_FAQS = [
  {
    q: "How do I book a room or bed?",
    a: "Apna Kamra is a directory — we don't handle bookings. Once you find a property you like, tap \"Show Contact Number\" or the WhatsApp button to talk directly to the owner and finalize your stay."
  },
  {
    q: "Are the prices shown final?",
    a: "Prices listed are starting/indicative monthly rates set by the owner for single, double and triple sharing. Always confirm the final price, deposit and any extra charges directly with the owner before moving in."
  },
  {
    q: "Is there a brokerage or booking fee?",
    a: "Apna Kamra does not charge any brokerage or booking fee to students or tenants. Any charges related to the stay are between you and the property owner."
  },
  {
    q: "How do I list my own hostel or PG?",
    a: "Click \"List Your Property\" on any page, share your contact number and basic details, and our team will reach out to get your property listed."
  },
  {
    q: "Can I visit the property before deciding?",
    a: "Yes, we recommend visiting in person or requesting photos/video call with the owner before making any payment, just like with any rental."
  },
  {
    q: "What if the information shown is incorrect or outdated?",
    a: "Property details are managed by owners and our team. If something looks outdated, please contact us via the \"List Your Property\" form so we can update it."
  }
];

function renderFAQs(containerEl){
  containerEl.innerHTML = `
    <div class="section-title" style="font-size:18px;">Frequently Asked Questions</div>
    <div class="faq-list">
      ${GENERAL_FAQS.map((f,i)=>`
        <div class="faq-item" data-i="${i}">
          <div class="faq-q">${f.q}<span class="arrow">▾</span></div>
          <div class="faq-a">${f.a}</div>
        </div>
      `).join('')}
    </div>
  `;
  containerEl.querySelectorAll('.faq-item').forEach(item=>{
    item.querySelector('.faq-q').addEventListener('click', ()=>{
      item.classList.toggle('open');
    });
  });
}

// ---------- WhatsApp ----------
function whatsappLink(propertyName, slug, ownerMobile){
  const url = `${location.origin}/property/${slug}`;
  const msg = `Hi, I found this listing on Apna Kamra: ${propertyName} - ${url} . Can I know more?`;
  if(ownerMobile){
    let num = String(ownerMobile).replace(/\D/g,'');
    if(num.length === 10) num = '91' + num; // default to India country code
    return `https://wa.me/${num}?text=${encodeURIComponent(msg)}`;
  }
  return `https://wa.me/?text=${encodeURIComponent(msg)}`;
}

// ---------- Lightbox ----------
const Lightbox = (() => {
  let images = [];
  let idx = 0;
  let overlay, imgEl;

  function ensure(){
    if(overlay) return;
    overlay = document.createElement('div');
    overlay.className = 'lightbox-overlay';
    overlay.innerHTML = `
      <button class="lightbox-close">&times;</button>
      <img>
      <div class="lightbox-nav">
        <button class="lb-prev">&larr; Prev</button>
        <button class="lb-next">Next &rarr;</button>
      </div>
    `;
    document.body.appendChild(overlay);
    imgEl = overlay.querySelector('img');
    overlay.querySelector('.lightbox-close').onclick = close;
    overlay.querySelector('.lb-prev').onclick = ()=> show(idx-1);
    overlay.querySelector('.lb-next').onclick = ()=> show(idx+1);
    overlay.addEventListener('click', (e)=>{ if(e.target === overlay) close(); });
    document.addEventListener('keydown', (e)=>{
      if(!overlay.classList.contains('open')) return;
      if(e.key === 'Escape') close();
      if(e.key === 'ArrowLeft') show(idx-1);
      if(e.key === 'ArrowRight') show(idx+1);
    });
  }
  function show(i){
    idx = (i + images.length) % images.length;
    imgEl.src = images[idx];
  }
  function open(imgs, startIdx){
    ensure();
    images = imgs;
    show(startIdx || 0);
    overlay.classList.add('open');
  }
  function close(){ overlay.classList.remove('open'); }

  return { open };
})();

// ---------- Smart back navigation ----------
function smartBack(fallbackUrl){
  if(document.referrer && document.referrer.startsWith(location.origin)){
    history.back();
  }else{
    location.href = fallbackUrl;
  }
}
