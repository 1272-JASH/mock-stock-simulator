/* ─────────────────────────────────────────────
   Mock Stock Simulator — Summer School Edition
   Backend (reconstructed to match the frontend's
   Socket.IO contract). Fully authoritative server.
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
   CONSTANTS  (must match the frontend)
───────────────────────────────────────────── */
const ADMIN_PASS = 'piyush26';         // frontend hard-codes this
const ROUND_DUR  = 10 * 60 * 1000;     // 10 minutes / round
const START_CASH = 1500000;            // ₹15,00,000 per team
const MAX_ROUNDS = 5;

/* Stock universe. PRICES[symbol] = [r1, r2, r3, r4, r5]
   r1 is the fixed IPO / issue price (round-1 buys happen here).
   Rounds 2-5 are peer-to-peer trading; these are the target
   closes the frontend's deterministic price engine drifts toward. */
const PRICES = {
  RELI: [1200, 1340, 1290, 1450, 1600],  // Reliance-style
  TCST: [ 900,  960, 1050,  990, 1120],  // IT major
  HDBK: [ 750,  720,  810,  870,  840],  // Private bank
  INFY: [ 640,  700,  680,  760,  820],  // IT services
  TAMO: [ 480,  560,  530,  620,  700],  // Auto
  ADAN: [ 850,  980, 1150,  900, 1080],  // High-volatility conglomerate
  SUNP: [ 560,  590,  620,  600,  660],  // Pharma
  ITCX: [ 320,  345,  330,  360,  380],  // FMCG
};
const STOCKS = Object.keys(PRICES);

/* ─────────────────────────────────────────────
   AUTHORITATIVE STATE
───────────────────────────────────────────── */
function freshGameState() {
  return {
    round: 1,
    roundStart: null,
    gameStarted: false,
    news: '',
    oid: 0,             // running order-id counter
  };
}
let gameState = freshGameState();
let teams  = {};   // { name: { cash, holdings:{sym:qty}, avgBuy:{sym:price} } }
let orders = [];   // [ { id, stock, seller, qty, price } ]

/* ─────────────────────────────────────────────
   HELPERS
───────────────────────────────────────────── */
function ensureTeam(name) {
  if (!teams[name]) teams[name] = { cash: START_CASH, holdings: {}, avgBuy: {} };
  return teams[name];
}

function updateAvgBuy(team, sym, buyQty, price) {
  const oldQty = team.holdings[sym] || 0;      // qty already held BEFORE this buy
  const oldAvg = team.avgBuy[sym] || 0;
  const newQty = oldQty + buyQty;
  team.avgBuy[sym] = newQty > 0
    ? (oldQty * oldAvg + buyQty * price) / newQty
    : 0;
}

function snapshot() {
  return {
    STOCKS,
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
    candleHistory: {},   // frontend builds candles client-side from the price engine
  };
}

function broadcast() {
  io.emit('stateUpdate', snapshot());
}

/* ─────────────────────────────────────────────
   CONNECTION
───────────────────────────────────────────── */
io.on('connection', (socket) => {
  // Send current state immediately so a fresh client renders.
  socket.emit('stateUpdate', snapshot());

  const ok  = (msg) => socket.emit('toast', { msg, err: false });
  const err = (msg) => socket.emit('toast', { msg, err: true });

  /* ---- Join a team (creates it if new) ---- */
  socket.on('joinTeam', (name) => {
    name = (name || '').toString().trim();
    if (!name) return err('Enter a team name');
    ensureTeam(name);
    broadcast();
    ok('Welcome, ' + name);
  });

  /* ---- Round-1 IPO buy at issue price ---- */
  socket.on('execBuy', ({ CU, SEL, qty }) => {
    const team = teams[CU];
    if (!team) return err('Team not found');
    if (!STOCKS.includes(SEL)) return err('Unknown stock');
    if (!gameState.gameStarted) return err('Game has not started');
    qty = parseInt(qty, 10);
    if (!Number.isFinite(qty) || qty <= 0) return err('Invalid quantity');

    const price = PRICES[SEL][0];           // fixed IPO price
    const cost  = qty * price;
    if (team.cash < cost) return err('Insufficient funds');

    team.cash -= cost;
    updateAvgBuy(team, SEL, qty, price);
    team.holdings[SEL] = (team.holdings[SEL] || 0) + qty;
    broadcast();
    ok(`Bought ${qty} ${SEL} @ ₹${price}`);
  });

  /* ---- Post a sell order to the board (shares escrowed) ---- */
  socket.on('execSell', ({ CU, SEL, qty, price }) => {
    const team = teams[CU];
    if (!team) return err('Team not found');
    if (!STOCKS.includes(SEL)) return err('Unknown stock');
    qty = parseInt(qty, 10);
    price = Math.round(parseFloat(price));
    if (!Number.isFinite(qty) || qty <= 0) return err('Invalid quantity');
    if (!Number.isFinite(price) || price <= 0) return err('Invalid asking price');
    if ((team.holdings[SEL] || 0) < qty) return err('Not enough shares');

    team.holdings[SEL] -= qty;              // escrow into the order
    gameState.oid += 1;
    orders.push({ id: gameState.oid, stock: SEL, seller: CU, qty, price });
    broadcast();
    ok(`Sell order posted: ${qty} ${SEL} @ ₹${price}`);
  });

  /* ---- Buy from another team's sell order ---- */
  socket.on('execOrdBuy', ({ CU, SEL, ordId, qty }) => {
    const buyer = teams[CU];
    if (!buyer) return err('Team not found');
    const order = orders.find(o => o.id === ordId);
    if (!order || order.qty <= 0) return err('Order no longer available');
    if (order.seller === CU) return err('Cannot buy your own order');
    qty = parseInt(qty, 10);
    if (!Number.isFinite(qty) || qty <= 0) return err('Invalid quantity');
    if (qty > order.qty) return err('Not enough shares in that order');

    const seller = teams[order.seller];
    const cost = qty * order.price;
    if (buyer.cash < cost) return err('Insufficient funds');

    // Buyer pays, receives shares.
    buyer.cash -= cost;
    updateAvgBuy(buyer, order.stock, qty, order.price);
    buyer.holdings[order.stock] = (buyer.holdings[order.stock] || 0) + qty;
    // Seller receives cash (shares were already escrowed out on order post).
    if (seller) seller.cash += cost;
    // Reduce / clear the order.
    order.qty -= qty;
    if (order.qty <= 0) orders = orders.filter(o => o.id !== order.id);

    broadcast();
    ok(`Bought ${qty} ${order.stock} @ ₹${order.price}`);
  });

  /* ---- Cancel your own order (returns escrowed shares) ---- */
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
      case 'addTeam': {
        const name = (payload || '').toString().trim();
        if (!name) return err('Enter a team name');
        if (teams[name]) return err('Team already exists');
        ensureTeam(name);
        ok('Team added: ' + name);
        break;
      }
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
        } else {
          err('Already at final round');
        }
        break;
      case 'endRoundNow':
        gameState.roundStart = Date.now() - ROUND_DUR;   // time is up
        ok('Round ended');
        break;
      case 'fastForward':
        if (gameState.roundStart) gameState.roundStart -= 60 * 1000; // +1 min elapsed
        ok('Fast-forwarded 1 min');
        break;
      case 'fastForwardTo': {
        const mins = parseFloat(payload) || 0;
        gameState.roundStart = Date.now() - mins * 60 * 1000;
        ok(`Jumped to ${mins} min into the round`);
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
