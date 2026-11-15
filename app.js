import { Chess } from './vendor/chess.js';

const ENGINE_URL = 'vendor/stockfish-19-lite-single.js';
const SAMPLE_PGN = `[Event "A Night at the Opera"]
[White "Paul Morphy"]
[Black "Duke Karl / Count Isouard"]
[Result "1-0"]

1. e4 e5 2. Nf3 d6 3. d4 Bg4 4. dxe5 Bxf3 5. Qxf3 dxe5 6. Bc4 Nf6 7. Qb3 Qe7
8. Nc3 c6 9. Bg5 b5 10. Nxb5 cxb5 11. Bxb5+ Nbd7 12. O-O-O Rd8 13. Rxd7 Rxd7
14. Rd1 Qe6 15. Bxd7+ Nxd7 16. Qb8+ Nxb8 17. Rd8# 1-0`;

const CLASSES = {
  brilliant: { label: 'Brilliant', phrase: 'a brilliant move', color: '#1baca6', sym: '!!' },
  great: { label: 'Great', phrase: 'a great move', color: '#5c8bb0', sym: '!' },
  best: { label: 'Best', phrase: 'the best move', color: '#81b64c', sym: '\u2605' },
  excellent: { label: 'Excellent', phrase: 'an excellent move', color: '#81b64c', sym: '\u2713' },
  good: { label: 'Good', phrase: 'a good move', color: '#77915f', sym: '\u2713' },
  book: { label: 'Book', phrase: 'a book move', color: '#a88865', sym: 'B' },
  inaccuracy: { label: 'Inaccuracy', phrase: 'an inaccuracy', color: '#f0c15c', sym: '?!' },
  mistake: { label: 'Mistake', phrase: 'a mistake', color: '#e58f2a', sym: '?' },
  miss: { label: 'Miss', phrase: 'a missed opportunity', color: '#ee6b55', sym: '\u2715' },
  blunder: { label: 'Blunder', phrase: 'a blunder', color: '#ca3431', sym: '??' },
};
const VAL = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const badge = cls => `<span class="badge" style="background:${CLASSES[cls].color}">${CLASSES[cls].sym}</span>`;

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const LIVE_DEPTH = 20;
// Estimated rating anchors: [accuracy, rating].
const RATING_CURVE = [[0, 100], [40, 300], [50, 500], [60, 750], [70, 1050], [75, 1250], [80, 1500], [85, 1800], [90, 2150], [93, 2400], [96, 2700], [98, 2950], [100, 3200]];

let game = null, cur = 0, flipped = false, runId = 0, engines = [];
// Variation being tried on the board: { base, pos, fens, moves, evals }, or null when following the game.
let explore = null, sel = null, drag = null;
const live = { eng: null, want: null, busy: false, running: false };
const curFen = () => mode === 'openings' ? (trainer ? trainer.line.fens[trainer.pos] : START_FEN) : explore ? explore.fens[explore.pos] : game ? game.fens[cur] : START_FEN;
const curPly = () => explore ? explore.base + explore.pos : cur;
const book = { prefixes: new Set(), names: new Map(), families: new Map() };
// Openings trainer: mode is 'review' or 'openings'; trainer is the line being learned or practiced.
let mode = 'review', trainer = null;
const op = { screen: 'browse', family: null, side: 'w' };
let mastered = new Set();
try { mastered = new Set(JSON.parse(localStorage.getItem('openings-mastered')) || []); } catch { /* nothing saved */ }

// ---------- engine ----------

class Engine {
  constructor() {
    this.worker = new Worker(ENGINE_URL);
    this.listener = null;
    this.worker.onmessage = e => String(e.data).split('\n').forEach(l => this.listener?.(l));
    this.ready = this.init();
  }
  send(cmd) { this.worker.postMessage(cmd); }
  waitFor(cmd, token) {
    return new Promise(resolve => {
      this.listener = l => { if (l.startsWith(token)) resolve(); };
      this.send(cmd);
    });
  }
  async init() {
    await this.waitFor('uci', 'uciok');
    this.send('setoption name MultiPV value 2');
    await this.waitFor('isready', 'readyok');
  }
  // Resolves to up to 2 lines [{cp | mate, pv: [uci]}], scores from white's point of view.
  analyze(fen, depth, onUpdate) {
    const sign = fen.split(' ')[1] === 'w' ? 1 : -1, lines = [];
    return new Promise(resolve => {
      this.listener = l => {
        if (l.startsWith('bestmove')) {
          const found = lines.filter(Boolean), d = Math.max(...found.map(x => x.depth));
          return resolve(found.length ? found.filter(x => x.depth === d) : [{ cp: 0, pv: [] }]);
        }
        const m = l.match(/^info .*?\bdepth (\d+) .*?\bmultipv (\d+) .*?\bscore (cp|mate) (-?\d+)( \w+bound)? .*?\bpv (.+)$/);
        if (!m || m[5]) return;
        lines[m[2] - 1] = { depth: +m[1], [m[3]]: sign * m[4], pv: m[6].trim().split(/\s+/) };
        const found = lines.filter(Boolean);
        if (onUpdate && found.every(x => x.depth === +m[1])) onUpdate([...found]);
      };
      this.send('position fen ' + fen);
      this.send('go depth ' + depth);
    });
  }
}

function killEngines() {
  engines.forEach(e => e.worker.terminate());
  engines = [];
}

// Analyze the explored position in the background, replacing any analysis already in flight.
function liveAnalyze(x, idx) {
  if (live.busy && !live.want && live.cur?.x === x && live.cur.idx === idx) return;
  live.want = { x, idx };
  live.eng ??= new Engine();
  if (live.busy) live.eng.send('stop');
  pumpLive();
}

async function pumpLive() {
  if (live.running) return;
  live.running = true;
  await live.eng.ready;
  while (live.want) {
    const { x, idx } = live.cur = live.want;
    live.want = null;
    live.busy = true;
    const update = lines => {
      if (explore !== x || idx >= x.fens.length) return;
      if (x.evals[idx]?.[0].depth > lines[0].depth) return;
      x.evals[idx] = lines;
      if (mode === 'review' && (x.pos === idx || x.pos === idx + 1)) renderLive();
    };
    const lines = await live.eng.analyze(x.fens[idx], LIVE_DEPTH, update);
    live.busy = false;
    if (!live.want) { lines.final = true; update(lines); }
  }
  live.running = false;
}

function terminalEval(fen) {
  const c = new Chess(fen);
  if (c.isCheckmate()) return [{ winner: c.turn() === 'w' ? 'b' : 'w', pv: [] }];
  if (c.isStalemate() || c.isInsufficientMaterial()) return [{ cp: 0, pv: [] }];
  return null;
}

// ---------- scoring ----------

// White's win probability (0-100) for an engine line.
function winPct(line) {
  if (line.winner) return line.winner === 'w' ? 100 : 0;
  const cp = line.mate != null ? Math.sign(line.mate) * 1000 : Math.max(-1000, Math.min(1000, line.cp));
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
}

function evalText(line) {
  if (line.winner) return line.winner === 'w' ? '1-0' : '0-1';
  if (line.mate != null) return (line.mate < 0 ? '-M' : 'M') + Math.abs(line.mate);
  const v = line.cp / 100;
  return (v > 0 ? '+' : '') + v.toFixed(Math.abs(v) >= 10 ? 1 : 2);
}

// Does this move leave the moved piece to be won for less than it is worth?
function isSacrifice(m) {
  const val = VAL[m.piece], gain = m.captured ? VAL[m.captured] : 0;
  if (val < 3 || m.promotion || gain >= val) return false;
  const c = new Chess(m.after);
  const takers = c.moves({ verbose: true }).filter(x => x.to === m.to);
  if (!takers.length) return false;
  const cheapest = Math.min(...takers.map(x => x.piece === 'k' ? 99 : VAL[x.piece]));
  const defended = c.attackers(m.to, m.color).length > 0;
  if (defended && cheapest >= val) return false;
  return val - (defended ? cheapest : 0) - gain >= 1;
}

function judge(m, before, after) {
  const pov = line => m.color === 'w' ? winPct(line) : 100 - winPct(line);
  const top = before[0], wb = pov(top), wa = pov(after[0]);
  const isBest = top.pv[0] === m.uci || before.length === 1 && top.pv.length > 0 && wa >= wb;
  const loss = isBest ? 0 : Math.max(0, wb - wa);
  const cls = isBest ? 'best' : loss <= 2 ? 'excellent' : loss <= 5 ? 'good' : loss <= 10 ? 'inaccuracy' : loss <= 20 ? 'mistake' : 'blunder';
  return { pov, top, wb, wa, isBest, loss, cls };
}

// Rough rating guess from accuracy, pulled halfway toward the player's actual rating when it is known.
function estimateRating(acc, elo) {
  const i = Math.max(1, RATING_CURVE.findIndex(([a]) => a >= acc));
  const [a0, r0] = RATING_CURVE[i - 1], [a1, r1] = RATING_CURVE[i];
  let r = r0 + (r1 - r0) * (acc - a0) / (a1 - a0);
  if (elo > 0) r = (r + elo) / 2;
  return Math.round(r / 50) * 50;
}

function classify(g) {
  const { moves, evals } = g;
  const sans = [];
  let inBook = true;
  g.opening = '';
  moves.forEach((m, i) => {
    const before = evals[i];
    const j = judge(m, before, evals[i + 1]), { pov, top, wb, wa, isBest, loss } = j;
    const prev = moves[i - 1];
    let cls = j.cls;

    sans.push(m.san);
    const key = sans.join(' ');
    if (inBook && book.prefixes.has(key)) {
      cls = 'book';
      if (book.names.has(key)) g.opening = book.names.get(key);
    } else {
      inBook = false;
      const prevBad = prev && ['mistake', 'blunder', 'miss'].includes(prev.review.cls);
      const recapture = m.captured && prev?.captured && prev.to === m.to;
      if (loss <= 2 && wa >= 50 && (wb < 97.5 || before.length > 1 && pov(before[1]) <= 90) && isSacrifice(m)) cls = 'brilliant';
      else if (isBest && before.length > 1 && pov(top) - pov(before[1]) >= 12 && !recapture && !m.san.endsWith('#') && !(prevBad && m.captured)) cls = 'great';
      else if (prevBad && loss > 10 && wb >= 60 && wa >= 35) cls = 'miss';
    }

    let bestSan = '';
    if (top.pv[0]) bestSan = pvToSan(m.before, [top.pv[0]])[0] || '';
    const acc = cls === 'book' ? 100 : Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.04354 * loss) - 3.1669));
    m.review = { cls, loss, acc, isBest, bestUci: top.pv[0], bestSan };
  });

  g.accuracy = {};
  g.counts = {};
  g.rating = {};
  for (const c of ['w', 'b']) {
    const own = moves.filter(m => m.color === c);
    g.accuracy[c] = own.length ? own.reduce((s, m) => s + m.review.acc, 0) / own.length : 0;
    g.rating[c] = estimateRating(g.accuracy[c], parseInt(c === 'w' ? g.headers.WhiteElo : g.headers.BlackElo));
    g.counts[c] = Object.fromEntries(Object.keys(CLASSES).map(k => [k, own.filter(m => m.review.cls === k).length]));
  }
}

function pvToSan(fen, pv, max = 10) {
  const out = [];
  try {
    const c = new Chess(fen);
    for (const u of pv.slice(0, max)) out.push(c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }).san);
  } catch { /* stale or illegal pv tail */ }
  return out;
}

// ---------- loading ----------

async function loadBook() {
  const text = await (await fetch('vendor/openings.tsv')).text();
  for (const row of text.split('\n')) {
    const [eco, name, pgn] = row.split('\t');
    if (!pgn) continue;
    const sans = pgn.replace(/\d+\.\s*/g, '').trim().split(/\s+/);
    const key = sans.join(' '), family = name.split(':')[0];
    book.names.set(key, name);
    if (!book.families.has(family)) book.families.set(family, { name: family, lines: [] });
    book.families.get(family).lines.push({ eco, name, sans, key });
    for (let i = 1; i <= sans.length; i++) book.prefixes.add(sans.slice(0, i).join(' '));
  }
}
const bookReady = loadBook().catch(() => {});

// Name of the deepest named opening along a sequence of SAN moves.
function openingName(sans) {
  for (let i = sans.length; i > 0; i--) {
    const name = book.names.get(sans.slice(0, i).join(' '));
    if (name) return name;
  }
  return '';
}

function parseGame(pgn) {
  pgn = pgn.trim();
  const second = pgn.indexOf('[Event ', 1);
  if (second > 0) pgn = pgn.slice(0, second).trim();
  const chess = new Chess();
  chess.loadPgn(pgn);
  const hist = chess.history({ verbose: true });
  if (!hist.length) throw new Error('No moves found in that PGN.');
  return {
    headers: chess.getHeaders(),
    fens: [hist[0].before, ...hist.map(m => m.after)],
    moves: hist.map(m => ({
      san: m.san, from: m.from, to: m.to, color: m.color, piece: m.piece, captured: m.captured,
      promotion: m.promotion, uci: m.from + m.to + (m.promotion || ''), before: m.before, after: m.after,
    })),
  };
}

async function startReview(pgn, asBlack = false) {
  $('#load-error').textContent = '';
  let g;
  try { g = parseGame(pgn); } catch (e) {
    $('#load-error').textContent = 'Could not read PGN: ' + e.message;
    return;
  }
  game = g;
  cur = 0;
  explore = sel = null;
  flipped = asBlack;
  $('#view-load').hidden = true;
  $('#view-review').hidden = false;
  $('#btn-new').hidden = false;
  $('#summary').hidden = true;
  $('#progress-box').hidden = false;
  setProgress(0, 'Starting engine...');
  renderMoves();
  render();

  const run = ++runId;
  killEngines();
  const n = g.fens.length, depth = +$('#depth').value;
  const evals = new Array(n);
  let next = 0, done = 0;
  const count = Math.max(1, Math.min(n, 6, (navigator.hardwareConcurrency || 4) - 1));
  engines = Array.from({ length: count }, () => new Engine());
  await Promise.all([bookReady, ...engines.map(async eng => {
    await eng.ready;
    while (run === runId && next < n) {
      const i = next++;
      evals[i] = terminalEval(g.fens[i]) ?? await eng.analyze(g.fens[i], depth);
      if (run !== runId) return;
      setProgress(++done / n, `Analyzing... ${done}/${n} positions`);
    }
  })]);
  if (run !== runId) return;
  killEngines();
  g.evals = evals;
  classify(g);
  $('#progress-box').hidden = true;
  renderSummary();
  renderMoves();
  render();
}

function setProgress(frac, label) {
  $('#progress-fill').style.width = frac * 100 + '%';
  $('#progress-label').textContent = label;
}

async function getJSON(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(r.status === 404 ? 'User not found.' : `Request failed (${r.status}).`);
  return r;
}

async function fetchChessCom(user) {
  const base = `https://api.chess.com/pub/player/${encodeURIComponent(user.toLowerCase())}/games/archives`;
  const { archives } = await (await getJSON(base)).json();
  const games = [];
  for (const url of archives.slice(-3).reverse()) {
    games.push(...(await (await getJSON(url)).json()).games.reverse());
    if (games.length >= 40) break;
  }
  return games.filter(x => x.rules === 'chess' && x.pgn).slice(0, 60).map(x => ({
    white: x.white.username, whiteElo: x.white.rating, black: x.black.username, blackElo: x.black.rating,
    result: x.white.result === 'win' ? '1-0' : x.black.result === 'win' ? '0-1' : '\u00bd-\u00bd',
    type: x.time_class, date: new Date(x.end_time * 1000), pgn: x.pgn,
  }));
}

async function fetchLichess(user) {
  const url = `https://lichess.org/api/games/user/${encodeURIComponent(user)}?max=40&pgnInJson=true`;
  const text = await (await getJSON(url, { headers: { Accept: 'application/x-ndjson' } })).text();
  return text.split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(x => x.variant === 'standard' && x.pgn).map(x => ({
    white: x.players.white.user?.name ?? 'Anonymous', whiteElo: x.players.white.rating,
    black: x.players.black.user?.name ?? 'Anonymous', blackElo: x.players.black.rating,
    result: x.winner === 'white' ? '1-0' : x.winner === 'black' ? '0-1' : '\u00bd-\u00bd',
    type: x.speed, date: new Date(x.createdAt), pgn: x.pgn,
  }));
}

async function fetchGames() {
  const user = $('#username').value.trim(), site = $('#site').value;
  if (!user) return;
  localStorage.setItem('review-user', JSON.stringify({ user, site }));
  $('#games').innerHTML = '';
  $('#games-status').textContent = 'Loading games...';
  try {
    const games = await (site === 'lichess' ? fetchLichess(user) : fetchChessCom(user));
    $('#games-status').textContent = games.length ? `${games.length} recent games - click one to review` : 'No games found.';
    const me = user.toLowerCase();
    games.forEach(x => {
      const asBlack = x.black.toLowerCase() === me;
      const won = x.result === (asBlack ? '0-1' : '1-0'), drawn = x.result.length > 3;
      const el = document.createElement('div');
      el.className = 'game';
      el.innerHTML = `<span class="res ${drawn ? '' : won ? 'win' : 'loss'}">${x.result}</span>
        <span class="names">${esc(x.white)} (${esc(x.whiteElo ?? '?')}) vs ${esc(x.black)} (${esc(x.blackElo ?? '?')})</span>
        <span class="muted">${esc(x.type)} &middot; ${x.date.toLocaleDateString()}</span>`;
      el.onclick = () => startReview(x.pgn, asBlack);
      $('#games').append(el);
    });
  } catch (e) {
    $('#games-status').textContent = e.message;
  }
}

// ---------- rendering ----------

function sqXY(sq) {
  const f = sq.charCodeAt(0) - 97, r = +sq[1] - 1;
  return flipped ? [7 - f, r] : [f, 7 - r];
}

function renderBoard() {
  if (drag) return;
  const fen = curFen(), ex = explore;
  const pieces = {};
  fen.split(' ')[0].split('/').forEach((row, i) => {
    let f = 0;
    for (const ch of row) {
      if (ch >= '1' && ch <= '8') f += +ch;
      else pieces['abcdefgh'[f++] + (8 - i)] = (ch === ch.toUpperCase() ? 'w' : 'b') + ch.toUpperCase();
    }
  });
  const t = mode === 'openings' ? trainer : null;
  const move = mode === 'openings' ? (t?.pos ? t.line.moves[t.pos - 1] : null)
    : ex?.pos ? ex.moves[ex.pos - 1] : game && cur > 0 ? game.moves[cur - 1] : null;
  const rev = move?.review;
  const color = rev ? CLASSES[rev.cls].color : '#f5f682';
  let html = '';
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const f = flipped ? 7 - x : x, r = flipped ? y : 7 - y;
    const sq = 'abcdefgh'[f] + (r + 1);
    html += `<div class="sq ${(f + r) % 2 ? 'light' : 'dark'}${y === 0 ? ' edge-top' : ''}${x === 7 ? ' edge-right' : ''}" data-sq="${sq}">`;
    if (move && (sq === move.from || sq === move.to)) html += `<div class="hl" style="background:${color}"></div>`;
    if (sel?.sq === sq) html += '<div class="hl" style="background:#f5f682"></div>';
    if (x === 0) html += `<span class="coord rank">${r + 1}</span>`;
    if (y === 7) html += `<span class="coord file">${'abcdefgh'[f]}</span>`;
    if (pieces[sq]) html += `<img src="vendor/pieces/${pieces[sq]}.svg" alt="" draggable="false">`;
    if (rev && sq === move.to) html += `<span class="badge" style="background:${color}">${CLASSES[rev.cls].sym}</span>`;
    if (sel?.targets.includes(sq)) html += `<span class="dot${pieces[sq] ? ' cap' : ''}"></span>`;
    html += '</div>';
  }
  $('#board').innerHTML = html;

  // Following the game: the move that should have been played. Exploring: the engine's suggestion from here.
  let arrow = '';
  const hint = mode === 'openings' ? t && (t.tmode === 'learn' || t.hint) && t.line.moves[t.pos]?.uci
    : ex ? ex.evals[ex.pos]?.[0]?.pv[0] : rev && !rev.isBest && rev.cls !== 'book' && rev.bestUci;
  if (hint) {
    const [x1, y1] = sqXY(hint.slice(0, 2)), [x2, y2] = sqXY(hint.slice(2, 4));
    const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy), ux = dx / len, uy = dy / len;
    const ex = x2 + .5 - ux * .32, ey = y2 + .5 - uy * .32;
    arrow = `<g fill="#81b64c" stroke="#81b64c" opacity=".85">
      <line x1="${x1 + .5 + ux * .3}" y1="${y1 + .5 + uy * .3}" x2="${ex}" y2="${ey}" stroke-width=".17"/>
      <polygon stroke="none" points="${x2 + .5 - ux * .05},${y2 + .5 - uy * .05} ${ex - uy * .22},${ey + ux * .22} ${ex + uy * .22},${ey - ux * .22}"/></g>`;
  }
  $('#arrows').innerHTML = arrow;
}

function renderPlayers() {
  const h = game?.headers ?? {};
  const row = mode === 'openings' ? c => `<span>${c === 'w' ? 'White' : 'Black'}${c === op.side ? ' (you)' : ''}</span>` : c => {
    const name = (c === 'w' ? h.White : h.Black) || (c === 'w' ? 'White' : 'Black');
    const elo = c === 'w' ? h.WhiteElo : h.BlackElo;
    const acc = game?.accuracy ? `<span class="acc">Accuracy ${game.accuracy[c].toFixed(1)}</span>` : '';
    return `<span>${esc(name)}</span>${elo && elo !== '?' ? `<span class="elo">(${esc(elo)})</span>` : ''}${acc}`;
  };
  $('#player-top').innerHTML = row(flipped ? 'w' : 'b');
  $('#player-bottom').innerHTML = row(flipped ? 'b' : 'w');
}

function renderEval() {
  $('#evalbar').style.visibility = mode === 'openings' ? 'hidden' : '';
  const line = explore ? explore.evals[explore.pos]?.[0] : game?.evals?.[cur]?.[0];
  const wp = line ? winPct(line) : 50;
  $('#evalbar').classList.toggle('flipped', flipped);
  $('#evalbar-fill').style.height = wp + '%';
  const t = $('#evalbar-text');
  t.textContent = !line ? '' : line.cp != null ? Math.abs(line.cp / 100).toFixed(1) : line.winner ? evalText(line) : 'M' + Math.abs(line.mate);
  const whiteAhead = wp >= 50;
  t.classList.toggle('dark', !whiteAhead);
  t.classList.toggle('top', whiteAhead === flipped);
}

function renderCoach() {
  const coach = $('#coach'), lines = $('#lines');
  lines.innerHTML = '';
  $('#explore').hidden = !explore;
  if (explore) return renderExplore();
  if (!game.evals) {
    coach.innerHTML = '<span class="muted">The review will appear here once the analysis finishes. You can step through the game meanwhile.</span>';
    return;
  }
  const ev = `<span class="eval">${evalText(game.evals[cur][0])}</span>`;
  if (cur === 0) coach.innerHTML = `<span>Starting position. Use the arrow keys to step through the game.</span>${ev}`;
  else {
    const m = game.moves[cur - 1], rev = m.review;
    const no = Math.ceil(cur / 2) + (m.color === 'w' ? '. ' : '... ');
    const alt = !rev.isBest && rev.cls !== 'book' && rev.bestSan ? ` The best move was <b>${esc(rev.bestSan)}</b>.` : '';
    coach.innerHTML = `${badge(rev.cls)}<span><b>${no}${esc(m.san)}</b> is ${CLASSES[rev.cls].phrase}.${alt}</span>${ev}`;
  }
  lines.innerHTML = linesHtml(game.evals[cur]);
}

// Numbered SAN text for moves starting at the given ply (0 = White's first move).
function numbered(sans, ply) {
  let no = Math.floor(ply / 2) + 1, white = ply % 2 === 0, text = white ? '' : no + '... ';
  for (const s of sans) {
    if (white) text += no + '. ';
    text += s + ' ';
    if (!white) no++;
    white = !white;
  }
  return text;
}

function linesHtml(evalLines) {
  return evalLines.filter(l => l.pv.length).map(l =>
    `<div class="line"><span class="ev${winPct(l) < 50 ? ' neg' : ''}">${evalText(l)}</span>${esc(numbered(pvToSan(curFen(), l.pv), curPly()))}</div>`).join('');
}

function renderExplore() {
  const x = explore, ev = x.evals[x.pos], prevEv = x.evals[x.pos - 1], m = x.moves[x.pos - 1];
  const trail = x.moves.map((mv, i) => {
    const t = numbered([mv.san], x.base + i).trim();
    const label = i && mv.color === 'b' ? mv.san : t;
    return `<span class="xm${i === x.pos - 1 ? ' cur' : ''}" data-pos="${i + 1}">${esc(label)}</span>`;
  }).join(' ');
  $('#explore-line').innerHTML = `<b>Trying:</b> ${trail}`;

  let text = '';
  if (m) {
    if (ev && prevEv) {
      const j = judge(m, prevEv, ev);
      const bestSan = j.top.pv[0] ? pvToSan(x.fens[x.pos - 1], [j.top.pv[0]])[0] : '';
      m.review = { cls: j.cls, isBest: j.isBest };
      text = `${badge(j.cls)}<span><b>${esc(numbered([m.san], x.base + x.pos - 1).trim())}</b> is ${CLASSES[j.cls].phrase}.${!j.isBest && bestSan ? ` Best was <b>${esc(bestSan)}</b>.` : ''}`;
    } else text = `<span><b>${esc(numbered([m.san], x.base + x.pos - 1).trim())}</b>`;
  } else text = '<span>';
  if (!ev) text += ' Stockfish is thinking...</span>';
  else {
    const next = ev[0].pv[0] && pvToSan(curFen(), [ev[0].pv[0]])[0];
    text += next ? ` Stockfish suggests <b>${esc(next)}</b> next.</span>` : ' Game over.</span>';
    const depth = ev[0].depth ? `<span class="muted"> d${ev[0].depth}</span>` : '';
    text += `<span class="eval">${evalText(ev[0])}${depth}</span>`;
    $('#lines').innerHTML = linesHtml(ev);
  }
  $('#coach').innerHTML = text;
}

function renderLive() {
  renderCoach();
  renderBoard();
  renderEval();
}

function renderSummary() {
  const h = game.headers, a = game.accuracy;
  let html = `<details open><summary>Game summary</summary><table><tr><th>${esc(h.White || 'White')}</th><th></th><th>${esc(h.Black || 'Black')}</th></tr>
    <tr class="accrow"><td><span class="accbox w">${a.w.toFixed(1)}</span></td><td class="label">Accuracy</td><td><span class="accbox b">${a.b.toFixed(1)}</span></td></tr>
    <tr class="accrow" title="Rough estimate from move accuracy, blended with the player's actual rating when known"><td><span class="accbox w">${game.rating.w}</span></td><td class="label">Est. rating</td><td><span class="accbox b">${game.rating.b}</span></td></tr>`;
  for (const [k, c] of Object.entries(CLASSES)) {
    html += `<tr><td class="n" style="color:${c.color}">${game.counts.w[k]}</td><td class="label">${badge(k)}${c.label}</td><td class="n" style="color:${c.color}">${game.counts.b[k]}</td></tr>`;
  }
  $('#summary').innerHTML = html + '</table></details>';
  $('#summary').hidden = false;
  $('#opening').textContent = game.opening;
}

function renderMoves() {
  let html = '';
  const offset = game.moves[0].color === 'b' ? 1 : 0;
  if (offset) html += '<div class="num">1.</div><div></div>';
  game.moves.forEach((m, i) => {
    if (m.color === 'w') html += `<div class="num">${(i + offset) / 2 + 1}.</div>`;
    html += `<div class="mv" data-ply="${i + 1}">${m.review ? badge(m.review.cls) : ''}${esc(m.san)}</div>`;
  });
  $('#moves').innerHTML = html;
  $('#opening').textContent = game.opening || '';
}

function renderGraph() {
  const cv = $('#graph'), dpr = devicePixelRatio || 1;
  const w = cv.width = cv.clientWidth * dpr, h = cv.height = cv.clientHeight * dpr;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#403d39';
  ctx.fillRect(0, 0, w, h);
  if (!game) return;
  const n = game.fens.length - 1, X = i => n ? i / n * w : 0;
  if (game.evals) {
    const Y = i => h - winPct(game.evals[i][0]) / 100 * h;
    ctx.beginPath();
    ctx.moveTo(0, h);
    for (let i = 0; i <= n; i++) ctx.lineTo(X(i), Y(i));
    ctx.lineTo(w, h);
    ctx.fillStyle = '#f1f1f1';
    ctx.fill();
    game.moves.forEach((m, i) => {
      if (!['brilliant', 'great', 'mistake', 'miss', 'blunder'].includes(m.review.cls)) return;
      ctx.beginPath();
      ctx.arc(X(i + 1), Math.max(4 * dpr, Math.min(h - 4 * dpr, Y(i + 1))), 3 * dpr, 0, 7);
      ctx.fillStyle = CLASSES[m.review.cls].color;
      ctx.fill();
    });
  }
  ctx.fillStyle = 'rgba(128,128,128,.6)';
  ctx.fillRect(0, h / 2, w, dpr);
  ctx.fillStyle = '#e58f2a';
  ctx.fillRect(Math.min(w - 2 * dpr, X(cur)), 0, 2 * dpr, h);
}

function render() {
  if (mode === 'openings') return renderOpenings();
  const x = explore;
  if (x && !x.evals[x.pos]?.final) {
    const done = terminalEval(x.fens[x.pos]);
    if (done) x.evals[x.pos] = Object.assign(done, { final: true });
    else liveAnalyze(x, x.pos);
  }
  renderBoard();
  renderPlayers();
  renderEval();
  if (!game) return;
  renderCoach();
  renderGraph();
  document.querySelectorAll('#moves .mv').forEach(el => {
    const on = +el.dataset.ply === cur;
    el.classList.toggle('cur', on);
    if (on) el.scrollIntoView({ block: 'nearest' });
  });
  if (cur === 0) $('#moves').scrollTop = 0;
}

function go(ply) {
  if (!game) return;
  explore = sel = null;
  cur = Math.max(0, Math.min(game.fens.length - 1, ply));
  render();
}

function nav(action) {
  sel = null;
  if (action === 'flip') { flipped = !flipped; render(); }
  else if (explore && action === 'prev' && explore.pos > 0) { explore.pos--; render(); }
  else if (explore && action === 'next') { if (explore.pos < explore.moves.length) { explore.pos++; render(); } }
  else if (explore && action === 'prev') go(cur);
  else go({ start: 0, prev: cur - 1, next: cur + 1, end: Infinity }[action]);
}

// ---------- openings trainer ----------

function setMode(m) {
  mode = m;
  sel = null;
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('on', b.dataset.mode === m));
  $('#view-openings').hidden = m !== 'openings';
  $('#view-load').hidden = m !== 'review' || !!game;
  $('#view-review').hidden = m !== 'review' || !game;
  $('#btn-new').hidden = m !== 'review' || !game;
  if (m === 'openings') {
    flipped = op.side === 'b';
    bookReady.then(renderOpList);
  }
  render();
}

function renderOpList() {
  const q = $('#op-search').value.trim().toLowerCase();
  const fams = [...book.families.values()]
    .filter(f => !q || f.name.toLowerCase().includes(q) || f.lines.some(l => l.name.toLowerCase().includes(q) || l.eco.toLowerCase() === q))
    .sort((a, b) => b.lines.length - a.lines.length || a.name.localeCompare(b.name));
  $('#op-status').textContent = `${fams.length} openings, ${book.names.size} lines` + (fams.length > 150 ? ' - showing the largest 150, search to narrow down' : '');
  $('#op-list').innerHTML = fams.slice(0, 150).map(f => {
    const done = f.lines.filter(l => mastered.has(l.key)).length;
    return `<div class="game" data-family="${esc(f.name)}"><span class="names">${esc(f.name)}</span>
      <span class="muted">${done}/${f.lines.length} mastered</span></div>`;
  }).join('');
}

function openFamily(name) {
  op.family = book.families.get(name);
  op.screen = 'family';
  op.side = /Defen[cs]e|Counter/i.test(name) ? 'b' : 'w';
  flipped = op.side === 'b';
  trainer = null;
  render();
}

function openLine(line, tmode) {
  if (!line.fens) {
    const c = new Chess();
    line.fens = [c.fen()];
    line.moves = line.sans.map(san => {
      const m = c.move(san);
      line.fens.push(m.after);
      return { san: m.san, from: m.from, to: m.to, color: m.color, uci: m.from + m.to + (m.promotion || '') };
    });
  }
  trainer = { line, tmode, pos: 0, mistakes: 0, wrong: 0, hint: false, done: false, waiting: false, msg: '' };
  op.screen = 'train';
  sel = null;
  flipped = op.side === 'b';
  if (tmode === 'practice') opponentTurn();
  render();
}

// In practice mode, finish the line or let the opponent reply after a short pause.
function opponentTurn() {
  const t = trainer;
  if (t.pos >= t.line.moves.length) {
    t.done = true;
    if (!t.mistakes) {
      mastered.add(t.line.key);
      localStorage.setItem('openings-mastered', JSON.stringify([...mastered]));
    }
  } else if (t.line.moves[t.pos].color !== op.side) {
    t.waiting = true;
    setTimeout(() => {
      if (trainer !== t) return;
      t.waiting = false;
      t.pos++;
      opponentTurn();
      render();
    }, 450);
  }
}

function trainerMove(from, to) {
  const t = trainer, want = t.line.moves[t.pos];
  if (!want) return render();
  if (want.from === from && want.to === to) {
    t.pos++;
    t.wrong = 0;
    t.hint = false;
    t.msg = '';
    if (t.tmode === 'practice') opponentTurn();
  } else {
    const san = new Chess(curFen()).move({ from, to, promotion: 'q' }).san;
    const sans = [...t.line.sans.slice(0, t.pos), san];
    const other = book.prefixes.has(sans.join(' ')) && openingName(sans);
    t.msg = other ? `<b>${esc(san)}</b> is also theory (${esc(other)}), but this line plays something else.`
      : `<b>${esc(san)}</b> is not the move in this line. Try again.`;
    if (t.tmode === 'practice') {
      t.mistakes++;
      if (++t.wrong >= 2) t.hint = true;
    }
  }
  render();
}

// Next line to drill: a random one not yet mastered, falling back to any other line in the family.
function nextLine() {
  const lines = op.family.lines.filter(l => l !== trainer?.line);
  const todo = lines.filter(l => !mastered.has(l.key));
  const pool = todo.length ? todo : lines.length ? lines : op.family.lines;
  return pool[Math.floor(Math.random() * pool.length)];
}

function opNav(action) {
  const t = trainer;
  if (action === 'flip') flipped = !flipped;
  else if (t?.tmode === 'learn') {
    const n = t.line.moves.length;
    t.pos = Math.max(0, Math.min(n, { start: 0, prev: t.pos - 1, next: t.pos + 1, end: n }[action]));
    t.msg = '';
    sel = null;
  }
  render();
}

function familyHtml() {
  const f = op.family, done = f.lines.filter(l => mastered.has(l.key)).length;
  const seg = (side, label) => `<button class="seg${op.side === side ? ' on' : ''}" data-act="side" data-side="${side}">${label}</button>`;
  return `<div><button class="ghost" data-act="browse">&larr; All openings</button></div>
    <div class="card"><h2>${esc(f.name)}</h2>
      <div class="muted">${f.lines.length} lines, ${done} mastered</div>
      <div class="row"><span class="muted">Play as</span>${seg('w', 'White')}${seg('b', 'Black')}
        <button data-act="drill" style="margin-left:auto">Practice random line</button></div></div>
    <div id="op-lines">${f.lines.map((l, i) => `<div class="game" data-line="${i}">
      <span class="res win">${mastered.has(l.key) ? '\u2713' : ''}</span>
      <span class="names"><b>${esc(l.name === f.name ? 'Main line' : l.name.slice(f.name.length + 2))}</b><br><span class="muted">${esc(l.eco)} &middot; ${esc(numbered(l.sans, 0))}</span></span>
      <button class="ghost" data-act="learn" data-line="${i}">Learn</button></div>`).join('')}</div>`;
}

function trainHtml() {
  const t = trainer, L = t.line, n = L.moves.length, learn = t.tmode === 'learn';
  const side = op.side === 'w' ? 'White' : 'Black';
  const shown = learn ? n : t.pos;
  const moves = L.moves.slice(0, shown).map((m, i) =>
    `<span class="xm${i === t.pos - 1 ? ' cur' : ''}"${learn ? ` data-pos="${i + 1}"` : ''}>${esc(i && m.color === 'b' ? m.san : numbered([m.san], i).trim())}</span>`).join(' ');
  let status;
  if (learn) status = t.pos < n ? `Next is <b>${esc(numbered([L.sans[t.pos]], t.pos).trim())}</b>. Play it on the board or press the right arrow.` : 'End of the line. Ready to practice it from memory?';
  else if (t.done) status = t.mistakes ? `Line complete with ${t.mistakes} mistake${t.mistakes > 1 ? 's' : ''}. Repeat it without mistakes or hints to master it.` : 'Line complete with no mistakes. Mastered!';
  else status = t.waiting ? 'Opponent is moving...' : `Your move as ${side}.` + (t.hint ? ' The arrow shows the move.' : '');
  const buttons = learn
    ? `<button class="ghost" data-act="nav" data-nav="start">&#x23EE;&#xFE0E;</button><button class="ghost" data-act="nav" data-nav="prev">&#x25C0;&#xFE0E;</button>
       <button class="ghost" data-act="nav" data-nav="next">&#x25B6;&#xFE0E;</button><button data-act="practice">Practice this line</button>`
    : `${t.done ? '' : '<button class="ghost" data-act="hint">Hint</button>'}<button class="ghost" data-act="restart">Restart</button>
       <button class="ghost" data-act="tolearn">Learn</button><button${t.done ? '' : ' class="ghost"'} data-act="drill">Next line</button>`;
  return `<div><button class="ghost" data-act="family">&larr; ${esc(op.family.name)}</button></div>
    <div class="card"><h2>${esc(L.name)}</h2>
      <div class="muted">${esc(L.eco)} &middot; ${learn ? 'Learning' : 'Practicing'} as ${side}${mastered.has(L.key) ? ' &middot; mastered' : ''}</div></div>
    <div class="card">${t.msg ? `<div class="error" style="margin:0 0 6px">${t.msg}</div>` : ''}${status}</div>
    <div class="card" id="op-moves">${moves || '<span class="muted">No moves yet</span>'}</div>
    <div class="muted">${esc(openingName(L.sans.slice(0, t.pos)) || 'Starting position')}</div>
    <div class="nav">${buttons}</div>`;
}

function renderOpenings() {
  renderBoard();
  renderPlayers();
  renderEval();
  $('#op-browse').hidden = op.screen !== 'browse';
  const d = $('#op-detail');
  d.hidden = op.screen === 'browse';
  if (op.screen !== 'browse') d.innerHTML = op.screen === 'family' ? familyHtml() : trainHtml();
}

$('#op-search').oninput = renderOpList;
$('#op-list').onclick = e => { const el = e.target.closest('[data-family]'); if (el) openFamily(el.dataset.family); };
$('#op-detail').onclick = e => {
  const b = e.target.closest('[data-act]'), row = e.target.closest('[data-line]'), xm = e.target.closest('.xm[data-pos]');
  const t = trainer;
  const act = b?.dataset.act;
  if (act === 'browse') { op.screen = 'browse'; trainer = null; renderOpList(); render(); }
  else if (act === 'family') { op.screen = 'family'; trainer = null; render(); }
  else if (act === 'side') { op.side = b.dataset.side; flipped = op.side === 'b'; render(); }
  else if (act === 'drill') openLine(nextLine(), 'practice');
  else if (act === 'learn') openLine(op.family.lines[b.dataset.line], 'learn');
  else if (act === 'practice' || act === 'restart') openLine(t.line, 'practice');
  else if (act === 'tolearn') openLine(t.line, 'learn');
  else if (act === 'hint') { if (!t.hint) t.mistakes++; t.hint = true; render(); }
  else if (act === 'nav') opNav(b.dataset.nav);
  else if (xm) { t.pos = +xm.dataset.pos; t.msg = ''; render(); }
  else if (row) openLine(op.family.lines[row.dataset.line], 'practice');
};
document.querySelectorAll('.tab').forEach(b => b.onclick = () => setMode(b.dataset.mode));

// Play a move on the board: follows the game if it matches the next game move, otherwise starts or extends a variation.
function playMove(from, to) {
  sel = null;
  if (mode === 'openings') return trainerMove(from, to);
  const mv = new Chess(curFen()).move({ from, to, promotion: 'q' });
  const uci = from + to + (mv.promotion || '');
  if (!explore) {
    if (game.moves[cur]?.uci === uci) return go(cur + 1);
    const known = game.evals?.[cur];
    explore = { base: cur, pos: 0, fens: [game.fens[cur]], moves: [], evals: [known && Object.assign([...known], { final: true })] };
  }
  const x = explore;
  if (x.moves[x.pos]?.uci !== uci) {
    x.moves.length = x.pos;
    x.fens.length = x.evals.length = x.pos + 1;
    x.moves.push({ san: mv.san, from, to, color: mv.color, uci });
    x.fens.push(mv.after);
  }
  x.pos++;
  render();
}

const boardEl = $('#board');
boardEl.addEventListener('pointerdown', e => {
  const sq = e.target.closest('.sq')?.dataset.sq;
  if (!(mode === 'openings' ? trainer && !trainer.done && !trainer.waiting : game) || e.button || !sq) return;
  e.preventDefault();
  if (sel?.targets.includes(sq)) return playMove(sel.sq, sq);
  const targets = new Chess(curFen()).moves({ square: sq, verbose: true }).map(m => m.to);
  sel = targets.length ? { sq, targets } : null;
  renderBoard();
  const img = sel && boardEl.querySelector(`[data-sq="${sq}"] img`);
  if (!img) return;
  img.style.zIndex = 5;
  img.style.pointerEvents = 'none';
  drag = { img, sq, x: e.clientX, y: e.clientY, moved: false };
  boardEl.setPointerCapture(e.pointerId);
});
boardEl.addEventListener('pointermove', e => {
  if (!drag) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  drag.moved ||= Math.hypot(dx, dy) > 4;
  if (drag.moved) drag.img.style.transform = `translate(${dx}px,${dy}px)`;
});
const endDrag = e => {
  if (!drag) return;
  const d = drag;
  drag = null;
  const to = d.moved && e.type === 'pointerup' && document.elementFromPoint(e.clientX, e.clientY)?.closest('.sq')?.dataset.sq;
  if (to && sel?.targets.includes(to)) return playMove(d.sq, to);
  if (d.moved && to !== d.sq) sel = null;
  render();
};
boardEl.addEventListener('pointerup', endDrag);
boardEl.addEventListener('pointercancel', endDrag);

// ---------- events ----------

$('#form-user').addEventListener('submit', e => { e.preventDefault(); fetchGames(); });
$('#btn-pgn').onclick = () => startReview($('#pgn').value);
$('#btn-sample').onclick = () => { $('#pgn').value = SAMPLE_PGN; startReview(SAMPLE_PGN); };
$('#btn-new').onclick = () => {
  runId++;
  killEngines();
  $('#view-review').hidden = true;
  $('#view-load').hidden = false;
  $('#btn-new').hidden = true;
};
$('#btn-back').onclick = () => go(cur);
$('#explore-line').onclick = e => {
  const el = e.target.closest('.xm');
  if (el && explore) { sel = null; explore.pos = +el.dataset.pos; render(); }
};
$('#moves').onclick = e => { const el = e.target.closest('.mv'); if (el) go(+el.dataset.ply); };
$('#view-review .nav').onclick = e => { const b = e.target.closest('button'); if (b) nav(b.dataset.nav); };
$('#graph').onclick = e => {
  if (!game) return;
  const r = e.currentTarget.getBoundingClientRect();
  go(Math.round((e.clientX - r.left) / r.width * (game.fens.length - 1)));
};
document.addEventListener('keydown', e => {
  if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName) || e.ctrlKey || e.metaKey || e.altKey) return;
  const action = { ArrowLeft: 'prev', ArrowRight: 'next', Home: 'start', End: 'end', ArrowUp: 'start', ArrowDown: 'end', f: 'flip' }[e.key];
  if (!action || mode === 'review' && !game) return;
  e.preventDefault();
  (mode === 'openings' ? opNav : nav)(action);
});
addEventListener('resize', renderGraph);

try {
  const saved = JSON.parse(localStorage.getItem('review-user'));
  if (saved) { $('#username').value = saved.user; $('#site').value = saved.site; }
} catch { /* no saved user */ }
render();
if (location.hash === '#sample') $('#btn-sample').click();
if (location.hash === '#openings') setMode('openings');
