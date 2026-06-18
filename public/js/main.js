// ---------- shared constants ----------
const AMENITIES = [
  "WiFi", "AC", "Power Backup", "Food/Meals", "Laundry", "Parking",
  "CCTV", "Geyser", "TV", "Fridge", "Housekeeping", "Attached Bathroom",
  "Lift", "Daily Cleaning"
];

const API_BASE = 'https://apna-kamra-production.up.railway.app';
const API = API_BASE + '/api';

// ---------- Retry-capable fetch ----------
async function fetchWithRetry(url, options = {}, retries = 3, delay = 1200) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      const res = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timeout);
      return res;
    } catch (e) {
      if (attempt === retries) throw e;
      await new Promise(r => setTimeout(r, delay * attempt));
    }
  }
}

async function apiGet(url) {
  const res = await fetchWithRetry(url);
  if (!res.ok) throw new Error((await res.json()).error || 'Request failed');
  return res.json();
}

async function apiSend(url, method, body) {
  const res = await fetchWithRetry(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function fmtPrice(n) {
  if (!n) return '—';
  return '₹' + Number(n).toLocaleString('en-IN');
}

function amenityTags(list, max) {
  const arr = max ? list.slice(0, max) : list;
  let html = arr.map(a => `<span class="tag">${a}</span>`).join('');
  if (max && list.length > max) html += `<span class="tag accent">+${list.length - max} more</span>`;
  return html;
}

function statusBadges(p) {
  let b = '';
  if (p.is_featured) b += `<span class="prop-badge featured">⭐ Featured</span>`;
  if (p.is_trusted) b += `<span class="prop-badge trusted">✓ Trusted</span>`;
  if (p.is_unverified) b += `<span class="prop-badge unverified">⚠ Unverified</span>`;
  return b;
}

// ---------- Visitor Mobile ----------
const Visitor = (() => {
  let _mobile = localStorage.getItem('ak_visitor_mobile') || null;

  function getMobile() { return _mobile; }

  function setMobile(m) {
    _mobile = m;
    localStorage.setItem('ak_visitor_mobile', m);
  }

  function hasMobile() { return !!_mobile; }

  // Show a subtle bottom-sheet asking for mobile on first visit
  function askIfNeeded(onDone) {
    if (_mobile) { if (onDone) onDone(_mobile); return; }

    const sheet = document.createElement('div');
    sheet.id = 'visitorSheet';
    sheet.innerHTML = `
      <div style="position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:300;display:flex;align-items:flex-end;justify-content:center;">
        <div style="background:var(--card);border-top:2px solid var(--accent);padding:24px 20px 32px;width:100%;max-width:480px;border-radius:8px 8px 0 0;">
          <div style="font-size:18px;font-weight:700;margin-bottom:6px;">Welcome to Apna Kamra 👋</div>
          <div style="color:var(--text-dim);font-size:13px;margin-bottom:16px;">Enter your mobile number to get personalised hostel & PG recommendations and connect with owners.</div>
          <input id="visitorMobileInput" type="tel" placeholder="10-digit mobile number"
            style="width:100%;background:var(--bg-soft);border:1px solid var(--card-border);color:var(--text);padding:12px 14px;border-radius:4px;font-size:15px;margin-bottom:10px;">
          <div style="display:flex;gap:10px;">
            <button id="visitorSubmitBtn" style="flex:1;background:var(--accent);color:#11161d;font-weight:700;border:none;padding:12px;border-radius:4px;font-size:14px;cursor:pointer;">Continue</button>
            <button id="visitorSkipBtn" style="background:none;border:1px solid var(--card-border);color:var(--text-dim);padding:12px 16px;border-radius:4px;font-size:13px;cursor:pointer;">Skip</button>
          </div>
          <div id="visitorMsg" style="margin-top:8px;color:#e57368;font-size:12px;"></div>
        </div>
      </div>
    `;
    document.body.appendChild(sheet);

    document.getElementById('visitorSubmitBtn').onclick = () => {
      const val = document.getElementById('visitorMobileInput').value.trim();
      if (!/^[0-9]{10}$/.test(val)) {
        document.getElementById('visitorMsg').textContent = 'Please enter a valid 10-digit number.';
        return;
      }
      setMobile(val);
      sheet.remove();
      if (onDone) onDone(val);
    };
    document.getElementById('visitorSkipBtn').onclick = () => {
      sheet.remove();
      if (onDone) onDone(null);
    };
    document.getElementById('visitorMobileInput').addEventListener('keydown', e => {
      if (e.key === 'Enter') document.getElementById('visitorSubmitBtn').click();
    });
  }

  // Send a city-selection lead (called when user picks a city)
  function sendCityLead(cityName) {
    if (!_mobile) return;
    fetch(API + '/leads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mobile: _mobile, city: cityName, message: `Visited city: ${cityName}` })
    }).catch(() => {});
  }

  // Track property visits
  function trackView(propertyId, city) {
    if (!_mobile) return;
    fetch(API + '/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mobile: _mobile, property_id: propertyId, city, event_type: 'view' })
    }).catch(() => {});
  }

  return { getMobile, setMobile, hasMobile, askIfNeeded, sendCityLead, trackView };
})();

// ---------- Impression Tracker ----------
const ImpressionTracker = (() => {
  const seen = new Set();
  const pending = new Set();
  let observer;

  function init() {
    observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const id = entry.target.getAttribute('data-pid');
          if (id && !seen.has(id)) {
            seen.add(id);
            pending.add(id);
          }
        }
      });
    }, { threshold: 0.3 });

    setInterval(flush, 2000);
  }

  function observe(el) { if (observer) observer.observe(el); }

  function flush() {
    if (!pending.size) return;
    const ids = Array.from(pending).map(Number);
    pending.clear();
    fetch(API + '/impressions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids })
    }).catch(() => {});
  }

  function markNow(id) {
    if (id && !seen.has(String(id))) {
      seen.add(String(id));
      fetch(API + '/impressions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [Number(id)] })
      }).catch(() => {});
    }
  }

  return { init, observe, markNow };
})();

document.addEventListener('DOMContentLoaded', () => ImpressionTracker.init());

// ---------- Lazy image loading ----------
function lazyLoadImages(container) {
  const imgs = (container || document).querySelectorAll('img[data-src]');
  if (!imgs.length) return;
  const obs = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const img = entry.target;
        img.src = img.dataset.src;
        img.removeAttribute('data-src');
        obs.unobserve(img);
      }
    });
  }, { rootMargin: '200px' });
  imgs.forEach(img => obs.observe(img));
}

// ---------- Theme Toggle ----------
function initTheme() {
  const saved = localStorage.getItem('ak_theme') || 'dark';
  document.documentElement.setAttribute('data-theme', saved);
  updateThemeIcon(saved);
}
function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'dark';
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('ak_theme', next);
  updateThemeIcon(next);
}
function updateThemeIcon(theme) {
  document.querySelectorAll('.theme-toggle').forEach(btn => {
    btn.textContent = theme === 'dark' ? '☀️ Light' : '🌙 Dark';
  });
}
initTheme();
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.theme-toggle').forEach(btn => {
    btn.addEventListener('click', toggleTheme);
  });
  updateThemeIcon(document.documentElement.getAttribute('data-theme') || 'dark');
});

// ---------- General FAQs ----------
const GENERAL_FAQS = [
  { q: "How do I book a room or bed?", a: "Apna Kamra is a directory — we don't handle bookings. Once you find a property you like, tap \"Show Contact Number\" or the WhatsApp button to talk directly to the owner and finalize your stay." },
  { q: "Are the prices shown final?", a: "Prices listed are starting/indicative monthly rates set by the owner for single, double and triple sharing. Always confirm the final price, deposit and any extra charges directly with the owner before moving in." },
  { q: "Is there a brokerage or booking fee?", a: "Apna Kamra does not charge any brokerage or booking fee to students or tenants. Any charges related to the stay are between you and the property owner." },
  { q: "How do I list my own hostel or PG?", a: "Click \"List Your Property\" on any page, share your contact number and basic details, and our team will reach out to get your property listed." },
  { q: "Can I visit the property before deciding?", a: "Yes, we recommend visiting in person or requesting photos/video call with the owner before making any payment, just like with any rental." },
  { q: "What if the information shown is incorrect or outdated?", a: "Property details are managed by owners and our team. If something looks outdated, please contact us via the \"List Your Property\" form so we can update it." }
];

function renderFAQs(containerEl) {
  containerEl.innerHTML = `
    <div class="section-title" style="font-size:18px;">Frequently Asked Questions</div>
    <div class="faq-list">
      ${GENERAL_FAQS.map((f, i) => `
        <div class="faq-item" data-i="${i}">
          <div class="faq-q">${f.q}<span class="arrow">▾</span></div>
          <div class="faq-a">${f.a}</div>
        </div>
      `).join('')}
    </div>
  `;
  containerEl.querySelectorAll('.faq-item').forEach(item => {
    item.querySelector('.faq-q').addEventListener('click', () => item.classList.toggle('open'));
  });
}

// ---------- WhatsApp ----------
function whatsappLink(propertyName, slug, ownerMobile) {
  const url = `${location.origin}/property/${slug}`;
  const msg = `Hi, I found this listing on Apna Kamra: ${propertyName} - ${url} . Can I know more?`;
  if (ownerMobile) {
    let num = String(ownerMobile).replace(/\D/g, '');
    if (num.length === 10) num = '91' + num;
    return `https://wa.me/${num}?text=${encodeURIComponent(msg)}`;
  }
  return `https://wa.me/?text=${encodeURIComponent(msg)}`;
}

// ---------- Lightbox ----------
const Lightbox = (() => {
  let images = [], idx = 0, overlay, imgEl;
  function ensure() {
    if (overlay) return;
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
    overlay.querySelector('.lb-prev').onclick = () => show(idx - 1);
    overlay.querySelector('.lb-next').onclick = () => show(idx + 1);
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', e => {
      if (!overlay.classList.contains('open')) return;
      if (e.key === 'Escape') close();
      if (e.key === 'ArrowLeft') show(idx - 1);
      if (e.key === 'ArrowRight') show(idx + 1);
    });
  }
  function show(i) { idx = (i + images.length) % images.length; imgEl.src = images[idx]; }
  function open(imgs, startIdx) { ensure(); images = imgs; show(startIdx || 0); overlay.classList.add('open'); }
  function close() { overlay.classList.remove('open'); }
  return { open };
})();

// ---------- Smart back ----------
function smartBack(fallbackUrl) {
  if (document.referrer && document.referrer.startsWith(location.origin)) history.back();
  else location.href = fallbackUrl;
}
