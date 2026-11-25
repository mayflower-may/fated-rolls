// ============================================================
// Fated Rolls
// Lets a GM decide the next d20 roll(s) of one or more users.
//
// Security model:
//  - Only GM clients get the panel and the API functions.
//  - Queued values live in module scope (not on globalThis), so they cannot be changed from the console.
//  - Socket messages that change a queue are ignored unless the server-stamped sender is a GM.
//  - A queue is sent only to its target user; "used" notices go only to GMs.
// ============================================================

const MODULE_ID = "fated-rolls";
const SOCKET = `module.${MODULE_ID}`;

const t = (key, data) => data
  ? game.i18n.format(`FATED.${key}`, data)
  : game.i18n.localize(`FATED.${key}`);

const escapeHtml = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
  .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const isGMUser = (userId) => !!game.users.get(userId)?.isGM;
const activeGMIds = () => game.users.filter(u => u.isGM && u.active).map(u => u.id);
const clamp20 = (v) => Math.min(20, Math.max(1, Math.round(Number(v))));
const isDnd5e = () => game.system.id === "dnd5e";

/** Send a socket message to the given users only (the sender never receives its own message). */
function emit(data, recipients) {
  if (Array.isArray(recipients)) {
    if (!recipients.length) return;
    game.socket.emit(SOCKET, data, { recipients });
  } else {
    game.socket.emit(SOCKET, data);
  }
}
const emitToOtherGMs = (data) => emit(data, activeGMIds().filter(id => id !== game.user.id));

// --- Queues on this client --------------------------------------
let d20Queue = [];      // next d20 values for this client
let damageQueue = [];   // next damage rolls: { type: "max" | "min" | "total", value }
let deathQueue = [];    // next death saving throws (dnd5e)
let inDeathSave = 0;

/** Turn a value (or list of values) into a valid queue. */
function makeQueue(value, count = 1) {
  if (Array.isArray(value)) return value.map(Number).filter(Number.isFinite).map(clamp20);
  if (value == null || !Number.isFinite(Number(value))) return [];
  return Array.from({ length: Math.max(1, Math.min(10, Math.round(count) || 1)) }, () => clamp20(value));
}

function makeDamageQueue(list) {
  return (Array.isArray(list) ? list : []).slice(0, 10).map(a => ({
    type: ["max", "min", "total"].includes(a?.type) ? a.type : "max",
    value: Math.max(0, Math.min(999, Math.round(Number(a?.value) || 0)))
  }));
}

const damageLabel = (a) => a.type === "max" ? t("Damage.Max") : a.type === "min" ? t("Damage.Min") : t("Damage.TotalOf", { value: a.value });

// --- Changing a d20 ----------------------------------------------
/** Set the first d20 term of a roll to the value. Returns false if the roll has no d20. */
function applyD20(roll, value) {
  for (const term of roll.terms ?? []) {
    if (term?.faces !== 20 || !Array.isArray(term.results) || !term.results.length) continue;
    const kept = term.results.filter(r => r.active !== false && !r.discarded);
    if (!kept.length) continue;
    for (const r of kept) r.result = value;   // with advantage only the KEPT die changes

    // Advantage / disadvantage: the dropped die must not contradict the kept one,
    // otherwise the chat card and Dice So Nice show e.g. "kept 3, dropped 8" with advantage.
    const mods = (term.modifiers ?? []).join(" ");
    const keepsHigh = /\b(kh|dl)/i.test(mods), keepsLow = /\b(kl|dh)/i.test(mods);
    for (const r of term.results) {
      if (kept.includes(r) || r.rerolled) continue;   // leave the old face of a rerolled die (e.g. Lucky) alone
      if (keepsHigh && r.result > value) r.result = 1 + Math.floor(Math.random() * value);
      else if (keepsLow && r.result < value) r.result = value + Math.floor(Math.random() * (21 - value));
    }
    return true;
  }
  return false;
}

function recomputeTotal(roll) {
  try { roll._total = roll._evaluateTotal(); }
  catch { try { roll._total = Roll.safeEval(roll.result); } catch (err) { console.warn(`${MODULE_ID} | total:`, err); } }
}

function tryDeathSave(roll) {
  const v = deathQueue[0];
  if (!applyD20(roll, v)) return false;
  deathQueue.shift();
  recomputeTotal(roll);
  if (game.user.isGM) onDeathUsed(game.user.id, v, deathQueue.length);
  emitToOtherGMs({ deathUsed: true, value: v, left: deathQueue.length });
  return true;
}

// --- Queues for actors without a player (NPC tokens) --------------------------
// Kept on the GM client that set them, and used when that GM rolls a d20 for the actor.
const actorQueues = new Map();   // actor uuid -> { queue: number[], name, img }

/** The actor a roll was made for, if it is one of the queued actors. */
function queuedActorFor(roll) {
  const data = roll?.data;
  if (!data || !actorQueues.size) return null;
  let byName = null;
  for (const uuid of actorQueues.keys()) {
    const actor = fromUuidSync(uuid);
    if (!actor) continue;
    // dnd5e puts the actor's own flags object into its roll data: an exact match
    if (data.flags && data.flags === actor.flags) return uuid;
    if (!byName && data.name && data.name === actor.name) byName = uuid;
  }
  return byName;
}

function tryActorQueue(roll) {
  const uuid = queuedActorFor(roll);
  if (!uuid) return false;
  const entry = actorQueues.get(uuid);
  const v = entry.queue[0];
  if (!applyD20(roll, v)) return false;
  entry.queue.shift();
  if (!entry.queue.length) actorQueues.delete(uuid);
  recomputeTotal(roll);
  addHistory(null, t("History.ActorUsed", { name: escapeHtml(entry.name), value: v }), "used");
  ui.notifications.info(t("Notify.ActorUsed", { name: entry.name, value: v }));
  logToChat(t("Log.ActorUsed", { name: escapeHtml(entry.name), value: v }), { onlyActiveGM: false });
  refreshPanel();
  return true;
}

function setNextD20ForActor(actor, values) {
  if (!game.user.isGM || !actor) return;
  const queue = makeQueue(values);
  if (!queue.length) return;
  actorQueues.set(actor.uuid, { queue, name: actor.name, img: actor.img });
  addHistory(null, t("History.ActorSet", { name: escapeHtml(actor.name), values: queue.join(", ") }), "set");
  record(t("Log.ActorSet", { name: escapeHtml(actor.name), values: queue.join(", ") }));
  refreshPanel();
}

/** Players who own a token's actor (active, not GMs). */
const playerOwners = (actor) => game.users.filter(u => !u.isGM && u.active && actor?.testUserPermission(u, "OWNER"));

function maybeOverride(roll) {
  if (game.user.isGM && tryActorQueue(roll)) return;
  if (inDeathSave && deathQueue.length && tryDeathSave(roll)) return;
  if (!d20Queue.length) return;
  const v = d20Queue[0];
  if (!applyD20(roll, v)) return;   // no d20 in this roll: the queue is not used up
  d20Queue.shift();
  recomputeTotal(roll);
  if (game.user.isGM) onD20Used(game.user.id, v, d20Queue.length);
  emitToOtherGMs({ d20Used: true, value: v, left: d20Queue.length });
}

// --- Damage (dnd5e DamageRoll) ------------------------------------
// One attack's damage parts (e.g. 1d8+3 slashing + 1d6 fire) count as one damage roll.
// "total" brings the sum of all parts to the value; dice are spread randomly so they look natural.
function activeDice(rolls) {
  const out = [];
  for (const r of rolls) for (const term of r.terms ?? []) {
    if (!(term instanceof foundry.dice.terms.Die) || !Array.isArray(term.results) || !(term.faces > 1)) continue;
    for (const res of term.results) if (res.active !== false && !res.discarded) out.push({ res, faces: term.faces });
  }
  return out;
}

function applyDamage(rolls) {
  if (!damageQueue.length || !rolls?.length) return;
  const dice = activeDice(rolls);
  if (!dice.length) return;   // flat damage: the queue is not used up
  const a = damageQueue.shift();
  if (a.type === "max") dice.forEach(x => { x.res.result = x.faces; });
  else if (a.type === "min") dice.forEach(x => { x.res.result = 1; });
  else {
    const total = rolls.reduce((s, r) => s + (Number(r.total) || 0), 0);
    const diceSum = dice.reduce((s, x) => s + x.res.result, 0);
    const lowest = dice.length, highest = dice.reduce((s, x) => s + x.faces, 0);
    let rest = Math.max(lowest, Math.min(highest, a.value - (total - diceSum))) - lowest;
    dice.forEach(x => { x.res.result = 1; });
    while (rest > 0) {
      const open = dice.filter(x => x.res.result < x.faces);
      if (!open.length) break;
      open[Math.floor(Math.random() * open.length)].res.result++; rest--;
    }
  }
  rolls.forEach(recomputeTotal);
  const result = rolls.reduce((s, r) => s + (Number(r.total) || 0), 0);
  if (game.user.isGM) onDamageUsed(game.user.id, a, result, damageQueue.length);
  emitToOtherGMs({ damageUsed: true, setting: a, result, left: damageQueue.length });
}

const damageSupported = () => typeof CONFIG.Dice?.DamageRoll?.buildEvaluate === "function";

// --- Wrappers --------------------------------------------------------
function registerWrappers() {
  libWrapper.register(MODULE_ID, "Roll.prototype.evaluate", async function (wrapped, ...args) {
    const out = await wrapped(...args);
    maybeOverride(out);
    return out;
  }, "WRAPPER");

  libWrapper.register(MODULE_ID, "Roll.prototype.evaluateSync", function (wrapped, ...args) {
    const out = wrapped(...args);
    maybeOverride(out);
    return out;
  }, "WRAPPER");

  // buildEvaluate is a static method that DamageRoll inherits from BasicRoll (dnd5e). Give DamageRoll its own
  // copy so only damage rolls are affected.
  const DamageRoll = CONFIG.Dice?.DamageRoll;
  if (damageSupported() && !DamageRoll._fatedRolls) {
    const original = DamageRoll.buildEvaluate;
    DamageRoll.buildEvaluate = async function (rolls, config = {}, message = {}) {
      const out = await original.call(this, rolls, config, message);
      if (config?.evaluate !== false) {
        try { applyDamage(rolls); } catch (err) { console.warn(`${MODULE_ID} | damage:`, err); }
      }
      return out;
    };
    DamageRoll._fatedRolls = true;
  }

  if (isDnd5e()) {
    libWrapper.register(MODULE_ID, "CONFIG.Actor.documentClass.prototype.rollDeathSave", async function (wrapped, ...args) {
      inDeathSave++;
      try { return await wrapped(...args); } finally { inDeathSave--; }
    }, "WRAPPER");
  }
}

// --- GM side tracking (this session) ---------------------------------
const tracked = new Map();        // userId -> { queue: number[], state: "waiting" | "ready" }
const damageTracked = new Map();  // userId -> { queue: [{type, value}], state }
const deathTracked = new Map();   // userId -> { queue: number[], state }
const history = [];               // { time, who, text, kind }

let panel = null;
const refreshPanel = () => { if (panel?.rendered) panel.render(); };

function addHistory(who, text, kind) {
  history.unshift({ time: Date.now(), who, text, kind });
  history.length = Math.min(history.length, 12);
}

const userName = (id) => game.users.get(id)?.name ?? "?";
const targetName = (id) => id === "all" ? t("Target.Everyone") : id === game.user.id ? t("Target.Self") : userName(id);

/**
 * Optional GM-only chat record (setting "Log to chat").
 * "Used" notices reach every GM, so only the active GM writes them; a GM's own changes are written by that GM.
 */
async function logToChat(text, { onlyActiveGM = true } = {}) {
  if (!game.settings.get(MODULE_ID, "logToChat")) return;
  if (onlyActiveGM && game.users.activeGM?.id !== game.user.id) return;
  await ChatMessage.create({
    content: `<p><i class="fa-solid fa-dice-d20"></i> ${text}</p>`,
    whisper: game.users.filter(u => u.isGM).map(u => u.id),
    speaker: { alias: t("Title") }
  });
}

/** This GM set or cancelled something. */
const record = (text) => logToChat(text, { onlyActiveGM: false });

function shiftTracked(map, userId, left) {
  const entry = map.get(userId);
  if (entry) { entry.queue.shift(); if (!left || !entry.queue.length) map.delete(userId); }
}

function onD20Used(userId, value, left) {
  shiftTracked(tracked, userId, left);
  if (panicPending) endPanic(userId);
  addHistory(userId, t("History.D20Used", { value, left: left ? t("History.Left", { left }) : "" }), "used");
  ui.notifications.info(t("Notify.D20Used", { name: userName(userId), value, left: left ? t("History.Left", { left }) : "" }));
  logToChat(t("Log.D20Used", { name: escapeHtml(userName(userId)), value }));
  refreshPanel();
}

// --- Mercy mode -------------------------------------------------------------
// After a streak of low natural d20s, a player's next d20 is quietly raised. Run by the active GM only.
const lowStreaks = new Map();   // userId -> number of low d20s in a row

function mercyCheck(message) {
  if (!game.settings.get(MODULE_ID, "mercyEnabled")) return;
  if (game.users.activeGM?.id !== game.user.id) return;
  const user = message.author;
  if (!user || user.isGM) return;
  const below = game.settings.get(MODULE_ID, "mercyThreshold");
  const needed = game.settings.get(MODULE_ID, "mercyStreak");
  for (const roll of message.rolls ?? []) for (const die of roll.dice ?? []) {
    if (die.faces !== 20) continue;
    for (const res of die.results ?? []) {
      if (res.active === false || res.discarded) continue;
      const streak = res.result < below ? (lowStreaks.get(user.id) ?? 0) + 1 : 0;
      lowStreaks.set(user.id, streak);
      if (streak < needed) continue;
      lowStreaks.set(user.id, 0);
      if (tracked.has(user.id) || !user.active) continue;   // something is already queued for them
      const lo = Math.min(game.settings.get(MODULE_ID, "mercyMin"), game.settings.get(MODULE_ID, "mercyMax"));
      const hi = Math.max(game.settings.get(MODULE_ID, "mercyMin"), game.settings.get(MODULE_ID, "mercyMax"));
      const v = lo + Math.floor(Math.random() * (hi - lo + 1));
      setNextD20([v], user.id);
      ui.notifications.info(t("Notify.Mercy", { name: user.name, count: streak, value: v }));
    }
  }
}

// --- Panic Roll -------------------------------------------------------------
// One click: the next single d20 becomes the chosen value. With "Everyone" only the FIRST d20 rolled by anyone
// is changed; once someone uses it, the others' panic value is withdrawn.
let panicPending = null;   // Set of user ids still holding the panic value, or null

const panicSettings = () => ({ value: 20, target: "all", ...(game.settings.get(MODULE_ID, "panic") ?? {}) });

function panicRoll() {
  if (!game.user.isGM) return;
  const { value, target } = panicSettings();
  if (target !== "self" && target !== "all" && !game.users.get(target)?.active) {
    return ui.notifications.warn(t("Notify.NotConnected", { name: userName(target) }));
  }
  setNextD20([value], target);
  panicPending = target === "all"
    ? new Set(game.users.filter(u => u.active).map(u => u.id))
    : null;
  ui.notifications.info(t("Panic.Armed", { value, target: targetName(target === "self" ? game.user.id : target) }));
}

/** Someone used the panic value: take it back from everyone else. */
function endPanic(usedBy) {
  const others = [...panicPending].filter(id => id !== usedBy);
  panicPending = null;
  for (const id of others) {
    if (id === game.user.id) d20Queue = [];
    else emit({ d20: null, targetUserId: id }, [id]);
    tracked.delete(id);
  }
  refreshPanel();
}

function onDamageUsed(userId, a, result, left) {
  shiftTracked(damageTracked, userId, left);
  addHistory(userId, t("History.DamageUsed", { kind: damageLabel(a), value: result, left: left ? t("History.Left", { left }) : "" }), "used");
  ui.notifications.info(t("Notify.DamageUsed", { name: userName(userId), kind: damageLabel(a), value: result }));
  logToChat(t("Log.DamageUsed", { name: escapeHtml(userName(userId)), kind: damageLabel(a), value: result }));
  refreshPanel();
}

function onDeathUsed(userId, value, left) {
  shiftTracked(deathTracked, userId, left);
  addHistory(userId, t("History.DeathUsed", { value, left: left ? t("History.Left", { left }) : "" }), "used");
  ui.notifications.info(t("Notify.DeathUsed", { name: userName(userId), value }));
  logToChat(t("Log.DeathUsed", { name: escapeHtml(userName(userId)), value }));
  refreshPanel();
}

// --- Socket ------------------------------------------------------------
function onSocket(d, senderId) {
  if (!d) return;

  // Notices to GMs: a target used a value / confirmed it received the queue
  if (d.d20Used) { if (game.user.isGM) onD20Used(senderId, clamp20(d.value), Number(d.left) || 0); return; }
  if (d.damageUsed) { if (game.user.isGM) onDamageUsed(senderId, makeDamageQueue([d.setting])[0], Number(d.result) || 0, Number(d.left) || 0); return; }
  if (d.deathUsed) { if (game.user.isGM) onDeathUsed(senderId, clamp20(d.value), Number(d.left) || 0); return; }
  if (d.ack) {
    if (!game.user.isGM || d.toUserId !== game.user.id) return;
    const map = d.ack === "damage" ? damageTracked : d.ack === "death" ? deathTracked : tracked;
    const entry = map.get(senderId);
    if (!d.count) map.delete(senderId);
    else if (entry) entry.state = "ready";
    if (d.ack === "d20" && d.count) ui.notifications.info(t("Notify.Ready", { name: userName(senderId), value: d.first }));
    refreshPanel();
    return;
  }

  // A user (re)loaded the page and lost their queues: send back what this GM has queued for them
  if (d.resync) {
    if (game.user.isGM) resendQueues(senderId);
    return;
  }

  // Setting a queue: only a GM may do this, and only for this user
  if (!("d20" in d || "damage" in d || "death" in d)) return;
  if (!isGMUser(senderId)) {
    console.warn(`${MODULE_ID} | Ignored a roll setting from a non-GM user: ${userName(senderId)}`);
    return;
  }
  if (d.targetUserId && d.targetUserId !== game.user.id) return;

  if ("d20" in d) {
    d20Queue = Array.isArray(d.d20) ? makeQueue(d.d20) : [];
    emit({ ack: "d20", toUserId: senderId, count: d20Queue.length, first: d20Queue[0] ?? null }, [senderId]);
  }
  if ("damage" in d) {
    damageQueue = makeDamageQueue(d.damage);
    emit({ ack: "damage", toUserId: senderId, count: damageQueue.length }, [senderId]);
  }
  if ("death" in d) {
    deathQueue = Array.isArray(d.death) ? makeQueue(d.death).slice(0, 10) : [];
    emit({ ack: "death", toUserId: senderId, count: deathQueue.length }, [senderId]);
  }
}

/** Send a user the queues this GM is still tracking for them (after they reloaded). */
function resendQueues(userId) {
  const message = { targetUserId: userId };
  const d20 = tracked.get(userId), damage = damageTracked.get(userId), death = deathTracked.get(userId);
  if (d20?.queue.length) { message.d20 = [...d20.queue]; d20.state = "waiting"; }
  if (damage?.queue.length) { message.damage = structuredClone(damage.queue); damage.state = "waiting"; }
  if (death?.queue.length) { message.death = [...death.queue]; death.state = "waiting"; }
  if (Object.keys(message).length === 1) return;
  emit(message, [userId]);
  refreshPanel();
}

// --- GM API -------------------------------------------------------------
/**
 * Send a queue to a target. "self" sets it locally; "all" sends it to every other connected user and to self.
 * @returns {string} the resolved target id
 */
function arm(kind, queue, target, map, setLocal) {
  const myId = game.user.id;
  const resolved = target === "self" ? myId : target;
  if (resolved === myId || resolved === "all") {
    setLocal();
    map.set(myId, { queue: structuredClone(queue), state: "ready" });
  }
  if (resolved !== myId) {
    const recipients = resolved === "all"
      ? game.users.filter(u => u.active && u.id !== myId).map(u => u.id)
      : [resolved];
    for (const id of recipients) map.set(id, { queue: structuredClone(queue), state: "waiting" });
    emit({ [kind]: queue, targetUserId: resolved === "all" ? null : resolved }, recipients);
  }
  refreshPanel();
  return resolved;
}

/**
 * Set the next d20 value(s).
 * @param {number|number[]} value      A value (1-20), or values used in order
 * @param {string} [target="self"]     "self", "all" or a user id
 * @param {object} [options]
 * @param {number} [options.count=1]   How many d20 rolls a single value applies to
 */
function setNextD20(value, target = "self", { count = 1 } = {}) {
  if (!game.user.isGM) return;
  const values = makeQueue(value, count);
  if (!values.length) return;
  const resolved = arm("d20", values, target, tracked, () => { d20Queue = [...values]; });
  addHistory(resolved, t("History.Set", { values: values.join(", ") }), "set");
  record(t("Log.Set", { target: escapeHtml(targetName(resolved)), values: values.join(", ") }));
}

/** Set the next damage roll(s). list: [{ type: "max" | "min" | "total", value }] */
function setNextDamage(list, target = "self") {
  if (!game.user.isGM || !damageSupported()) return;
  const queue = makeDamageQueue(list);
  if (!queue.length) return;
  const resolved = arm("damage", queue, target, damageTracked, () => { damageQueue = structuredClone(queue); });
  addHistory(resolved, t("History.DamageSet", { values: queue.map(damageLabel).join(", ") }), "set");
  record(t("Log.DamageSet", { target: escapeHtml(targetName(resolved)), values: queue.map(damageLabel).join(", ") }));
}

/** Set the next death saving throw(s) (dnd5e). */
function setNextDeathSave(values, target = "self") {
  if (!game.user.isGM || !isDnd5e()) return;
  const queue = makeQueue(values).slice(0, 10);
  if (!queue.length) return;
  const resolved = arm("death", queue, target, deathTracked, () => { deathQueue = [...queue]; });
  addHistory(resolved, t("History.DeathSet", { values: queue.join(", ") }), "set");
  record(t("Log.DeathSet", { target: escapeHtml(targetName(resolved)), values: queue.join(", ") }));
}

/** Cancel every queued value for a target ("all" by default). */
function cancel(target = "all") {
  if (!game.user.isGM) return;
  const myId = game.user.id;
  const resolved = target === "self" ? myId : target;
  if (resolved === "all" || resolved === myId) { d20Queue = []; damageQueue = []; deathQueue = []; }
  if (resolved === "all") panicPending = null;
  else panicPending?.delete(resolved);
  const clearMessage = { d20: null, damage: null, death: null };
  if (resolved === "all") {
    tracked.clear(); damageTracked.clear(); deathTracked.clear(); actorQueues.clear();
    emit({ ...clearMessage, targetUserId: null }, game.users.filter(u => u.active && u.id !== myId).map(u => u.id));
  } else {
    tracked.delete(resolved); damageTracked.delete(resolved); deathTracked.delete(resolved);
    if (resolved !== myId) emit({ ...clearMessage, targetUserId: resolved }, [resolved]);
  }
  addHistory(resolved, t("History.Cancelled"), "cancel");
  record(t("Log.Cancelled", { target: escapeHtml(targetName(resolved)) }));
  refreshPanel();
}

// --- Luck statistics: the last d20s of each player in the chat log ---
function luckStats() {
  const byUser = new Map();
  const messages = game.messages.contents;
  for (let i = messages.length - 1, seen = 0; i >= 0 && seen < 4000; i--, seen++) {
    const msg = messages[i], u = msg.author;
    if (!u || u.isGM) continue;
    const list = byUser.get(u.id) ?? [];
    if (list.length >= 20) continue;
    for (const r of msg.rolls ?? []) for (const die of r.dice ?? []) {
      if (die.faces !== 20) continue;
      for (const res of die.results ?? []) if (res.active !== false && !res.discarded && list.length < 20) list.push(res.result);
    }
    byUser.set(u.id, list);
  }
  return [...byUser.entries()].filter(([, d]) => d.length)
    .map(([id, d]) => ({ u: game.users.get(id), d, avg: d.reduce((a, b) => a + b, 0) / d.length }))
    .filter(x => x.u)
    .sort((a, b) => Number(b.u.active) - Number(a.u.active) || a.avg - b.avg);
}

// --- Panel --------------------------------------------------------------
const avatar = (u) => u?.avatar || u?.character?.img || "icons/svg/mystery-man.svg";
const displayName = (u) => u?.character?.name || u?.name || "?";
const clock = (time) => new Date(time).toLocaleTimeString(game.i18n.lang, { hour: "2-digit", minute: "2-digit" });
const chipClass = (v) => v === 20 ? "crit" : v === 1 ? "fumble" : "";

const DEATH_MODES = {
  stand: { label: "Death.Stand", make: () => 20 },
  success: { label: "Death.Success", make: () => 10 + Math.floor(Math.random() * 10) },
  failure: { label: "Death.Failure", make: () => 2 + Math.floor(Math.random() * 8) },
  fumble: { label: "Death.Fumble", make: () => 1 }
};

class FatedRollsPanel extends foundry.applications.api.ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "fated-rolls-panel",
    classes: ["fated-rolls"],
    tag: "div",
    window: { title: "FATED.Title", icon: "fa-solid fa-dice-d20", resizable: true },
    position: { width: 520, height: "auto" }
  };

  // Keep the selections across re-renders
  state = { mode: "fixed", value: 20, min: 15, max: 19, count: 1, targets: new Set(["self"]),
    dType: "max", dValue: 10, dCount: 1, deathMode: "success", deathCount: 1, luckOpen: false };

  #panicSection(others) {
    const p = panicSettings();
    const option = (id, label) => `<option value="${id}" ${p.target === id ? "selected" : ""}>${escapeHtml(label)}</option>`;
    return `
      <section class="fr-block">
        <div class="fr-head"><span>${t("Panic.Title")}</span><span class="fr-hint">${t("Panic.Hint")}</span></div>
        <div class="fr-range">
          <label>${t("Panic.Value")} <input type="number" name="panicValue" min="1" max="20" value="${p.value}"></label>
          <label>${t("Target.Heading")}
            <select name="panicTarget">
              ${option("all", t("Panic.Everyone"))}
              ${option("self", t("Target.Self"))}
              ${others.map(u => option(u.id, displayName(u))).join("")}
            </select>
          </label>
        </div>
      </section>`;
  }

  #queueRow(id, entry, label, chips) {
    const u = game.users.get(id);
    const offline = u && !u.active ? ` <i class="fa-solid fa-plug-circle-xmark" data-tooltip="${t("Offline")}"></i>` : "";
    return `
      <li class="fr-row">
        <img src="${escapeHtml(avatar(u))}" alt="">
        <span class="fr-name">${escapeHtml(u?.name ?? "?")}${label ? ` <small>${label}</small>` : ""}${offline}</span>
        <span class="fr-chips">${chips}</span>
        <span class="fr-badge ${entry.state}">${entry.state === "ready" ? t("State.Ready") : t("State.Waiting")}</span>
        <button type="button" class="fr-cancel" data-cancel="${id}" data-tooltip="${t("Cancel")}"><i class="fa-solid fa-xmark"></i></button>
      </li>`;
  }

  async _renderHTML() {
    const s = this.state;
    const me = game.user;
    const others = game.users.filter(u => u.active && u.id !== me.id)
      .sort((a, b) => Number(b.isGM) - Number(a.isGM) || a.name.localeCompare(b.name, game.i18n.lang));

    const card = (id, name, sub, img, icon = null) => `
      <button type="button" class="fr-card ${s.targets.has(id) ? "selected" : ""}" data-target="${id}">
        ${icon ? `<span class="fr-icon"><i class="fa-solid ${icon}"></i></span>` : `<img src="${escapeHtml(img)}" alt="">`}
        <span class="fr-card-text"><b>${escapeHtml(name)}</b><small>${escapeHtml(sub)}</small></span>
      </button>`;

    const grid = Array.from({ length: 20 }, (_, i) => i + 1).map(n => `
      <button type="button" class="fr-number ${chipClass(n)} ${s.mode === "fixed" && s.value === n ? "selected" : ""}" data-value="${n}">${n}</button>`).join("");

    const d20Chips = (q) => q.map(v => `<span class="fr-chip ${chipClass(v)}">${v}</span>`).join("");
    const queued = [
      ...[...tracked.entries()].map(([id, e]) => this.#queueRow(id, e, "", d20Chips(e.queue))),
      ...[...damageTracked.entries()].map(([id, e]) => this.#queueRow(id, e, t("Damage.Short"),
        e.queue.map(a => `<span class="fr-chip">${a.type === "total" ? a.value : a.type}</span>`).join(""))),
      ...[...deathTracked.entries()].map(([id, e]) => this.#queueRow(id, e, t("Death.Short"), d20Chips(e.queue))),
      ...[...actorQueues.entries()].map(([uuid, e]) => `
        <li class="fr-row">
          <img src="${escapeHtml(e.img || "icons/svg/mystery-man.svg")}" alt="">
          <span class="fr-name">${escapeHtml(e.name)} <small>${t("Target.Npc")}</small></span>
          <span class="fr-chips">${d20Chips(e.queue)}</span>
          <span class="fr-badge ready">${t("State.Ready")}</span>
          <button type="button" class="fr-cancel" data-cancel-actor="${escapeHtml(uuid)}" data-tooltip="${t("Cancel")}"><i class="fa-solid fa-xmark"></i></button>
        </li>`)
    ].join("");

    const luck = s.luckOpen ? luckStats() : [];
    const colour = (avg) => avg < 8 ? "#d06a5a" : avg > 13 ? "#7fbf6a" : "inherit";
    const luckRows = luck.map(x => `
      <li class="fr-row">
        <img src="${escapeHtml(avatar(x.u))}" alt="">
        <span class="fr-name">${escapeHtml(displayName(x.u))}${x.u.active ? "" : ` <i class="fa-solid fa-plug-circle-xmark" data-tooltip="${t("Offline")}"></i>`}
          <small style="color:${colour(x.avg)}">${t("Luck.Summary", { avg: x.avg.toFixed(1), count: x.d.length })}</small></span>
        <span class="fr-chips">${d20Chips(x.d.slice(0, 10))}</span>
        ${x.u.active ? `<button type="button" class="fr-cancel" data-boost="${x.u.id}" data-tooltip="${t("Luck.Boost")}"><i class="fa-solid fa-arrow-trend-up"></i></button>` : ""}
      </li>`).join("");

    const historyRows = history.slice(0, 8).map(h => {
      const name = h.who === null ? "" : h.who === "all" ? t("Target.Everyone") : userName(h.who);
      return `<li class="fr-history-${h.kind}"><span>${clock(h.time)}</span> ${name ? `<b>${escapeHtml(name)}</b> ` : ""}${h.text}</li>`;
    }).join("");

    const tab = (attr, value, current, label) =>
      `<button type="button" data-${attr}="${value}" class="${current === value ? "active" : ""}">${label}</button>`;

    const damageSection = damageSupported() ? `
      <section class="fr-block">
        <div class="fr-head">
          <span>${t("Damage.Heading")}</span>
          <span class="fr-tabs">
            ${tab("dtype", "max", s.dType, t("Damage.Max"))}
            ${tab("dtype", "min", s.dType, t("Damage.Min"))}
            ${tab("dtype", "total", s.dType, t("Damage.Total"))}
          </span>
        </div>
        ${s.dType === "total" ? `<label class="fr-count">${t("Damage.TotalLabel")}
          <input type="number" name="dValue" min="0" max="999" value="${s.dValue}">
          <span class="fr-hint">${t("Damage.TotalHint")}</span>
        </label>` : `<p class="fr-hint">${s.dType === "max" ? t("Damage.MaxHint") : t("Damage.MinHint")}</p>`}
        <label class="fr-count">${t("Damage.CountLabel")}
          <input type="number" name="dCount" min="1" max="10" value="${s.dCount}">
          <span class="fr-hint">${t("UsesTargets")}</span>
        </label>
        <button type="button" class="fr-apply" data-action="setDamage"><i class="fa-solid fa-burst"></i> ${t("Damage.Apply")}</button>
      </section>` : "";

    const deathSection = isDnd5e() ? `
      <section class="fr-block">
        <div class="fr-head"><span>${t("Death.Heading")}</span><span class="fr-hint">${t("Death.Hint")}</span></div>
        <div class="fr-quick">
          ${Object.entries(DEATH_MODES).map(([k, m]) => `<button type="button" data-death="${k}" class="${s.deathMode === k ? "selected" : ""}">${t(m.label)}</button>`).join("")}
        </div>
        <label class="fr-count">${t("Death.CountLabel")}
          <input type="number" name="deathCount" min="1" max="3" value="${s.deathCount}">
          <span class="fr-hint">${t("UsesTargets")}</span>
        </label>
        <button type="button" class="fr-apply" data-action="setDeath"><i class="fa-solid fa-skull"></i> ${t("Death.Apply")}</button>
      </section>` : "";

    return `
      <section class="fr-block">
        <div class="fr-head">
          <span>${t("Value.Heading")}</span>
          <span class="fr-tabs">
            ${tab("mode", "fixed", s.mode, t("Value.Fixed"))}
            ${tab("mode", "range", s.mode, t("Value.Range"))}
          </span>
        </div>
        ${s.mode === "fixed" ? `
          <div class="fr-grid">${grid}</div>
          <div class="fr-quick">
            <button type="button" data-quick="20"><i class="fa-solid fa-crown"></i> ${t("Value.Crit")}</button>
            <button type="button" data-quick="1"><i class="fa-solid fa-skull"></i> ${t("Value.Fumble")}</button>
          </div>` : `
          <div class="fr-range">
            <label>${t("Value.Min")} <input type="number" name="min" min="1" max="20" value="${s.min}"></label>
            <label>${t("Value.Max")} <input type="number" name="max" min="1" max="20" value="${s.max}"></label>
            <span class="fr-hint">${t("Value.RangeHint")}</span>
          </div>
          <div class="fr-quick">
            <button type="button" data-range="15,19">${t("Value.High")}</button>
            <button type="button" data-range="10,14">${t("Value.Middle")}</button>
            <button type="button" data-range="2,6">${t("Value.Low")}</button>
          </div>`}
        <label class="fr-count">${t("Value.CountLabel")}
          <input type="number" name="count" min="1" max="10" value="${s.count}">
          <span class="fr-hint">${t("Value.CountHint")}</span>
        </label>
      </section>

      <section class="fr-block">
        <div class="fr-head"><span>${t("Target.Heading")}</span><span class="fr-hint">${t("Target.Hint")}</span></div>
        <div class="fr-cards">
          ${card("self", t("Target.Self"), me.name, avatar(me))}
          ${card("all", t("Target.Everyone"), t("Target.EveryoneHint"), null, "fa-users")}
          ${card("tokens", t("Target.Tokens"), t("Target.TokensHint"), null, "fa-crosshairs")}
          ${others.map(u => card(u.id, displayName(u), u.isGM ? `${u.name} · GM` : u.name, avatar(u))).join("")}
        </div>
      </section>

      <button type="button" class="fr-apply" data-action="setD20"><i class="fa-solid fa-dice-d20"></i> ${t("Value.Apply")}</button>

      ${damageSection}
      ${deathSection}
      ${this.#panicSection(others)}

      <section class="fr-block">
        <div class="fr-head">
          <span>${t("Luck.Heading")}</span>
          <button type="button" class="fr-small" data-action="toggleLuck"><i class="fa-solid fa-chart-simple"></i> ${s.luckOpen ? t("Hide") : t("Show")}</button>
        </div>
        ${s.luckOpen ? (luck.length
          ? `<p class="fr-hint">${t("Luck.Hint")}</p><ul class="fr-list">${luckRows}</ul>`
          : `<p class="fr-empty">${t("Luck.Empty")}</p>`) : ""}
      </section>

      <section class="fr-block">
        <div class="fr-head">
          <span>${t("Queued.Heading")}</span>
          ${queued ? `<button type="button" class="fr-small" data-action="cancelAll"><i class="fa-solid fa-ban"></i> ${t("Queued.CancelAll")}</button>` : ""}
        </div>
        ${queued ? `<ul class="fr-list">${queued}</ul>` : `<p class="fr-empty">${t("Queued.Empty")}</p>`}
      </section>

      ${history.length ? `
      <section class="fr-block">
        <div class="fr-head"><span>${t("History.Heading")}</span></div>
        <ul class="fr-history">${historyRows}</ul>
      </section>` : ""}`;
  }

  _replaceHTML(html, content) {
    content.innerHTML = html;
    this.#bind(content);
  }

  #boundRoot = null;

  // The content element stays the same between renders: bind listeners only once,
  // otherwise they pile up and one click runs several times.
  #bind(root) {
    if (this.#boundRoot === root) return;
    this.#boundRoot = root;
    const s = this.state;
    root.addEventListener("click", (ev) => {
      const el = ev.target.closest("button");
      if (!el) return;
      const ds = el.dataset;
      if (ds.mode) { s.mode = ds.mode; return this.render(); }
      if (ds.dtype) { s.dType = ds.dtype; return this.render(); }
      if (ds.death) { s.deathMode = ds.death; return this.render(); }
      if (ds.value) { s.value = Number(ds.value); return this.render(); }
      if (ds.quick) { s.mode = "fixed"; s.value = Number(ds.quick); return this.render(); }
      if (ds.range) { [s.min, s.max] = ds.range.split(",").map(Number); return this.render(); }
      if (ds.target) {
        const id = ds.target;
        if (id === "all") s.targets = new Set(s.targets.has("all") ? [] : ["all"]);
        else {
          s.targets.delete("all");
          s.targets.has(id) ? s.targets.delete(id) : s.targets.add(id);
        }
        return this.render();
      }
      if (ds.boost) {
        const u = game.users.get(ds.boost);
        if (!u?.active) return ui.notifications.warn(t("Notify.NotConnected", { name: u?.name ?? "?" }));
        const v = 12 + Math.floor(Math.random() * 6);
        setNextD20([v], u.id);
        return ui.notifications.info(t("Notify.SetSummary", { summary: `${u.name}: ${v}` }));
      }
      if (ds.cancel) return cancel(ds.cancel);
      if (ds.cancelActor) { actorQueues.delete(ds.cancelActor); return this.render(); }
      switch (ds.action) {
        case "toggleLuck": s.luckOpen = !s.luckOpen; return this.render();
        case "cancelAll": return cancel("all");
        case "setD20": {
          const [lo, hi] = [Math.min(s.min, s.max), Math.max(s.min, s.max)];
          const make = () => s.mode === "fixed"
            ? Array(s.count).fill(s.value)
            : Array.from({ length: s.count }, () => lo + Math.floor(Math.random() * (hi - lo + 1)));
          return this.#forTargets((id) => {
            const values = make();
            setNextD20(values, id);
            return values.join(", ");
          }, { actorFn: (actor) => {
            const values = make();
            setNextD20ForActor(actor, values);
            return values.join(", ");
          } });
        }
        case "setDamage": return this.#forTargets((id) => {
          const list = Array.from({ length: s.dCount }, () => ({ type: s.dType, value: s.dValue }));
          setNextDamage(list, id);
          return list.map(damageLabel).join(", ");
        });
        case "setDeath": return this.#forTargets((id) => {
          const mode = DEATH_MODES[s.deathMode] ?? DEATH_MODES.success;
          const values = Array.from({ length: s.deathCount }, mode.make);
          setNextDeathSave(values, id);
          return values.join(", ");
        });
      }
    });
    root.addEventListener("change", (ev) => {
      const { name, value } = ev.target;
      const int = (lo, hi, fallback) => Math.max(lo, Math.min(hi, Math.round(Number(value)) || fallback));
      if (name === "min" || name === "max") s[name] = clamp20(value);
      if (name === "count") s.count = int(1, 10, 1);
      if (name === "dCount") s.dCount = int(1, 10, 1);
      if (name === "deathCount") s.deathCount = int(1, 3, 1);
      if (name === "dValue") s.dValue = int(0, 999, 0);
      if (name === "panicValue" || name === "panicTarget") {
        const p = panicSettings();
        if (name === "panicValue") p.value = clamp20(value);
        else p.target = value;
        game.settings.set(MODULE_ID, "panic", p);
      }
    });
  }

  /** Run fn(targetId) for every selected target that is still connected, then show one summary. */
  #forTargets(fn, { actorFn = null } = {}) {
    if (!this.state.targets.size) return ui.notifications.warn(t("Notify.PickTarget"));
    const summary = [];
    const targets = new Set(this.state.targets);
    if (targets.delete("tokens")) {
      const tokens = canvas.tokens?.controlled ?? [];
      if (!tokens.length) ui.notifications.warn(t("Notify.NoTokens"));
      for (const token of tokens) {
        const owners = playerOwners(token.actor);
        if (owners.length) owners.forEach(u => targets.add(u.id));
        else if (actorFn && token.actor) summary.push(`${token.actor.name}: ${actorFn(token.actor)}`);
        else ui.notifications.warn(t("Notify.NpcOnlyD20", { name: token.name }));
      }
    }
    for (const id of targets) {
      if (id !== "self" && id !== "all" && !game.users.get(id)?.active) {
        ui.notifications.warn(t("Notify.NotConnected", { name: userName(id) }));
        continue;
      }
      const values = fn(id);
      const name = id === "self" ? t("Target.Self") : id === "all" ? t("Target.Everyone") : userName(id);
      summary.push(`${name}: ${values}`);
    }
    if (summary.length) ui.notifications.info(t("Notify.SetSummary", { summary: summary.join(" · ") }));
  }
}

/** Shown once per GM, the first time they open the panel. */
async function firstUseWarning() {
  if (game.user.getFlag(MODULE_ID, "warningSeen")) return;
  await foundry.applications.api.DialogV2.prompt({
    window: { title: "FATED.Warning.Title", icon: "fa-solid fa-dice-d20" },
    classes: ["fated-rolls-warning"],
    content: `
      <div class="fr-warning">
        <img src="modules/${MODULE_ID}/img/author.png" alt="">
        <p>${t("Warning.Text")}</p>
      </div>`,
    ok: { label: "FATED.Warning.Ok", icon: "fa-solid fa-check" },
    rejectClose: false
  });
  await game.user.setFlag(MODULE_ID, "warningSeen", true);
}

async function openPanel() {
  if (!game.user.isGM) return;
  await firstUseWarning();
  panel ??= new FatedRollsPanel();
  panel.render({ force: true });
  return panel;
}

// --- Start-up --------------------------------------------------------------
Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "panic", {
    scope: "client",
    config: false,
    type: Object,
    default: { value: 20, target: "all" }
  });

  game.keybindings.register(MODULE_ID, "panicRoll", {
    name: "FATED.Panic.Title",
    restricted: true,
    editable: [],
    onDown: () => { panicRoll(); return true; }
  });

  const mercySetting = (key, type, def, range) => game.settings.register(MODULE_ID, key, {
    name: `FATED.Settings.${key}.Name`,
    hint: `FATED.Settings.${key}.Hint`,
    scope: "world",
    config: true,
    type,
    default: def,
    ...(range ? { range } : {})
  });
  mercySetting("mercyEnabled", Boolean, false);
  mercySetting("mercyThreshold", Number, 8, { min: 2, max: 15, step: 1 });
  mercySetting("mercyStreak", Number, 4, { min: 2, max: 10, step: 1 });
  mercySetting("mercyMin", Number, 12, { min: 1, max: 20, step: 1 });
  mercySetting("mercyMax", Number, 17, { min: 1, max: 20, step: 1 });

  game.settings.register(MODULE_ID, "logToChat", {
    name: "FATED.Settings.LogToChat.Name",
    hint: "FATED.Settings.LogToChat.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });

  game.keybindings.register(MODULE_ID, "openPanel", {
    name: "FATED.Keybinding.OpenPanel",
    restricted: true,
    editable: [],
    onDown: () => { openPanel(); return true; }
  });
});

// Players: leave this module out of the Module Management list (and its counts)
Hooks.on("renderModuleManagement", (app, html) => {
  if (game.user?.isGM) return;
  const root = html instanceof HTMLElement ? html : html?.[0];
  const li = root?.querySelector(`li.package[data-module-id="${MODULE_ID}"]`);
  if (!li) return;
  const active = li.classList.contains("active");
  li.remove();
  for (const a of root.querySelectorAll("a.filter[data-filter]")) {
    const f = a.dataset.filter;
    if (f !== "all" && !(f === "active" && active) && !(f === "inactive" && !active)) continue;
    a.textContent = a.textContent.replace(/\((\d+)\)\s*$/, (_m, n) => `(${Math.max(0, n - 1)})`);
  }
});

// A button in the token controls (GM only)
Hooks.on("getSceneControlButtons", (controls) => {
  if (!game.user?.isGM) return;
  const tokens = controls.tokens ?? controls.token;
  if (!tokens?.tools) return;
  tokens.tools[MODULE_ID] = {
    name: MODULE_ID,
    title: "FATED.Title",
    icon: "fa-solid fa-dice-d20",
    order: Object.keys(tokens.tools).length,
    button: true,
    visible: true,
    onChange: () => openPanel()
  };
  tokens.tools[`${MODULE_ID}-panic`] = {
    name: `${MODULE_ID}-panic`,
    title: "FATED.Panic.Title",
    icon: "fa-solid fa-bolt",
    order: Object.keys(tokens.tools).length,
    button: true,
    visible: true,
    onChange: () => panicRoll()
  };
});

Hooks.once("ready", () => {
  if (!game.modules.get("lib-wrapper")?.active) {
    if (game.user.isGM) ui.notifications.error(t("Notify.NeedsLibWrapper"), { permanent: true });
    return;
  }
  registerWrappers();
  game.socket.on(SOCKET, (data, senderId) => {
    try { onSocket(data, senderId); } catch (err) { console.error(`${MODULE_ID} | socket:`, err); }
  });
  // Queues live only in the page: after a reload, ask the GMs to send ours back
  if (!game.user.isGM) emit({ resync: true }, activeGMIds());

  // A user who disconnects keeps their row in the panel, marked offline
  Hooks.on("userConnected", () => refreshPanel());
  Hooks.on("createChatMessage", (message) => {
    try { mercyCheck(message); } catch (err) { console.warn(`${MODULE_ID} | mercy:`, err); }
  });

  const mod = game.modules.get(MODULE_ID);
  // Players get no API: they must not be able to set their own rolls.
  mod.api = game.user.isGM
    ? { openPanel, panicRoll, setNextD20, setNextD20ForActor, setNextDamage, setNextDeathSave, cancel }
    : {};
});
