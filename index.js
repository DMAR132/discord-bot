require("dotenv").config();

// ====== ENV (validate early) ======
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;

if (!DISCORD_TOKEN) {
  console.log("❌ ناقص DISCORD_TOKEN");
  process.exit(1);
}
if (!DISCORD_CLIENT_ID) {
  console.log("❌ ناقص DISCORD_CLIENT_ID");
  process.exit(1);
}

let CHANNEL_ID = process.env.CHANNEL_ID;
const GUILD_ID = process.env.GUILD_ID;

const INTERVAL_MS = Number(process.env.INTERVAL_MS || 30000);

const EMBED_THUMBNAIL_URL =
  process.env.EMBED_THUMBNAIL_URL ||
  "https://media.discordapp.net/attachments/1287093908437729374/1478099307210215556/ChatGPT_Image_13_2026_12_40_56_.png?format=webp&quality=lossless&width=968&height=968";

// ✅ Render: لازم يسمع على PORT
const express = require("express");
const app = express();
app.get("/", (req, res) => res.send("Bot is running"));
app.listen(process.env.PORT || 10000, () => console.log("🌐 Web server running"));

const fs = require("fs");
const path = require("path");

// node-fetch v3 (ESM) => dynamic import
const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));

const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  REST,
  Routes,
  SlashCommandBuilder,
} = require("discord.js");

// ====== crash protection (fix 10062 causing crash) ======
process.on("unhandledRejection", (err) => {
  const code = err?.code || err?.rawError?.code;
  if (code === 10062) return; // Unknown interaction
  console.error(err);
});
process.on("uncaughtException", (err) => {
  const code = err?.code || err?.rawError?.code;
  if (code === 10062) return;
  console.error(err);
});

const STATE_FILE = path.join(__dirname, "state.json");

// ====== State (single message control) ======
function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) {
      const init = {
        messageId: null,
        lastLiveKeys: [],
        counts: { twitch: 0, kick: 0 },
        streamers: { twitch: [], kick: [] },
        channelId: CHANNEL_ID || null,
      };
      fs.writeFileSync(STATE_FILE, JSON.stringify(init, null, 2));
      return init;
    }
    const st = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    st.counts ||= { twitch: 0, kick: 0 };
    st.lastLiveKeys ||= [];
    st.streamers ||= { twitch: [], kick: [] };
    st.channelId ||= CHANNEL_ID || null;
    st.messageId ||= null;
    return st;
  } catch {
    return {
      messageId: null,
      lastLiveKeys: [],
      counts: { twitch: 0, kick: 0 },
      streamers: { twitch: [], kick: [] },
      channelId: CHANNEL_ID || null,
    };
  }
}
function saveState(st) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(st, null, 2));
  } catch {}
}

const state = loadState();
if (!CHANNEL_ID && state.channelId) CHANNEL_ID = state.channelId;

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
  twitchTokenExp = Date.now() + json.expires_in * 1000;
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
      Authorization: `Bearer ${token}`,
    },
  });
  if (!res.ok) return false;
  const json = await res.json();
  return Array.isArray(json.data) && json.data.length > 0;
}

// ✅ Kick: API then stronger HTML fallback
async function isKickLive(username) {
  const u = String(username || "").trim().toLowerCase();
  if (!u) return false;

  // 1) API
  try {
    const apiUrl = `https://kick.com/api/v1/channels/${encodeURIComponent(u)}`;
    const res = await fetch(apiUrl, {
      headers: {
        Accept: "application/json, text/plain, */*",
        "User-Agent": "Mozilla/5.0",
      },
    });

    if (res.ok) {
      const json = await res.json();

      if (json?.livestream !== null && json?.livestream !== undefined) {
        if (json?.livestream?.is_live === false) return false;
        return true;
      }

      if (json?.recent_livestream?.is_live === true) return true;
    }
  } catch {}

  // 2) HTML fallback (regex قوي)
  try {
    const pageUrl = `https://kick.com/${encodeURIComponent(u)}`;
    const res2 = await fetch(pageUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res2.ok) return false;

    const html = await res2.text();

    if (/\"is_live\"\s*:\s*true/i.test(html)) return true;
    if (/\"livestream\"\s*:\s*\{/i.test(html)) return true;

    return false;
  } catch {
    return false;
  }
}

function buildLine(platform, login) {
  const url = platform === "twitch" ? `https://twitch.tv/${login}` : `https://kick.com/${login}`;
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

// ✅ Find the ONE message (never create new unless truly missing)
async function getOrCreateSingleMessage(channel) {
  if (state.messageId) {
    const msg = await channel.messages.fetch(state.messageId).catch(() => null);
    if (msg) return msg;
  }

  const recent = await channel.messages.fetch({ limit: 20 }).catch(() => null);
  if (recent) {
    const found = recent.find(
      (m) => m.author?.id === channel.client.user.id && m.embeds?.[0]?.title === "⭐ ستريمر بلادي"
    );
    if (found) {
      state.messageId = found.id;
      saveState(state);
      return found;
    }
  }

  const created = await channel.send({ content: "⏳ جاري التحضير..." }).catch(() => null);
  if (created) {
    state.messageId = created.id;
    saveState(state);
  }
  return created;
}

async function update(channel) {
  const currentLiveKeys = new Set();
  const liveTwitch = [];
  const liveKick = [];

  const TWITCH_LOGINS = state.streamers.twitch || [];
  const KICK_LOGINS = state.streamers.kick || [];

  for (const login of TWITCH_LOGINS) {
    const live = await isTwitchLive(login);
    if (!live) continue;

    const key = `twitch:${login}`;
    currentLiveKeys.add(key);
    liveTwitch.push(buildLine("twitch", login));

    if (!state.lastLiveKeys.includes(key)) state.counts.twitch = (state.counts.twitch || 0) + 1;
  }

  for (const login of KICK_LOGINS) {
    const live = await isKickLive(login);
    if (!live) continue;

    const key = `kick:${login}`;
    currentLiveKeys.add(key);
    liveKick.push(buildLine("kick", login));

    if (!state.lastLiveKeys.includes(key)) state.counts.kick = (state.counts.kick || 0) + 1;
  }

  const totalLiveNow = liveTwitch.length + liveKick.length;
  const statusLine = totalLiveNow > 0 ? "🟢 ONLINE" : "⚪ OFFLINE";

  const kickValue = liveKick.length ? chunkIfTooLong(liveKick) : "—";
  const twitchValue = liveTwitch.length ? chunkIfTooLong(liveTwitch) : "—";

  const embed = new EmbedBuilder()
    .setColor(0x7c3aed)
    .setTitle("⭐ ستريمر بلادي")
    .setThumbnail(EMBED_THUMBNAIL_URL)
    .setDescription(`**الحالة:** ${statusLine}\n**اللايف الآن:** (${totalLiveNow})`)
    .addFields(
      { name: "🟩 Kick", value: kickValue, inline: true },
      { name: "🟪 Twitch", value: twitchValue, inline: true },
      {
        name: "\u200b",
        value: `**عدد مرات فتح لايف (من وقت تشغيل البوت):**\nKick: ${state.counts.kick || 0} | Twitch: ${state.counts.twitch || 0}`,
        inline: false,
      }
    )
    .setTimestamp();

  state.lastLiveKeys = Array.from(currentLiveKeys);
  saveState(state);

  const msg = await getOrCreateSingleMessage(channel);
  if (!msg) return;

  await msg.edit({ content: "", embeds: [embed] }).catch(() => {});
}

// ===== Slash Commands =====
async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName("add")
      .setDescription("إضافة ستريمر (Twitch/Kick)")
      .addStringOption((o) =>
        o
          .setName("platform")
          .setDescription("twitch أو kick")
          .setRequired(true)
          .addChoices(
            { name: "twitch", value: "twitch" },
            { name: "kick", value: "kick" }
          )
      )
      .addStringOption((o) => o.setName("login").setDescription("اسم القناة فقط (بدون رابط)").setRequired(true)),

    new SlashCommandBuilder()
      .setName("remove")
      .setDescription("حذف ستريمر (Twitch/Kick)")
      .addStringOption((o) =>
        o
          .setName("platform")
          .setDescription("twitch أو kick")
          .setRequired(true)
          .addChoices(
            { name: "twitch", value: "twitch" },
            { name: "kick", value: "kick" }
          )
      )
      .addStringOption((o) => o.setName("login").setDescription("اسم القناة").setRequired(true)),

    new SlashCommandBuilder().setName("list").setDescription("عرض قائمة الستريمرز المسجلين"),

    new SlashCommandBuilder()
      .setName("setchannel")
      .setDescription("تحديد الروم اللي ينزل فيه الإشعار")
      .addStringOption((o) => o.setName("channel_id").setDescription("آيدي الروم").setRequired(true)),

    new SlashCommandBuilder().setName("forceupdate").setDescription("تحديث الإشعار الآن"),
  ].map((c) => c.toJSON());

  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);

  if (GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(DISCORD_CLIENT_ID, GUILD_ID), { body: commands });
    console.log("✅ Slash Commands (Guild) جاهزة فورًا");
  } else {
    await rest.put(Routes.applicationCommands(DISCORD_CLIENT_ID), { body: commands });
    console.log("✅ Slash Commands (Global) (قد تتأخر بالظهور)");
  }
}

// ===== Discord Client =====
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  await registerCommands().catch(console.error);

  const usedChannelId = state.channelId || CHANNEL_ID;
  if (usedChannelId) {
    const channel = await client.channels.fetch(usedChannelId).catch(() => null);
    if (channel) {
      await update(channel).catch(console.error);
      setInterval(() => update(channel).catch(console.error), INTERVAL_MS);
    } else {
      console.log("❌ CHANNEL_ID غلط أو ما عنده صلاحية");
    }
  } else {
    console.log("ℹ️ ما في روم محدد. استخدم /setchannel");
  }
});

// ✅ NO deferReply anymore (fix 10062)
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const cmd = interaction.commandName;

  async function quickAck(ephemeral = true) {
    try {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: "⏳ جاري التنفيذ...", ephemeral });
      }
      return true;
    } catch {
      return false;
    }
  }

  async function safeEdit(content, ephemeral = true) {
    try {
      if (interaction.deferred || interaction.replied) {
        return await interaction.editReply({ content, ephemeral });
      }
      return await interaction.reply({ content, ephemeral });
    } catch {
      return null;
    }
  }

  if (cmd === "add") {
    await quickAck(true);

    const platform = interaction.options.getString("platform", true);
    const loginRaw = interaction.options.getString("login", true);
    const login = loginRaw.trim().replace(/^@/, "").replace(/\s+/g, "").toLowerCase();

    const arr = state.streamers[platform] || (state.streamers[platform] = []);
    if (arr.includes(login)) return safeEdit(`⚠️ موجود من قبل: **${login}** على ${platform}`, true);

    arr.push(login);
    saveState(state);
    return safeEdit(`✅ تمت الإضافة: **${login}** على ${platform}\nجرّب الآن: /forceupdate`, true);
  }

  if (cmd === "remove") {
    await quickAck(true);

    const platform = interaction.options.getString("platform", true);
    const loginRaw = interaction.options.getString("login", true);
    const login = loginRaw.trim().replace(/^@/, "").replace(/\s+/g, "").toLowerCase();

    const arr = state.streamers[platform] || [];
    const idx = arr.indexOf(login);
    if (idx === -1) return safeEdit(`⚠️ غير موجود: **${login}** على ${platform}`, true);

    arr.splice(idx, 1);
    saveState(state);
    return safeEdit(`✅ تم الحذف: **${login}** من ${platform}`, true);
  }

  if (cmd === "list") {
    const t = (state.streamers.twitch || []).join(", ") || "—";
    const k = (state.streamers.kick || []).join(", ") || "—";
    return safeEdit(`**Twitch:** ${t}\n**Kick:** ${k}`, true);
  }

  if (cmd === "setchannel") {
    const chId = interaction.options.getString("channel_id", true).trim();
    state.channelId = chId;
    state.messageId = null;
    saveState(state);
    return safeEdit(`✅ تم تحديد الروم: \`${chId}\``, true);
  }

  if (cmd === "forceupdate") {
    await quickAck(true);

    const usedChannelId = state.channelId || CHANNEL_ID;
    const channel = await client.channels.fetch(usedChannelId).catch(() => null);
    if (!channel) return safeEdit("❌ ما لقيت الروم. تأكد من CHANNEL_ID أو /setchannel", true);

    await update(channel).catch(console.error);
    return safeEdit("✅ تم التحديث الآن.", true);
  }
});

client.login(DISCORD_TOKEN);
