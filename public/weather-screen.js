// The weather screen: clicking the weather in the masthead opens it over the page, below the
// masthead, which stays in view. Close, Escape, the weather again, or Back closes it. While
// it's open the address ends in #weather, so it can be bookmarked or shared, and a page
// loaded with #weather opens it straight away.
// To see any sky whatever the weather, add a test to the address: #weather?test=thunderstorm,
// and &time=night for its night version (the names are in TEST_SKIES). The forecast stays
// real; only the sky changes, and a label at the top of the screen says it's a test.
// Behind the forecast, a canvas draws the weather now: rain, drizzle, a downpour or a storm
// with lightning, snow, fog, drifting cloud, or stars at night (sunshine is in style.css). It only runs while
// the screen is open and the tab is visible, and stays still for readers who ask for reduced
// motion.

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const random = (low, high) => low + Math.random() * (high - low);

// Rain styles: drops per square pixel, fall speed (px/s), streak length (px), and how far they
// lean. Each scene splits its drops into a far, fainter layer and a near one.
const RAIN = {
  drizzle: { density: 0.0007, speed: [380, 520], length: [5, 10], alpha: 0.22, slant: 0.06 },
  rain: { density: 0.00042, speed: [900, 1250], length: [14, 24], alpha: 0.3, slant: 0.12 },
  downpour: { density: 0.0009, speed: [1300, 1700], length: [22, 38], alpha: 0.34, slant: 0.2 },
};

// A soft cloud, drawn once and reused: overlapping radial puffs along a flattened band.
function cloudSprite(shade) {
  const sprite = document.createElement('canvas');
  sprite.width = 640;
  sprite.height = 260;
  const ctx = sprite.getContext('2d');
  for (let i = 0; i < 14; i++) {
    const x = random(120, 520);
    const y = random(110, 170) - Math.sin(((x - 120) / 400) * Math.PI) * 40;
    const r = random(60, 110);
    const puff = ctx.createRadialGradient(x, y, 0, x, y, r);
    puff.addColorStop(0, `rgb(${shade} / 0.55)`);
    puff.addColorStop(1, `rgb(${shade} / 0)`);
    ctx.fillStyle = puff;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  return sprite;
}

function clouds({ w, h, count, shade, alpha, top = 0.05, bottom = 0.55, stretch = 1 }) {
  const sprites = [cloudSprite(shade), cloudSprite(shade), cloudSprite(shade)];
  const list = Array.from({ length: count }, (_, i) => {
    const scale = random(0.8, 1.7);
    return {
      sprite: sprites[i % sprites.length],
      x: random(-0.3, 1) * w,
      y: random(top, bottom) * h,
      scale,
      speed: random(6, 16) * scale, // nearer (bigger) clouds move faster
      alpha: alpha * random(0.6, 1),
    };
  });
  return (ctx, dt) => {
    for (const cloud of list) {
      const width = 640 * cloud.scale * stretch;
      cloud.x += cloud.speed * dt;
      if (cloud.x > w) cloud.x = -width;
      ctx.globalAlpha = cloud.alpha;
      ctx.drawImage(cloud.sprite, cloud.x, cloud.y - 130 * cloud.scale, width, 260 * cloud.scale);
    }
    ctx.globalAlpha = 1;
  };
}

function rain({ w, h, style }) {
  const { density, speed, length, alpha, slant } = RAIN[style];
  const drop = (anywhere) => ({
    x: random(-h * slant, w),
    y: anywhere ? random(-h, h) : random(-h * 0.25, 0),
    v: random(...speed),
    len: random(...length),
  });
  const count = Math.round(w * h * density);
  const layers = [
    { drops: Array.from({ length: Math.round(count * 0.6) }, () => drop(true)), alpha: alpha * 0.55, width: 0.8, pace: 0.7 },
    { drops: Array.from({ length: Math.round(count * 0.4) }, () => drop(true)), alpha, width: 1.2, pace: 1 },
  ];
  return (ctx, dt) => {
    ctx.lineCap = 'round';
    for (const layer of layers) {
      ctx.strokeStyle = `rgb(215 228 245 / ${layer.alpha})`;
      ctx.lineWidth = layer.width;
      ctx.beginPath();
      for (const d of layer.drops) {
        const fall = d.v * layer.pace * dt;
        d.y += fall;
        d.x += fall * slant;
        if (d.y - d.len > h) Object.assign(d, drop(false));
        ctx.moveTo(d.x, d.y);
        ctx.lineTo(d.x - d.len * slant * layer.pace, d.y - d.len * layer.pace);
      }
      ctx.stroke();
    }
  };
}

function snow({ w, h }) {
  const flake = (anywhere) => {
    const near = Math.random();
    return { x: random(0, w), y: anywhere ? random(0, h) : random(-40, -5), r: 0.8 + near * 2.6, v: 25 + near * 55, phase: random(0, Math.PI * 2), sway: random(0.4, 1.1) };
  };
  const flakes = Array.from({ length: Math.round(w * h * 0.00022) }, () => flake(true));
  let t = 0;
  return (ctx, dt) => {
    t += dt;
    ctx.fillStyle = 'rgb(248 250 255 / 0.85)';
    ctx.beginPath();
    for (const f of flakes) {
      f.y += f.v * dt;
      f.x += Math.sin(t * f.sway + f.phase) * f.r * 6 * dt + 6 * dt;
      if (f.y > h + 5 || f.x > w + 5) Object.assign(f, flake(false));
      ctx.moveTo(f.x + f.r, f.y);
      ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
    }
    ctx.fill();
  };
}

// A clear night: twinkling stars, and now and then a shooting star. (The moon's glow, like
// the sun's, is in style.css: drawn once, not every frame.)
function stars({ w, h }) {
  const list = Array.from({ length: Math.round(w * h * 0.00014) }, () => ({
    x: random(0, w), y: h * 0.75 * Math.random() ** 1.4, r: random(0.4, 1.4), phase: random(0, Math.PI * 2), speed: random(0.6, 2), // thicker towards the top
  }));
  let t = 0;
  let shooting = null;
  let nextShot = random(4, 12);
  return (ctx, dt) => {
    t += dt;
    for (const star of list) {
      ctx.fillStyle = `rgb(240 244 255 / ${0.35 + 0.45 * (0.5 + Math.sin(t * star.speed + star.phase) / 2)})`;
      ctx.fillRect(star.x, star.y, star.r, star.r);
    }
    nextShot -= dt;
    if (nextShot <= 0 && !shooting) {
      shooting = { x: random(w * 0.2, w * 0.9), y: random(0, h * 0.3), age: 0 };
      nextShot = random(8, 20);
    }
    if (shooting) {
      shooting.age += dt;
      const progress = shooting.age / 0.9;
      const x = shooting.x - progress * 320;
      const y = shooting.y + progress * 140;
      const tail = ctx.createLinearGradient(x, y, x + 120, y - 52);
      tail.addColorStop(0, `rgb(255 255 255 / ${0.8 * (1 - progress)})`);
      tail.addColorStop(1, 'rgb(255 255 255 / 0)');
      ctx.strokeStyle = tail;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + 120, y - 52);
      ctx.stroke();
      if (progress >= 1) shooting = null;
    }
  };
}

// Lightning: every so often, a flash that flickers twice and fades.
function lightning({ w, h }) {
  let wait = random(3, 8);
  let flash = 0;
  let flicker = null;
  return (ctx, dt) => {
    wait -= dt;
    if (wait <= 0) {
      flash = 1;
      flicker = 0.12;
      wait = random(5, 13);
    }
    if (flicker != null) {
      flicker -= dt;
      if (flicker <= 0) { flash = 0.8; flicker = null; }
    }
    if (flash > 0.01) {
      ctx.fillStyle = `rgb(225 232 255 / ${flash * 0.4})`;
      ctx.fillRect(0, 0, w, h);
      flash *= Math.exp(-dt * 7);
    }
  };
}

// Fog: wide, faint banks of mist drifting across the lower part of the screen.
const fog = ({ w, h, night }) => clouds({ w, h, count: 9, shade: night ? '190 200 215' : '235 238 242', alpha: 0.35, top: 0.25, bottom: 1, stretch: 2.6 });

// The layers for each sky, drawn back to front.
function scene(sky, time, w, h) {
  const night = time === 'night';
  const size = { w, h, night };
  const grey = night ? '150 160 180' : '205 212 222';
  const dark = night ? '90 100 120' : '150 160 175';
  switch (sky) {
    case 'clear': return night ? [stars(size)] : []; // a clear day is all style.css: nothing moves
    case 'fair': return [...(night ? [stars(size)] : []), clouds({ ...size, count: 4, shade: night ? '170 180 200' : '255 255 255', alpha: 0.6, bottom: 0.45 })];
    case 'cloud': return [clouds({ ...size, count: 9, shade: grey, alpha: 0.55, bottom: 0.7 })];
    case 'fog': return [fog(size)];
    case 'drizzle': return [clouds({ ...size, count: 6, shade: grey, alpha: 0.4, top: -0.05, bottom: 0.3 }), rain({ ...size, style: 'drizzle' })];
    case 'rain': return [clouds({ ...size, count: 6, shade: dark, alpha: 0.45, top: -0.05, bottom: 0.3 }), rain({ ...size, style: 'rain' })];
    case 'downpour': return [clouds({ ...size, count: 7, shade: dark, alpha: 0.5, top: -0.05, bottom: 0.3 }), rain({ ...size, style: 'downpour' })];
    case 'storm': return [clouds({ ...size, count: 7, shade: dark, alpha: 0.55, top: -0.05, bottom: 0.3 }), lightning(size), rain({ ...size, style: 'downpour' })];
    case 'snow': return [clouds({ ...size, count: 5, shade: grey, alpha: 0.4, top: -0.05, bottom: 0.3 }), snow(size)];
    default: return [];
  }
}

let frame = null;

// Draws the sky until the screen closes. Rebuilds the scene when the size or the weather
// changes, or after the browser drops the canvas (to free graphics memory, say), which would
// otherwise leave it blank. Drawn at no more than 1.5 pixels per point: rain and snow are soft
// anyway, and a full Retina canvas redrawn 60 times a second is a lot to ask.
function animate(dialog) {
  const canvas = dialog.querySelector('.ws-sky');
  const ctx = canvas.getContext('2d');
  let key = '';
  let layers = [];
  let last = performance.now();
  canvas.oncontextrestored = () => { key = ''; };
  const draw = (now) => {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const next = `${dialog.dataset.sky} ${dialog.dataset.time} ${w}x${h}@${dpr}`;
    if (next !== key) {
      key = next;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      layers = scene(dialog.dataset.sky, dialog.dataset.time, w, h);
    }
    const dt = Math.min(0.05, (now - last) / 1000); // a long pause doesn't send everything leaping
    last = now;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    for (const layer of layers) layer(ctx, dt);
    const moving = layers.length && dialog.open && !document.hidden && !reduceMotion.matches;
    frame = moving ? requestAnimationFrame(draw) : null;
  };
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(draw);
}

const HASH = '#weather';
const screen = () => document.getElementById('weather-screen');
const isWeatherHash = () => location.hash.split('?')[0] === HASH;
let pushed = false; // opening added #weather to the history, so closing goes back over it

// Test skies by name, with the names the conditions go by too.
const TEST_SKIES = {
  clear: 'clear', sunny: 'clear',
  fair: 'fair', 'mostly-clear': 'fair', 'partly-cloudy': 'fair',
  cloud: 'cloud', cloudy: 'cloud', overcast: 'cloud',
  fog: 'fog',
  drizzle: 'drizzle',
  rain: 'rain',
  downpour: 'downpour', 'heavy-rain': 'downpour',
  snow: 'snow',
  storm: 'storm', thunderstorm: 'storm',
};

// The test asked for in the address (#weather?test=snow&time=night), if any.
function testSky() {
  const params = new URLSearchParams(location.hash.split('?')[1] ?? '');
  const name = params.get('test')?.toLowerCase();
  if (!name) return null;
  if (!TEST_SKIES[name]) {
    console.warn(`No weather test called "${name}". Try one of: ${Object.keys(TEST_SKIES).join(', ')}`);
    return null;
  }
  const time = params.get('time') === 'night' ? 'night' : 'day';
  return { sky: TEST_SKIES[name], time, test: `${name}${time === 'night' ? ', night' : ''}` };
}

// Shows the test sky, or puts the real one back. The real one is noted whenever no test is
// showing, and whenever a newer forecast has just set it (fresh).
let real = null;
function applyTest(dialog, { fresh = false } = {}) {
  if (fresh || !dialog.dataset.test) real = { sky: dialog.dataset.sky, time: dialog.dataset.time };
  const test = testSky();
  if (test) Object.assign(dialog.dataset, test);
  else if (dialog.dataset.test) {
    Object.assign(dialog.dataset, real);
    delete dialog.dataset.test;
  }
  if (dialog.open && frame == null) animate(dialog); // a still sky may need to move now
}

// The screen starts where the masthead ends. The masthead sticks to the top while the
// screen is open (style.css), wherever the page was scrolled to.
function place(dialog) {
  dialog.style.setProperty('--ws-top', `${document.querySelector('.masthead')?.offsetHeight ?? 0}px`);
}

// The page under the screen can't be reached by Tab while it's covered.
function setCovered(covered) {
  for (const element of document.querySelectorAll('body > :is(main, nav, .peek)')) element.inert = covered;
}

function syncTrigger() {
  const isOpen = Boolean(screen()?.open);
  const trigger = document.querySelector('.weather-open');
  if (!trigger) return;
  trigger.setAttribute('aria-expanded', String(isOpen));
  trigger.title = isOpen ? 'Close the forecast' : 'Open the full forecast';
  trigger.querySelector('span').textContent = isOpen ? 'Close forecast' : 'Full forecast';
}

function open() {
  const dialog = screen();
  if (!dialog || dialog.open) return;
  place(dialog);
  delete dialog.dataset.refreshed; // play the entrance again
  dialog.show();
  dialog.querySelector('.ws-content').scrollTop = 0; // from the top, not where it was last left
  setCovered(true);
  syncTrigger();
  applyTest(dialog);
  animate(dialog);
  if (!isWeatherHash()) {
    history.pushState(null, '', HASH);
    pushed = true;
  }
}

// However it closed (Close is a form on the dialog), tidy up after it.
function closed() {
  setCovered(false);
  syncTrigger();
  if (isWeatherHash()) {
    if (pushed) history.back();
    else history.replaceState(null, '', location.pathname + location.search);
  }
  pushed = false;
  document.querySelector('.weather-open')?.focus();
}

document.addEventListener('close', (event) => {
  if (event.target === screen()) closed();
}, true); // 'close' doesn't bubble, so listen as it comes down

document.addEventListener('click', (event) => {
  if (!event.target.closest('.weather-open')) return;
  if (screen()?.open) screen().close();
  else open();
});

document.addEventListener('keydown', (event) => {
  // A dialog opened over the screen (Settings, say) takes Escape for itself.
  if (event.key === 'Escape' && screen()?.open && !document.querySelector('dialog:modal')) screen().close();
});

// Back and Forward, or #weather (with or without a test) typed into the address.
addEventListener('popstate', () => {
  if (isWeatherHash()) {
    if (screen()?.open) applyTest(screen());
    else open();
  } else if (screen()?.open) {
    pushed = false;
    screen().close();
  }
});

document.addEventListener('weather:shown', () => {
  if (screen()) applyTest(screen(), { fresh: true });
  if (isWeatherHash() && !screen()?.open) open();
  syncTrigger();
});

new ResizeObserver(() => { if (screen()?.open) place(screen()); }).observe(document.querySelector('.masthead') ?? document.body);

document.addEventListener('visibilitychange', () => {
  const dialog = screen();
  if (dialog?.open && !document.hidden && frame == null) animate(dialog);
});

addEventListener('resize', () => {
  const dialog = screen();
  if (dialog?.open && frame == null) animate(dialog); // reduced motion: redraw the still frame to fit
});

if (isWeatherHash() && !document.documentElement.classList.contains('no-weather')) open();
