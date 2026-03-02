require("dotenv").config();
const fs = require("fs");
const path = require("path");
const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));

const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  REST,
  Routes,
  SlashCommandBuilder,
} = require("discord.js");

// ====== ENV ======
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
let CHANNEL_ID = process.env.CHANNEL_ID; // ممكن يتغير عبر /setchannel
const GUILD_ID = process.env.GUILD_ID;   // اختياري لتسجيل الأوامر فورًا

const INTERVAL_MS = Number(process.env.INTERVAL_MS || 5000);
const STATE_FILE = path.join(__dirname, "state.json");

// ====== State ======
function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) {
      const init = {
        messageId: null,
        lastLiveKeys: [],
        counts: { twitch: 0, kick: 0 },
        streamers: { twitch: [], kick: [] },  // ✅ القوائم صارت هنا
        channelId: CHANNEL_ID || null,        // ✅ نخزن الروم
      };
      fs.writeFileSync(STATE_FILE, JSON.stringify(init, null, 2));
      return init;
    }
    const st = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));

    // ترقيع لو state قديم
    st.counts ||= { twitch: 0, kick: 0 };
    st.lastLiveKeys ||= [];
    st.streamers ||= { twitch: [], kick: [] };
    st.channelId ||= CHANNEL_ID || null;

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
  fs.writeFileSync(STATE_FILE, JSON.stringify(st, null, 2));
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

  // ✅ بدون رابط كامل
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

  const TWITCH_LOGINS = state.streamers.twitch || [];
  const KICK_LOGINS = state.streamers.kick || [];

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

// ===== Slash Commands =====
async function registerCommands() {
  if (!DISCORD_CLIENT_ID) {
    console.log("❌ ناقص DISCORD_CLIENT_ID في Render Environment");
    return;
  }

  const commands = [
    new SlashCommandBuilder()
      .setName("add")
      .setDescription("إضافة ستريمر (Twitch/Kick)")
      .addStringOption(o =>
        o.setName("platform")
          .setDescription("twitch أو kick")
          .setRequired(true)
          .addChoices(
            { name: "twitch", value: "twitch" },
            { name: "kick", value: "kick" }
          ))
      .addStringOption(o =>
        o.setName("login")
          .setDescription("اسم القناة (بدون رابط)")
          .setRequired(true)),

    new SlashCommandBuilder()
      .setName("remove")
      .setDescription("حذف ستريمر (Twitch/Kick)")
      .addStringOption(o =>
        o.setName("platform")
          .setDescription("twitch أو kick")
          .setRequired(true)
          .addChoices(
            { name: "twitch", value: "twitch" },
            { name: "kick", value: "kick" }
          ))
      .addStringOption(o =>
        o.setName("login")
          .setDescription("اسم القناة")
          .setRequired(true)),

    new SlashCommandBuilder()
      .setName("list")
      .setDescription("عرض قائمة الستريمرز المسجلين"),

    new SlashCommandBuilder()
      .setName("setchannel")
      .setDescription("تحديد الروم اللي ينزل فيه الإشعار")
      .addStringOption(o =>
        o.setName("channel_id")
          .setDescription("آيدي الروم")
          .setRequired(true)),

    new SlashCommandBuilder()
      .setName("forceupdate")
      .setDescription("تحديث الإشعار الآن"),
  ].map(c => c.toJSON());

  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);

  if (GUILD_ID) {
    await rest.put(
      Routes.applicationGuildCommands(DISCORD_CLIENT_ID, GUILD_ID),
      { body: commands }
    );
    console.log("✅ تم تسجيل أوامر السلاش للسيرفر (Guild) فورًا");
  } else {
    await rest.put(
      Routes.applicationCommands(DISCORD_CLIENT_ID),
      { body: commands }
    );
    console.log("✅ تم تسجيل أوامر السلاش (Global) (قد تتأخر بالظهور)");
  }
}

// ===== Discord Client =====
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  if (!DISCORD_TOKEN) {
    console.log("❌ ناقص DISCORD_TOKEN");
    process.exit(1);
  }
  if (!CHANNEL_ID && !state.channelId) {
    console.log("❌ ناقص CHANNEL_ID (أو استخدم /setchannel)");
  }

  await registerCommands().catch(console.error);

  const usedChannelId = state.channelId || CHANNEL_ID;
  if (usedChannelId) {
    const channel = await client.channels.fetch(usedChannelId).catch(() => null);
    if (channel) {
      update(channel).catch(console.error);
      setInterval(() => update(channel).catch(console.error), INTERVAL_MS);
    } else {
      console.log("❌ CHANNEL_ID غلط أو ما عنده صلاحية");
    }
  } else {
    // ما في روم محدد—البوت ينتظر /setchannel
    setInterval(() => {}, 60_000);
  }
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const cmd = interaction.commandName;

  if (cmd === "add") {
    const platform = interaction.options.getString("platform", true);
    const loginRaw = interaction.options.getString("login", true);
    const login = loginRaw.trim().replace(/^@/, "").replace(/\s+/g, "");

    const arr = state.streamers[platform] || (state.streamers[platform] = []);
    if (arr.includes(login)) {
      return interaction.reply({ content: `⚠️ موجود من قبل: **${login}** على ${platform}`, ephemeral: true });
    }
    arr.push(login);
    saveState(state);

    return interaction.reply({ content: `✅ تمت الإضافة: **${login}** على ${platform}`, ephemeral: true });
  }

  if (cmd === "remove") {
    const platform = interaction.options.getString("platform", true);
    const loginRaw = interaction.options.getString("login", true);
    const login = loginRaw.trim().replace(/^@/, "").replace(/\s+/g, "");

    const arr = state.streamers[platform] || [];
    const idx = arr.indexOf(login);
    if (idx === -1) {
      return interaction.reply({ content: `⚠️ غير موجود: **${login}** على ${platform}`, ephemeral: true });
    }
    arr.splice(idx, 1);
    saveState(state);

    return interaction.reply({ content: `✅ تم الحذف: **${login}** من ${platform}`, ephemeral: true });
  }

  if (cmd === "list") {
    const t = (state.streamers.twitch || []).join(", ") || "—";
    const k = (state.streamers.kick || []).join(", ") || "—";
    return interaction.reply({
      content: `**Twitch:** ${t}\n**Kick:** ${k}`,
      ephemeral: true
    });
  }

  if (cmd === "setchannel") {
    const chId = interaction.options.getString("channel_id", true).trim();
    state.channelId = chId;
    state.messageId = null; // عشان يرسل رسالة جديدة في الروم الجديد
    saveState(state);

    return interaction.reply({ content: `✅ تم تحديد الروم: \`${chId}\``, ephemeral: true });
  }

  if (cmd === "forceupdate") {
    const usedChannelId = state.channelId || CHANNEL_ID;
    const channel = await client.channels.fetch(usedChannelId).catch(() => null);
    if (!channel) return interaction.reply({ content: "❌ ما لقيت الروم. تأكد من CHANNEL_ID أو /setchannel", ephemeral: true });

    update(channel).catch(console.error);
    return interaction.reply({ content: "✅ تم التحديث الآن.", ephemeral: true });
  }
});

client.login(DISCORD_TOKEN);
