require("dotenv").config();
const express = require("express");
const cookieSession = require("cookie-session");
const helmet = require("helmet");
const { createClient } = require("@libsql/client");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;

/* ------------------------------------------------------------------
   BASE DE DONNÉES
   - En ligne (Render gratuit) : variables TURSO_DATABASE_URL + TURSO_AUTH_TOKEN
     -> base Turso gratuite, les données sont conservées en permanence.
   - En local (sur ton ordinateur) : fichier data/spinwin.sqlite automatiquement.
------------------------------------------------------------------- */
let dbConfig;
if (process.env.TURSO_DATABASE_URL) {
  dbConfig = { url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN };
} else {
  const dataDir = path.join(__dirname, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  dbConfig = { url: "file:" + path.join(dataDir, "spinwin.sqlite") };
  console.log("Base locale utilisée (data/spinwin.sqlite). En ligne, configure TURSO_DATABASE_URL.");
}
const db = createClient(dbConfig);

// Helpers : renvoient des objets simples
async function all(sql, args = []) {
  const r = await db.execute({ sql, args });
  return r.rows.map(row => Object.fromEntries(r.columns.map((c, i) => [c, row[i]])));
}
async function one(sql, args = []) { return (await all(sql, args))[0] || null; }
async function run(sql, args = []) { return db.execute({ sql, args }); }

async function initDb() {
  await db.executeMultiple(`
    CREATE TABLE IF NOT EXISTS participants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT,
      whatsapp TEXT NOT NULL UNIQUE,
      attempts INTEGER NOT NULL DEFAULT 0,
      won INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS prizes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      participant_id INTEGER NOT NULL,
      prize TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(participant_id) REFERENCES participants(id)
    );
  `);
}

/* ------------------------------------------------------------------
   SERVEUR
------------------------------------------------------------------- */
// Derrière le proxy HTTPS de l'hébergeur (Render, etc.)
app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "20kb" }));

if (!process.env.SESSION_SECRET) console.warn("⚠ SESSION_SECRET non défini : définis-le avant la mise en ligne.");
// Session stockée dans un cookie signé : survit aux redémarrages / mises en veille du serveur gratuit.
app.use(cookieSession({
  name: "spinwin",
  keys: [process.env.SESSION_SECRET || "change-this-secret-before-production"],
  httpOnly: true,
  sameSite: "lax",
  maxAge: 30 * 86400000
}));

// no-cache : le navigateur récupère toujours la dernière version de la page après une mise à jour
app.use(express.static(path.join(__dirname, "public"), {
  setHeaders: res => res.setHeader("Cache-Control", "no-cache")
}));

// Pour le service de surveillance qui garde le site éveillé
app.get("/health", (req, res) => res.type("text").send("ok"));

const PRIZES = [
  { name: "Réduction 5 %", weight: 5 },
  { name: "Réduction 10 %", weight: 3 },
  { name: "Réduction 15 %", weight: 2 },
  { name: "Réduction 20 %", weight: 1 },
  { name: "Réduction 25 %", weight: 0.5 },
  { name: "Écouteurs Bluetooth TECNO", weight: 0.5 },
  { name: "Tentez à nouveau", weight: 88 }
];
const MAX_ATTEMPTS = 3;
const totalWeight = PRIZES.reduce((s, p) => s + p.weight, 0);
function drawPrize() {
  let n = crypto.randomInt(0, 1000000) / 1000000 * totalWeight;
  for (const p of PRIZES) { n -= p.weight; if (n < 0) return p.name; }
  return "Tentez à nouveau";
}

// Transmet les erreurs des routes async à un gestionnaire commun
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function requireAuth(req, res, next) {
  if (!req.session.participantId) return res.status(401).json({ error: "Veuillez vous inscrire avant de jouer." });
  next();
}
function requireAdmin(req, res, next) {
  if (!req.session.isAdmin) return res.status(401).json({ error: "Accès administrateur refusé." });
  next();
}
// Normalise vers le format international (+241XXXXXXXX) pour éviter les doublons
function normalizePhone(value) {
  let v = String(value || "").replace(/[^\d+]/g, "");
  if (v.startsWith("00")) v = "+" + v.slice(2);
  if (!v.startsWith("+")) {
    if (/^241\d{8,9}$/.test(v)) v = "+" + v;
    else if (/^\d{8,9}$/.test(v)) v = "+241" + v;
  }
  return v;
}
function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
const getPrize = id => one("SELECT prize, code, status FROM prizes WHERE participant_id=?", [id]);
const remainingOf = p => (p.won ? 0 : Math.max(0, MAX_ATTEMPTS - p.attempts));

// Inscription simple : aucun compte Facebook ni application Meta nécessaire.
app.post("/api/register", wrap(async (req, res) => {
  const name = String(req.body.name || "").trim().replace(/\s+/g, " ");
  const whatsapp = normalizePhone(req.body.whatsapp);
  if (name.length < 2 || name.length > 70) return res.status(400).json({ error: "Saisissez un nom valide (2 à 70 caractères)." });
  if (!/^\+?[0-9]{8,15}$/.test(whatsapp)) return res.status(400).json({ error: "Saisissez un numéro WhatsApp valide avec l'indicatif du pays (+241)." });

  let p = await one("SELECT * FROM participants WHERE whatsapp=?", [whatsapp]);
  if (!p) {
    try { await run("INSERT INTO participants (name, whatsapp) VALUES (?, ?)", [name, whatsapp]); }
    catch (e) { /* inscrit entre-temps par une autre requête : on le relit ci-dessous */ }
    p = await one("SELECT * FROM participants WHERE whatsapp=?", [whatsapp]);
  } else {
    await run("UPDATE participants SET name=? WHERE id=?", [name, p.id]);
    p.name = name;
  }
  if (!p) return res.status(500).json({ error: "Inscription impossible pour le moment. Réessayez." });

  req.session.participantId = p.id;
  res.json({
    ok: true,
    participant: { id: p.id, name: p.name, whatsapp: p.whatsapp, attempts: p.attempts, won: p.won },
    remaining: remainingOf(p),
    prize: await getPrize(p.id)
  });
}));

// Permet de changer de participant sur le même appareil (tests, téléphone partagé)
app.post("/api/logout", (req, res) => { req.session = null; res.json({ ok: true }); });

app.get("/api/me", wrap(async (req, res) => {
  if (!req.session.participantId) return res.json({ connected: false });
  const p = await one("SELECT id,name,whatsapp,attempts,won FROM participants WHERE id=?", [req.session.participantId]);
  if (!p) { req.session = null; return res.json({ connected: false }); }
  res.json({ connected: true, participant: p, remaining: remainingOf(p), prize: await getPrize(p.id) });
}));

app.post("/api/spin", requireAuth, wrap(async (req, res) => {
  const p = await one("SELECT * FROM participants WHERE id=?", [req.session.participantId]);
  if (!p) return res.status(401).json({ error: "Session expirée. Veuillez vous réinscrire." });
  if (p.won) return res.status(403).json({ error: "Vous avez déjà gagné. Votre participation est terminée." });
  if (p.attempts >= MAX_ATTEMPTS) return res.status(403).json({ error: "Vos trois essais sont épuisés." });

  const prize = drawPrize();
  const won = prize !== "Tentez à nouveau";
  const code = won ? "TECNO-" + crypto.randomBytes(4).toString("hex").toUpperCase() : null;

  // La mise à jour est conditionnelle : impossible de dépasser 3 essais, même avec des clics simultanés.
  const upd = await run(
    "UPDATE participants SET attempts=attempts+1, won=? WHERE id=? AND won=0 AND attempts<?",
    [won ? 1 : 0, p.id, MAX_ATTEMPTS]
  );
  if (!upd.rowsAffected) return res.status(403).json({ error: "Vos essais sont épuisés ou vous avez déjà gagné." });
  if (won) await run("INSERT INTO prizes (code,participant_id,prize) VALUES (?,?,?)", [code, p.id, prize]);

  const fresh = await one("SELECT attempts,won FROM participants WHERE id=?", [p.id]);
  res.json({
    prize, index: PRIZES.findIndex(x => x.name === prize), won, code,
    attempts: fresh.attempts, remaining: remainingOf(fresh)
  });
}));

/* ---------------- Administration ---------------- */
app.post("/admin/login", (req, res) => {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected || !safeEqual(req.body.password || "", expected)) return res.status(401).json({ error: "Mot de passe incorrect." });
  req.session.isAdmin = true;
  res.json({ ok: true });
});
app.get("/admin", (req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));

app.get("/api/admin/stats", requireAdmin, wrap(async (req, res) => {
  const participants = (await one("SELECT COUNT(*) AS n FROM participants")).n;
  const winners = (await one("SELECT COUNT(*) AS n FROM participants WHERE won=1")).n;
  const prizes = (await one("SELECT COUNT(*) AS n FROM prizes")).n;
  const rows = await all(`SELECT p.id,p.name,p.whatsapp,p.attempts,p.won,p.created_at,
    r.prize,r.code,r.status FROM participants p LEFT JOIN prizes r ON r.participant_id=p.id ORDER BY p.id DESC`);
  res.json({ participants, winners, prizes, rows });
}));

app.post("/api/admin/prize-status", requireAdmin, wrap(async (req, res) => {
  const { code, status } = req.body;
  if (!["pending", "validated", "collected"].includes(status)) return res.status(400).json({ error: "Statut invalide." });
  const r = await run("UPDATE prizes SET status=? WHERE code=?", [status, code]);
  res.json({ ok: r.rowsAffected > 0 });
}));

app.get("/api/admin/export.csv", requireAdmin, wrap(async (req, res) => {
  const rows = await all(`SELECT p.name,p.whatsapp,p.attempts,p.won,r.prize,r.code,r.status,p.created_at
    FROM participants p LEFT JOIN prizes r ON r.participant_id=p.id ORDER BY p.id DESC`);
  // Nom et lot : les cellules commençant par = + - @ sont neutralisées (protection contre les formules Excel).
  const q = s => '"' + String(s).replace(/"/g, '""') + '"';
  const text = v => { const s = String(v ?? ""); return q(/^[=+\-@]/.test(s) ? "'" + s : s); };
  const plain = v => q(v ?? "");
  const csv = ["Nom,WhatsApp,Essais,Gain,Lot,Code,Statut,Date",
    ...rows.map(r => [text(r.name), plain(r.whatsapp), plain(r.attempts), plain(r.won ? "Oui" : "Non"), text(r.prize), plain(r.code), plain(r.status), plain(r.created_at)].join(","))].join("\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="tecno-spin-win.csv"');
  res.send("﻿" + csv);
}));

// Gestionnaire d'erreurs : le joueur voit un message clair au lieu d'un écran vide
app.use((err, req, res, next) => {
  console.error("Erreur serveur :", err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: "Le serveur a rencontré un problème. Réessayez dans un instant." });
});

initDb()
  .then(() => app.listen(PORT, () => console.log(`TECNO SPIN & WIN disponible sur le port ${PORT}`)))
  .catch(e => { console.error("Impossible d'initialiser la base de données :", e.message); process.exit(1); });
