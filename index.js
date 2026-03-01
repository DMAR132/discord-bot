require("dotenv").config();

const { Client, GatewayIntentBits, EmbedBuilder, Events } = require("discord.js");
const axios = require("axios");

// ===== ENV =====
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;

const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;

const TWITCH_LOGINS = (process.env.TWITCH_LOGINS || "")
  .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);

const KICK_LOGINS = (process.env.KICK_LOGINS || "")
  .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);

function parseMap(str) {
  const map = new Map();
  if (!str) return map;

  str.split(",")
    .map(s => s.trim())
    .filter(Boolean)
    .forEach(p => {
      const [loginRaw, idRaw] = p.split(":");
      const login = (loginRaw || "").trim().toLowerCase();
      const id = (idRaw || "").trim();
      if (login && id) map.set(login, id);
    });

  return map;
}

const TWITCH_MENTION_MAP = parseMap(process.env.TWITCH_MENTION_MAP);
const KICK_MENTION_MAP = parseMap(process.env.KICK_MENTION_MAP);

// Emojis (اختياري)
const TWITCH_EMOJI = (process.env.TWITCH_EMOJI || "🟪").trim();
const KICK_EMOJI = (process.env.KICK_EMOJI || "🟩").trim();

// صور LIVE/OFFLINE
const LIVE_BADGE_URL = (process.env.LIVE_BADGE_URL || "").trim();
const OFFLINE_BADGE_URL = (process.env.OFFLINE_BADGE_URL || "").trim();

// سرعة التحديث
const UPDATE_EVERY_SECONDS = Number(process.env.UPDATE_EVERY_SECONDS || 15);

// ===== CLIENT =====
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

let messageId = null;

// Twitch token cache
let twitchToken = null;
let tokenExpire = 0;

// عشان ping مرة وحدة لكل بداية لايف
let prevLive = new Set();

// ===== TWITCH TOKEN =====
async function getTwitchToken() {
  if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET) return null;
  if (twitchToken && Date.now() < tokenExpire) return twitchToken;

  const res = await axios.post("https://id.twitch.tv/oauth2/token", null, {
    params: {
      client_id: TWITCH_CLIENT_ID,
      client_secret: TWITCH_CLIENT_SECRET,
      grant_type: "client_credentials"
    }
  });

  twitchToken = res.data.access_token;
  tokenExpire = Date.now() + (res.data.expires_in - 60) * 1000;
  return twitchToken;
}

// ===== CHECK TWITCH =====
async function checkTwitch(login) {
  try {
    const token = await getTwitchToken();
    if (!token) return { live: false };

    const res = await axios.get("https://api.twitch.tv/helix/streams", {
      params: { user_login: login },
      headers: {
        "Client-Id": TWITCH_CLIENT_ID,
        "Authorization": `Bearer ${token}`
      }
    });

    const stream = res.data?.data?.[0];
    return { live: !!stream };
  } catch {
    return { live: false };
  }
}

// ===== CHECK KICK =====
async function checkKick(login) {
  try {
    const res = await axios.get(`https://kick.com/api/v2/channels/${login}`);
    return { live: !!res.data?.livestream };
  } catch {
    return { live: false };
  }
}

// ===== Ping مؤقت =====
async function sendTempPing(channel, userIds) {
  if (!userIds.length) return;

  const uniq = [...new Set(userIds)];
  const content = uniq.map(id => `<@${id}>`).join(" ");

  const pingMsg = await channel.send({
    content,
    allowedMentions: { users: uniq }
  }).catch(() => null);

  if (pingMsg) setTimeout(() => pingMsg.delete().catch(() => {}), 5000);
}

// ===== UPDATE =====
async function update(channel) {
  let twitchLiveCount = 0;
  let kickLiveCount = 0;

  const twitchMentions = [];
  const kickMentions = [];

  const allMentionIds = [];
  const currentLive = new Set();
  const newPingUsers = [];

  // Twitch
  for (const login of TWITCH_LOGINS) {
    const d = await checkTwitch(login);
    if (!d.live) continue;

    twitchLiveCount++;
    const key = `twitch:${login}`;
    currentLive.add(key);

    const id = TWITCH_MENTION_MAP.get(login);
    if (id) {
      twitchMentions.push(`<@${id}>`);
      allMentionIds.push(id);
      if (!prevLive.has(key)) newPingUsers.push(id);
    }
  }

  // Kick
  for (const login of KICK_LOGINS) {
    const d = await checkKick(login);
    if (!d.live) continue;

    kickLiveCount++;
    const key = `kick:${login}`;
    currentLive.add(key);

    const id = KICK_MENTION_MAP.get(login);
    if (id) {
      kickMentions.push(`<@${id}>`);
      allMentionIds.push(id);
      if (!prevLive.has(key)) newPingUsers.push(id);
    }
  }

  // ping فوري لأول ما يفتح
  await sendTempPing(channel, newPingUsers);

  prevLive = currentLive;

  const totalLive = kickLiveCount + twitchLiveCount;
  const live = totalLive > 0;

  // داخل نفس المربع: رقم ثم خط ثم منشنات
  let kickValue = `${kickLiveCount}\n—`;
  if (kickMentions.length) kickValue += `\n${kickMentions.join("\n")}`;

  let twitchValue = `${twitchLiveCount}\n—`;
  if (twitchMentions.length) twitchValue += `\n${twitchMentions.join("\n")}`;

  const embed = new EmbedBuilder()
    .setTitle("⭐ مراقب ستريمر")
    .addFields(
      { name: "⭐ ستريمر", value: "\u200b", inline: true },
      { name: "\u200b", value: live ? "🔴 LIVE" : "⚫ OFFLINE", inline: true },
      { name: "عدد الستريمر الحالي:", value: `(${totalLive})`, inline: false },
      { name: `${KICK_EMOJI} Kick:`, value: kickValue, inline: false },
      { name: `${TWITCH_EMOJI} Twitch:`, value: twitchValue, inline: false }
    )
    .setTimestamp(new Date());

  const img = live ? LIVE_BADGE_URL : OFFLINE_BADGE_URL;
  if (img && img.startsWith("http")) embed.setThumbnail(img);

  const payload = {
    content: "",
    embeds: [embed],
    // عشان المنشن يطلع “mention” مو نص عادي
    allowedMentions: { users: [...new Set(allMentionIds)], parse: [] }
  };

  if (messageId) {
    const msg = await channel.messages.fetch(messageId).catch(() => null);
    if (msg) return msg.edit(payload).catch(() => {});
  }

  const msg = await channel.send(payload).catch(() => null);
  if (msg) messageId = msg.id;
}

// ===== READY =====
client.on(Events.ClientReady, async () => {
  console.log("✅ Bot ready");
  const channel = await client.channels.fetch(CHANNEL_ID).catch(() => null);
  if (!channel) return console.log("❌ Wrong CHANNEL_ID or no access");

  await update(channel);
  setInterval(() => update(channel), UPDATE_EVERY_SECONDS * 1000);
});

client.login(DISCORD_TOKEN);