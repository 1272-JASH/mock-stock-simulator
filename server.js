/* ─────────────────────────────────────────────
   Mock Stock Simulator — Beyond Realities
   Authoritative backend (Socket.IO).
───────────────────────────────────────────── */
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

/* ─────────────────────────────────────────────
   CONSTANTS  (must match the frontend fallbacks)
───────────────────────────────────────────── */
const ADMIN_PASS = 'piyush26';         // frontend hard-codes this
let   ROUND_DUR  = 10 * 60 * 1000;     // 10 min / round — ADMIN can change this
const START_CASH = 1500000;            // ₹15,00,000 per team
const MAX_ROUNDS = 5;

/* Stock universe. PRICES[symbol] = [r1, r2, r3, r4, r5]
   r1 is the fixed IPO / issue price. Rounds 2-5 are the target
   closes the frontend's price engine drifts toward.
   ADMIN can add/remove stocks and edit any of these values. */
let PRICES = {
  RELI: [1200, 1340, 1290, 1450, 1600],
  TCST: [ 900,  960, 1050,  990, 1120],
  HDBK: [ 750,  720,  810,  870,  840],
  INFY: [ 640,  700,  680,  760,  820],
  TAMO: [ 480,  560,  530,  620,  700],
  ADAN: [ 850,  980, 1150,  900, 1080],
  SUNP: [ 560,  590,  620,  600,  660],
  ITCX: [ 320,  345,  330,  360,  380],
};
function stocks() { return Object.keys(PRICES); }

/* ─────────────────────────────────────────────
   AUTHORITATIVE STATE
───────────────────────────────────────────── */
function freshGameState() {
  return { round: 1, roundStart: null, gameStarted: false, news: '', oid: 0 };
}
let gameState    = freshGameState();
let teams        = {};   // { name: { cash, holdings:{}, avgBuy:{} } }
let orders       = [];   // [ { id, stock, seller, qty, price } ]
let pendingJoins = [];   // [ { name, socketId } ]  — new teams awaiting admin approval

/* ─────────────────────────────────────────────
   HELPERS
───────────────────────────────────────────── */
function ensureTeam(name) {
  if (!teams[name]) teams[name] = { cash: START_CASH, holdings: {}, avgBuy: {} };
  return teams[name];
}

function updateAvgBuy(team, sym, buyQty, price) {
  const oldQty = team.holdings[sym] || 0;
  const oldAvg = team.avgBuy[sym] || 0;
  const newQty = oldQty + buyQty;
  team.avgBuy[sym] = newQty > 0 ? (oldQty * oldAvg + buyQty * price) / newQty : 0;
}

/* Coerce an arbitrary array into MAX_ROUNDS positive integers. */
function normalizePrices(arr) {
  arr = Array.isArray(arr) ? arr : [];
  const out = [];
  for (let i = 0; i < MAX_ROUNDS; i++) {
    let v = Number(arr[i]);
    if (!Number.isFinite(v) || v <= 0) {
      v = out.length ? out[out.length - 1]
        : (Number(arr.find(x => Number(x) > 0)) || 100);
    }
    out.push(Math.round(v));
  }
  return out;
}

function snapshot() {
  return {
    STOCKS: stocks(),
    PRICES,
    ROUND_DUR,
    START_CASH,
    gameState: {
      round: gameState.round,
      roundStart: gameState.roundStart,
      gameStarted: gameState.gameStarted,
      news: gameState.news,
      oid: gameState.oid,
    },
    teams,
    orders,
    pendingJoins: [...new Set(pendingJoins.map(p => p.name))], // unique names for admin
    candleHistory: {},   // frontend builds candles client-side
  };
}

function broadcast() { io.emit('stateUpdate', snapshot()); }

/* ─────────────────────────────────────────────
   CONNECTION
───────────────────────────────────────────── */
io.on('connection', (socket) => {
  socket.emit('stateUpdate', snapshot());

  const ok  = (msg) => socket.emit('toast', { msg, err: false });
  const err = (msg) => socket.emit('toast', { msg, err: true });

  /* ---- Join / re-login ---------------------------------------------
     • Existing team name  → instant approval, data preserved
       (this is the "logged out by mistake, log back in" path).
     • Brand-new team name → queued for ADMIN approval; the player
       waits and cannot enter or trade until approved.            */
  socket.on('joinTeam', (name) => {
    name = (name || '').toString().trim();
    if (!name) return socket.emit('joinResult', { status: 'rejected', msg: 'Enter a team name' });

    if (teams[name]) {
      socket.emit('joinResult', { status: 'approved', name });
      ok('Welcome back, ' + name);
      return;
    }
    // New account → needs permission.
    if (!pendingJoins.some(p => p.name === name && p.socketId === socket.id)) {
      pendingJoins.push({ name, socketId: socket.id });
    }
    socket.emit('joinResult', { status: 'pending', name });
    broadcast();  // admin panel shows the new request
  });

  socket.on('disconnect', () => {
    pendingJoins = pendingJoins.filter(p => p.socketId !== socket.id);
  });

  /* ---- Round-1 IPO buy ---- */
  socket.on('execBuy', ({ CU, SEL, qty }) => {
    const team = teams[CU];
    if (!team) return err('Not authorized — join and get approved first');
    if (!PRICES[SEL]) return err('Unknown stock');
    if (!gameState.gameStarted) return err('Game has not started');
    qty = parseInt(qty, 10);
    if (!Number.isFinite(qty) || qty <= 0) return err('Invalid quantity');

    const price = PRICES[SEL][0];
    const cost  = qty * price;
    if (team.cash < cost) return err('Insufficient funds');

    team.cash -= cost;
    updateAvgBuy(team, SEL, qty, price);
    team.holdings[SEL] = (team.holdings[SEL] || 0) + qty;
    broadcast();
    ok(`Bought ${qty} ${SEL} @ ₹${price}`);
  });

  /* ---- Post a sell order (shares escrowed) ---- */
  socket.on('execSell', ({ CU, SEL, qty, price }) => {
    const team = teams[CU];
    if (!team) return err('Not authorized — join and get approved first');
    if (!PRICES[SEL]) return err('Unknown stock');
    qty = parseInt(qty, 10);
    price = Math.round(parseFloat(price));
    if (!Number.isFinite(qty) || qty <= 0) return err('Invalid quantity');
    if (!Number.isFinite(price) || price <= 0) return err('Invalid asking price');
    if ((team.holdings[SEL] || 0) < qty) return err('Not enough shares');

    team.holdings[SEL] -= qty;
    gameState.oid += 1;
    orders.push({ id: gameState.oid, stock: SEL, seller: CU, qty, price });
    broadcast();
    ok(`Sell order posted: ${qty} ${SEL} @ ₹${price}`);
  });

  /* ---- Buy from another team's sell order ---- */
  socket.on('execOrdBuy', ({ CU, SEL, ordId, qty }) => {
    const buyer = teams[CU];
    if (!buyer) return err('Not authorized — join and get approved first');
    const order = orders.find(o => o.id === ordId);
    if (!order || order.qty <= 0) return err('Order no longer available');
    if (order.seller === CU) return err('Cannot buy your own order');
    qty = parseInt(qty, 10);
    if (!Number.isFinite(qty) || qty <= 0) return err('Invalid quantity');
    if (qty > order.qty) return err('Not enough shares in that order');

    const seller = teams[order.seller];
    const cost = qty * order.price;
    if (buyer.cash < cost) return err('Insufficient funds');

    buyer.cash -= cost;
    updateAvgBuy(buyer, order.stock, qty, order.price);
    buyer.holdings[order.stock] = (buyer.holdings[order.stock] || 0) + qty;
    if (seller) seller.cash += cost;
    order.qty -= qty;
    if (order.qty <= 0) orders = orders.filter(o => o.id !== order.id);

    broadcast();
    ok(`Bought ${qty} ${order.stock} @ ₹${order.price}`);
  });

  /* ---- Cancel own order (returns escrowed shares) ---- */
  socket.on('cancelOrder', ({ CU, id }) => {
    const order = orders.find(o => o.id === id);
    if (!order) return err('Order not found');
    if (order.seller !== CU) return err('Not your order');
    const team = teams[order.seller];
    if (team) team.holdings[order.stock] = (team.holdings[order.stock] || 0) + order.qty;
    orders = orders.filter(o => o.id !== id);
    broadcast();
    ok('Order cancelled');
  });

  /* ---- Admin actions ---- */
  socket.on('adminAction', ({ action, payload, pass }) => {
    if (pass !== ADMIN_PASS) return err('Wrong admin password');

    switch (action) {
      /* --- teams & join approvals --- */
      case 'addTeam': {
        const name = (payload || '').toString().trim();
        if (!name) return err('Enter a team name');
        if (teams[name]) return err('Team already exists');
        ensureTeam(name);
        ok('Team added: ' + name);
        break;
      }
      case 'approveJoin': {
        const name = (payload || '').toString().trim();
        if (!name) return err('No team name');
        ensureTeam(name);
        pendingJoins.filter(p => p.name === name).forEach(p => {
          io.to(p.socketId).emit('joinResult', { status: 'approved', name });
          io.to(p.socketId).emit('toast', { msg: 'Approved! Welcome, ' + name, err: false });
        });
        pendingJoins = pendingJoins.filter(p => p.name !== name);
        ok('Approved ' + name);
        break;
      }
      case 'rejectJoin': {
        const name = (payload || '').toString().trim();
        pendingJoins.filter(p => p.name === name).forEach(p => {
          io.to(p.socketId).emit('joinResult', { status: 'rejected', msg: 'Admin denied your request' });
        });
        pendingJoins = pendingJoins.filter(p => p.name !== name);
        ok('Rejected ' + name);
        break;
      }

      /* --- round timing --- */
      case 'setRoundDuration': {
        const mins = parseFloat(payload);
        if (!Number.isFinite(mins) || mins <= 0) return err('Invalid duration');
        ROUND_DUR = Math.round(mins * 60 * 1000);
        ok(`Round length set to ${mins} min`);
        break;
      }

      /* --- price editing --- */
      case 'setPrices': {   // payload = { SYM: [r1..r5], ... }
        if (payload && typeof payload === 'object') {
          const next = {};
          for (const sym of Object.keys(payload)) next[sym] = normalizePrices(payload[sym]);
          if (Object.keys(next).length) PRICES = next;
          ok('Prices updated');
        }
        break;
      }
      case 'setPrice': {    // payload = { stock, round, price }
        const { stock, round, price } = payload || {};
        if (!PRICES[stock]) return err('Unknown stock');
        const r = parseInt(round, 10);
        const p = Math.round(Number(price));
        if (r < 1 || r > MAX_ROUNDS || !Number.isFinite(p) || p <= 0) return err('Invalid price/round');
        PRICES[stock][r - 1] = p;
        ok(`${stock} R${r} → ₹${p}`);
        break;
      }

      /* --- stock management --- */
      case 'addStock': {    // payload = { symbol, prices }
        let { symbol, prices } = payload || {};
        symbol = (symbol || '').toString().trim().toUpperCase();
        if (!symbol) return err('Enter a symbol');
        if (PRICES[symbol]) return err('Stock already exists');
        const arr = Array.isArray(prices) ? prices : (prices || '').toString().split(',');
        PRICES[symbol] = normalizePrices(arr);
        ok('Added stock ' + symbol);
        break;
      }
      case 'removeStock': {
        const symbol = (payload || '').toString().trim().toUpperCase();
        if (!PRICES[symbol]) return err('Unknown stock');
        delete PRICES[symbol];
        for (const t of Object.values(teams)) { delete t.holdings[symbol]; delete t.avgBuy[symbol]; }
        orders = orders.filter(o => o.stock !== symbol);
        ok('Removed stock ' + symbol);
        break;
      }

      /* --- game flow --- */
      case 'startGame':
        gameState.gameStarted = true;
        gameState.round = 1;
        gameState.roundStart = Date.now();
        ok('Game started');
        break;
      case 'nextRound':
        if (gameState.round < MAX_ROUNDS) {
          gameState.round += 1;
          gameState.roundStart = Date.now();
          ok('Advanced to round ' + gameState.round);
        } else { err('Already at final round'); }
        break;
      case 'endRoundNow':
        gameState.roundStart = Date.now() - ROUND_DUR;
        ok('Round ended');
        break;
      case 'fastForward':
        if (gameState.roundStart) gameState.roundStart -= 10 * 1000;  // shave 10s
        ok('Fast-forwarded 10s');
        break;
      case 'fastForwardTo': {   // payload = minutes LEFT
        const minsLeft = parseFloat(payload) || 0;
        gameState.roundStart = Date.now() - ROUND_DUR + minsLeft * 60 * 1000;
        ok(`${minsLeft} min left`);
        break;
      }
      case 'broadcastNews':
        gameState.news = (payload || '').toString();
        ok('News broadcast');
        break;
      case 'clearNews':
        gameState.news = '';
        ok('News cleared');
        break;
      case 'adminCancel': {
        const order = orders.find(o => o.id === payload);
        if (!order) return err('Order not found');
        const team = teams[order.seller];
        if (team) team.holdings[order.stock] = (team.holdings[order.stock] || 0) + order.qty;
        orders = orders.filter(o => o.id !== payload);
        ok('Order cancelled');
        break;
      }
      case 'resetGame':
        gameState = freshGameState();
        teams = {};
        orders = [];
        pendingJoins = [];
        ok('Game reset');
        break;

      default:
        return err('Unknown admin action: ' + action);
    }
    broadcast();
  });
});

/* ─────────────────────────────────────────────
   START
───────────────────────────────────────────── */
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n  Mock Stock Simulator running:  http://localhost:${PORT}`);
  console.log(`  Admin password: ${ADMIN_PASS}\n`);
});
