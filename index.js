require("dotenv").config();
const fs = require("fs");
const path = require("path");
const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));
const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");

// ✅ من Render Environment
const CHANNEL_ID = process.env.CHANNEL_ID;
const INTERVAL_MS = Number(process.env.INTERVAL_MS || 5000);

// ✅ يقرأها من Render مثل: shroud,xqc,foo
function parseList(v) {
  return (v || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
}
const TWITCH_LOGINS = parseList(process.env.TWITCH_LOGINS);
const KICK_LOGINS = parseList(process.env.KICK_LOGINS);

const STATE_FILE = path.join(__dirname, "state.json");

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) {
      const init = { messageId: null, lastLiveKeys: [], counts: { twitch: 0, kick: 0 } };
      fs.writeFileSync(STATE_FILE, JSON.stringify(init, null, 2));
      return init;
    }
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { messageId: null, lastLiveKeys: [], counts: { twitch: 0, kick: 0 } };
  }
}
function saveState(st) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(st, null, 2));
}
const state = loadState();

// ===== Twitch token cache =====
let twitchToken = null;
let twitchTokenExp = 0;

async function getTwitchToken() {
  const now = Date.now();
  if (twitchToken && now < twitchTokenExp - 60_000) return twitchToken;

  const url = new URL("https://id.twitch.tv/oauth2/token");
  url.searchParams.set("client_id", process.env.TWITCH_CLIENT_ID || "");
  url.searchParams.set("client_secret", process.env.TWITCH_CLIENT_SECRET || "");
  url.searchParams.set("grant_type", "client_credentials");

  const res = await fetch(url.toString(), { method: "POST" });
  if (!res.ok) throw new Error("Twitch token failed: " + res.status);
  const json = await res.json();

  twitchToken = json.access_token;
  twitchTokenExp = Date.now() + (json.expires_in * 1000);
  return twitchToken;
}

async function isTwitchLive(login) {
  if (!process.env.TWITCH_CLIENT_ID || !process.env.TWITCH_CLIENT_SECRET) return false;

  const token = await getTwitchToken();
  const url = new URL("https://api.twitch.tv/helix/streams");
  url.searchParams.set("user_login", login);

  const res = await fetch(url.toString(), {
    headers: {
      "Client-ID": process.env.TWITCH_CLIENT_ID,
      "Authorization": `Bearer ${token}`,
    },
  });
  if (!res.ok) return false;
  const json = await res.json();
  return Array.isArray(json.data) && json.data.length > 0;
}

// Kick (غير رسمي)
async function isKickLive(channel) {
  try {
    const res = await fetch(`https://kick.com/api/v2/channels/${encodeURIComponent(channel)}`);
    if (!res.ok) return false;
    const json = await res.json();
    return !!json?.livestream;
  } catch {
    return false;
  }
}

function buildLine(platform, login) {
  const url = platform === "twitch"
    ? `https://twitch.tv/${login}`
    : `https://kick.com/${login}`;

  return `**${login}** — [اضغط هنا](${url})`;
}

function chunkIfTooLong(lines) {
  const joined = lines.join("\n");
  if (joined.length <= 1024) return joined;

  let out = "";
  for (const l of lines) {
    if ((out + (out ? "\n" : "") + l).length > 1000) break;
    out += (out ? "\n" : "") + l;
  }
  return out + "\n…";
}

async function update(channel) {
  const currentLiveKeys = new Set();
  const liveTwitch = [];
  const liveKick = [];

  // Twitch
  for (const login of TWITCH_LOGINS) {
    const live = await isTwitchLive(login);
    if (!live) continue;

    const key = `twitch:${login}`;
    currentLiveKeys.add(key);

    liveTwitch.push(buildLine("twitch", login));

    if (!state.lastLiveKeys.includes(key)) {
      state.counts.twitch = (state.counts.twitch || 0) + 1;
    }
  }

  // Kick
  for (const login of KICK_LOGINS) {
    const live = await isKickLive(login);
    if (!live) continue;

    const key = `kick:${login}`;
    currentLiveKeys.add(key);

    liveKick.push(buildLine("kick", login));

    if (!state.lastLiveKeys.includes(key)) {
      state.counts.kick = (state.counts.kick || 0) + 1;
    }
  }

  const totalLiveNow = liveTwitch.length + liveKick.length;
  const statusLine = totalLiveNow > 0 ? "🟢 ONLINE" : "⚪ OFFLINE";

  const kickValue = liveKick.length ? chunkIfTooLong(liveKick) : "—";
  const twitchValue = liveTwitch.length ? chunkIfTooLong(liveTwitch) : "—";

  const embed = new EmbedBuilder()
    .setColor(0x7c3aed)
    .setTitle("⭐ ستريمر بلادي")
    .setDescription(`**الحالة:** ${statusLine}\n**اللايف الآن:** (${totalLiveNow})`)
    .addFields(
      { name: "🟩 Kick", value: kickValue, inline: true },
      { name: "🟪 Twitch", value: twitchValue, inline: true },
      {
        name: "\u200b",
        value: `**عدد مرات فتح لايف (من وقت تشغيل البوت):**\nKick: ${state.counts.kick || 0} | Twitch: ${state.counts.twitch || 0}`,
        inline: false
      },
    )
    .setTimestamp();

  state.lastLiveKeys = Array.from(currentLiveKeys);
  saveState(state);

  if (state.messageId) {
    const old = await channel.messages.fetch(state.messageId).catch(() => null);
    if (old) {
      await old.edit({ embeds: [embed] }).catch(() => {});
      return;
    }
  }

  const sent = await channel.send({ embeds: [embed] }).catch(() => null);
  if (sent) {
    state.messageId = sent.id;
    saveState(state);
  }
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  if (!process.env.DISCORD_TOKEN) {
    console.log("❌ ناقص DISCORD_TOKEN");
    process.exit(1);
  }
  if (!CHANNEL_ID) {
    console.log("❌ ناقص CHANNEL_ID");
    process.exit(1);
  }

  const channel = await client.channels.fetch(CHANNEL_ID).catch(() => null);
  if (!channel) {
    console.log("❌ CHANNEL_ID غلط أو ما عنده صلاحية");
    process.exit(1);
  }

  update(channel).catch(console.error);
  setInterval(() => update(channel).catch(console.error), INTERVAL_MS);
});

client.login(process.env.DISCORD_TOKEN);
