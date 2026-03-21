const { Client, GatewayIntentBits, EmbedBuilder, REST, Routes, SlashCommandBuilder } = require('discord.js');
const {
  joinVoiceChannel, getVoiceConnection,
  createAudioPlayer, createAudioResource,
  VoiceConnectionStatus, StreamType, entersState,
} = require('@discordjs/voice');
const axios = require('axios');
const Fuse = require('fuse.js');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ffmpegStatic = require('ffmpeg-static');

const YTDLP = process.platform === 'win32'
  ? path.join(__dirname, 'yt-dlp.exe')
  : 'yt-dlp';

require('dotenv').config();

const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const TMDB_KEY = process.env.TMDB_KEY;
const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;

let igdbToken = null;
let igdbTokenExpiry = 0;
async function getIgdbToken() {
  if (igdbToken && Date.now() < igdbTokenExpiry) return igdbToken;
  const res = await axios.post(`https://id.twitch.tv/oauth2/token?client_id=${TWITCH_CLIENT_ID}&client_secret=${TWITCH_CLIENT_SECRET}&grant_type=client_credentials`);
  igdbToken = res.data.access_token;
  igdbTokenExpiry = Date.now() + (res.data.expires_in * 1000) - 60000;
  return igdbToken;
}

const HARDCORE_FILTERS = [
  { name: '📻 Radio', value: 'highpass=f=200,lowpass=f=3000,aecho=0.8:0.7:60:0.5' },
  { name: '🌊 Reverb', value: 'aecho=0.8:0.9:1000:0.3' },
  { name: '🐿️ Chipmunk', value: 'asetrate=44100*1.7,aresample=44100' },
];

const CUSTOM_FILE = './custom_animes.json';
function loadCustomAnimes() {
  try { return JSON.parse(fs.readFileSync(CUSTOM_FILE, 'utf8')); } catch { return []; }
}
function saveCustomAnimes(list) {
  fs.writeFileSync(CUSTOM_FILE, JSON.stringify(list, null, 2));
}

const activeGames = new Map();
const activeImpostorGames = new Map();
const activeExtraGames = new Map();
const skipVotes = new Map();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessageReactions, GatewayIntentBits.DirectMessages,
  ],
  partials: ['MESSAGE', 'CHANNEL', 'REACTION'],
});

// ─── Slash Commands ───────────────────────────────────────────────────────────

const commands = [
  new SlashCommandBuilder()
    .setName('guess')
    .setDescription('Lance une partie Guess The Music')
    .addStringOption(o => o.setName('theme').setDescription('Thème musical').setRequired(false)
      .addChoices(
        { name: '🎌 Anime', value: 'anime' },
        { name: '🎮 Jeux vidéo', value: 'jeux' },
        { name: '🏰 Disney / Pixar', value: 'disney' },
        { name: '🎬 Films & Séries', value: 'films' },
        { name: '🎵 Mix (tout)', value: 'mix' },
      ))
    .addStringOption(o => o.setName('mode').setDescription('Pool (anime seulement)').setRequired(false)
      .addChoices(
        { name: '🎲 Random', value: 'random' },
        { name: '⭐ Mainstream', value: 'mainstream' },
        { name: '📋 Custom (ta liste)', value: 'custom' },
      ))
    .addStringOption(o => o.setName('type').setDescription('Type de jeu').setRequired(false)
      .addChoices(
        { name: '🎵 Normal (réponses en DM)', value: 'normal' },
        { name: '⚡ Speed (1er qui répond gagne)', value: 'speed' },
      ))
    .addStringOption(o => o.setName('difficulte').setDescription('Difficulté').setRequired(false)
      .addChoices(
        { name: '😊 Normal', value: 'normal' },
        { name: '🔥 Hardcore (son filtré)', value: 'hardcore' },
      ))
    .addIntegerOption(o => o.setName('rounds').setDescription('Nombre de rounds (défaut: 5)').setMinValue(1).setMaxValue(50).setRequired(false))
    .addIntegerOption(o => o.setName('temps').setDescription('Secondes par round (défaut: 30)').setMinValue(10).setMaxValue(120).setRequired(false))
    .addIntegerOption(o => o.setName('points').setDescription('Points par bonne réponse (défaut: 1)').setMinValue(1).setMaxValue(10).setRequired(false)),

  new SlashCommandBuilder()
    .setName('extra')
    .setDescription('Jeux bonus — Imposteur ou ArpoutchMotus')
    .addStringOption(o => o.setName('mode').setDescription('Quel jeu ?').setRequired(true)
      .addChoices(
        { name: 'Imposteur — trouve qui a un personnage différent', value: 'imposteur' },
        { name: 'Motus — mot du jour (même pour tous)', value: 'motus_jour' },
        { name: 'Motus — mot libre (nouveau mot à chaque partie)', value: 'motus_libre' },
      ))
    .addIntegerOption(o => o.setName('rounds').setDescription('Rounds (imposteur seulement)').setMinValue(1).setMaxValue(10).setRequired(false))
    .addIntegerOption(o => o.setName('temps').setDescription('Secondes par round (imposteur seulement)').setMinValue(20).setMaxValue(120).setRequired(false)),

  new SlashCommandBuilder().setName('stop').setDescription('Arrête la partie en cours'),
  new SlashCommandBuilder().setName('skip').setDescription('Vote pour skipper le round (2 votes requis)'),
  new SlashCommandBuilder().setName('scores').setDescription('Affiche les scores actuels'),
  new SlashCommandBuilder().setName('join').setDescription('Le bot rejoint ton salon vocal'),
  new SlashCommandBuilder().setName('leave').setDescription('Le bot quitte le salon vocal'),
  new SlashCommandBuilder()
    .setName('addanime').setDescription('Ajoute un animé à ta liste custom')
    .addStringOption(o => o.setName('anime').setDescription("Nom de l'animé").setRequired(true)),
  new SlashCommandBuilder()
    .setName('removeanime').setDescription('Retire un animé de ta liste custom')
    .addStringOption(o => o.setName('anime').setDescription("Nom de l'animé").setRequired(true)),
  new SlashCommandBuilder().setName('listanime').setDescription('Affiche ta liste custom'),
  new SlashCommandBuilder().setName('help').setDescription("Affiche l'aide"),
];

client.once('ready', async () => {
  console.log(`✅ ${client.user.tag} connecté`);
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: [] });
    console.log('✅ Commandes globales vidées');
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands.map(c => c.toJSON()) });
    console.log('✅ Slash commands enregistrées');
  } catch (e) { console.error('❌ Slash commands error:', e.message); }
});

// ─── Voice ────────────────────────────────────────────────────────────────────

function safeDestroyConnection(guildId) {
  try {
    const conn = getVoiceConnection(guildId);
    if (conn) {
      conn.removeAllListeners();
      try { conn.disconnect(); } catch {}
      setTimeout(() => {
        try { conn.destroy(); } catch {}
      }, 300);
    }
  } catch (e) {
    console.error('Erreur destroy connexion:', e.message);
  }
}

// ─── YouTube ──────────────────────────────────────────────────────────────────

const ytdlp = spawn(YTDLP, [
  `ytsearch5:${query}`,
  '--get-url', '--get-title',
  '--format', 'bestaudio',
  '--no-playlist', '--flat-playlist',
]);
    let output = '';
    ytdlp.stdout.on('data', d => output += d.toString());
    ytdlp.on('close', () => {
      const lines = output.trim().split('\n').filter(Boolean);
      for (let i = 0; i < lines.length - 1; i += 2) {
        const title = lines[i].toLowerCase();
        const url = lines[i + 1];
        if (!url.startsWith('http')) continue;
        if (mustContain.length === 0 || mustContain.some(w => title.includes(w))) {
          console.log(`✅ YouTube: ${lines[i]}`);
          return resolve({ url, title: lines[i] });
        }
      }
      console.log(`⚠️ No match for mustContain in: ${query}`);
      resolve(null);
    });
    setTimeout(() => { ytdlp.kill(); resolve(null); }, 20000);
  });
}

// ─── Sources de musique ───────────────────────────────────────────────────────

async function getOpeningFromAnime(animeName) {
  const search = await axios.get(`https://api.jikan.moe/v4/anime?q=${encodeURIComponent(animeName)}&limit=1`);
  const anime = search.data.data?.[0];
  if (!anime) return null;
  const themes = await axios.get(`https://api.jikan.moe/v4/anime/${anime.mal_id}/themes`);
  const openings = themes.data.data?.openings;
  if (!openings || openings.length === 0) return null;
  const raw = openings[Math.floor(Math.random() * openings.length)];
  const match = raw.match(/"(.+?)"/);
  if (!match) return null;
  const song = match[1];
  const name = anime.title_english || anime.title;
  const numMatch = raw.match(/^(\d+):/);
  const opNum = numMatch ? numMatch[1] : '1';
  const query = opNum !== '1' ? `${name} opening ${opNum} ${song}` : `${name} ${song} opening`;
  console.log(`🔍 Recherche: ${query}`);
  const result = await searchYoutube(query, ['opening', 'op']);
  if (!result) return null;
  return { song, title: name, answer: name, theme: 'anime', youtubeUrl: result.url };
}

async function getRandomAnimeOpening(mode = 'mainstream', customList = []) {
  if (mode === 'custom') {
    if (!customList.length) throw new Error('Liste custom vide.');
    for (const name of [...customList].sort(() => Math.random() - 0.5)) {
      try { const r = await getOpeningFromAnime(name); if (r) return r; } catch { continue; }
    }
    throw new Error('Aucun opening custom trouvé.');
  }

  const page = mode === 'mainstream'
    ? Math.floor(Math.random() * 4) + 1
    : Math.floor(Math.random() * 50) + 1;

  const url = mode === 'mainstream'
    ? `https://api.jikan.moe/v4/top/anime?type=tv&filter=bypopularity&limit=25&page=${page}`
    : `https://api.jikan.moe/v4/top/anime?type=tv&limit=25&page=${page}`;

  const res = await axios.get(url);
  for (const anime of res.data.data.sort(() => Math.random() - 0.5)) {
    try {
      const themes = await axios.get(`https://api.jikan.moe/v4/anime/${anime.mal_id}/themes`);
      const openings = themes.data.data?.openings;
      if (!openings?.length) continue;
      const raw = openings[Math.floor(Math.random() * openings.length)];
      const match = raw.match(/"(.+?)"/);
      if (!match) continue;
      const song = match[1];
      const name = anime.title_english || anime.title;
      const numMatch = raw.match(/^(\d+):/);
      const opNum = numMatch ? numMatch[1] : '1';
      const query = opNum !== '1' ? `${name} opening ${opNum} ${song}` : `${name} ${song} opening`;
      console.log(`🔍 ${query}`);
      const result = await searchYoutube(query, ['opening', 'op']);
      if (!result) continue;
      return { song, title: name, answer: name, theme: 'anime', youtubeUrl: result.url };
    } catch { continue; }
  }
  throw new Error('Aucun opening trouvé.');
}

async function getRandomGame() {
  try {
    const token = await getIgdbToken();
    const res = await axios.post('https://api.igdb.com/v4/games',
      `fields name,total_rating_count; where total_rating_count > 1000 & category = 0 & version_parent = null; sort total_rating_count desc; limit 50;`,
      { headers: { 'Client-ID': TWITCH_CLIENT_ID, 'Authorization': `Bearer ${token}` } }
    );
    const games = res.data;
    if (!games.length) return null;
    const game = games[Math.floor(Math.random() * games.length)];
    const queries = [
      `${game.name} main theme official soundtrack`,
      `${game.name} ost music`,
      `${game.name} theme song`,
    ];
    const query = queries[Math.floor(Math.random() * queries.length)];
    console.log(`🎮 Jeu: ${game.name} — Query: ${query}`);
    let result = await searchYoutube(query, ['theme', 'ost', 'soundtrack', 'official', 'music']);
    if (!result) result = await searchYoutube(`${game.name} soundtrack`, ['soundtrack', 'ost', 'theme']);
    if (!result) result = await searchYoutube(`${game.name} main theme`, []);
    if (!result) return null;
    return { song: result.title, title: game.name, answer: game.name, theme: 'jeux', youtubeUrl: result.url };
  } catch (e) {
    console.error('IGDB error:', e.message);
    return null;
  }
}

async function getRandomDisney() {
  try {
    const page = Math.floor(Math.random() * 8) + 1;
    const company = Math.random() > 0.5 ? 2 : 3;
    const res = await axios.get(`https://api.themoviedb.org/3/discover/movie?api_key=${TMDB_KEY}&with_companies=${company}&sort_by=popularity.desc&page=${page}&language=en-US`);
    const movies = res.data.results.filter(m => m.popularity > 5);
    if (!movies.length) return null;
    const movie = movies[Math.floor(Math.random() * movies.length)];
    const queries = [
      `${movie.title} official song Disney`,
      `${movie.title} soundtrack official`,
      `${movie.title} main theme`,
    ];
    const query = queries[Math.floor(Math.random() * queries.length)];
    console.log(`🏰 Disney: ${movie.title} — Query: ${query}`);
    let result = await searchYoutube(query, ['official', 'song', 'theme', 'soundtrack', 'clip']);
    if (!result) result = await searchYoutube(`${movie.title} Disney soundtrack`, ['soundtrack', 'official', 'theme']);
    if (!result) result = await searchYoutube(`${movie.title} official music video`, []);
    if (!result) return null;
    return { song: result.title, title: movie.title, answer: movie.title, theme: 'disney', youtubeUrl: result.url };
  } catch (e) {
    console.error('TMDB Disney error:', e.message);
    return null;
  }
}

async function getRandomFilm() {
  try {
    const isMovie = Math.random() > 0.5;
    if (isMovie) {
      const page = Math.floor(Math.random() * 10) + 1;
      const res = await axios.get(`https://api.themoviedb.org/3/discover/movie?api_key=${TMDB_KEY}&sort_by=vote_count.desc&vote_count.gte=2000&page=${page}&language=en-US`);
      const movies = res.data.results;
      if (!movies.length) return null;
      const movie = movies[Math.floor(Math.random() * movies.length)];
      const queries = [
        `${movie.title} main theme official soundtrack`,
        `${movie.title} ost score`,
        `${movie.title} theme song official`,
      ];
      const query = queries[Math.floor(Math.random() * queries.length)];
      console.log(`🎬 Film: ${movie.title}`);
      let result = await searchYoutube(query, ['theme', 'ost', 'soundtrack', 'score', 'official']);
      if (!result) result = await searchYoutube(`${movie.title} soundtrack`, ['soundtrack', 'score', 'theme']);
      if (!result) result = await searchYoutube(`${movie.title} main theme`, []);
      if (!result) return null;
      return { song: result.title, title: movie.title, answer: movie.title, theme: 'films', youtubeUrl: result.url };
    } else {
      const page = Math.floor(Math.random() * 10) + 1;
      const res = await axios.get(`https://api.themoviedb.org/3/discover/tv?api_key=${TMDB_KEY}&sort_by=vote_count.desc&vote_count.gte=1000&page=${page}&language=en-US`);
      const shows = res.data.results;
      if (!shows.length) return null;
      const show = shows[Math.floor(Math.random() * shows.length)];
      const name = show.name || show.original_name;
      const queries = [
        `${name} main theme official soundtrack`,
        `${name} opening theme`,
        `${name} theme song official`,
      ];
      const query = queries[Math.floor(Math.random() * queries.length)];
      console.log(`📺 Série: ${name}`);
      let result = await searchYoutube(query, ['theme', 'ost', 'soundtrack', 'opening', 'official']);
      if (!result) result = await searchYoutube(`${name} soundtrack`, ['soundtrack', 'theme', 'opening']);
      if (!result) result = await searchYoutube(`${name} intro theme`, []);
      if (!result) return null;
      return { song: result.title, title: name, answer: name, theme: 'films', youtubeUrl: result.url };
    }
  } catch (e) {
    console.error('TMDB Film/Serie error:', e.message);
    return null;
  }
}

async function getRandomOpening(theme = 'anime', mode = 'mainstream', customList = [], playedTitles = new Set()) {
  if (theme === 'mix') {
    const themes = ['anime', 'jeux', 'disney', 'films'];
    theme = themes[Math.floor(Math.random() * themes.length)];
    console.log(`🎵 Mix → ${theme}`);
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      let result = null;
      if (theme === 'anime') result = await getRandomAnimeOpening(mode, customList);
      else if (theme === 'jeux') result = await getRandomGame();
      else if (theme === 'disney') result = await getRandomDisney();
      else if (theme === 'films') result = await getRandomFilm();

      if (result && !playedTitles.has(result.answer)) {
        playedTitles.add(result.answer);
        return result;
      } else if (result) {
        console.log(`⚠️ Déjà joué: ${result.answer}, on réessaie...`);
      }
    } catch (e) {
      console.error(`Tentative ${attempt + 1} échouée:`, e.message);
    }
  }
  throw new Error(`Impossible de charger (thème: ${theme})`);
}

// ─── Audio ────────────────────────────────────────────────────────────────────

async function getDuration(youtubeUrl) {
  return new Promise((resolve) => {
    const ytdlp = spawn(YTDLP, [
      youtubeUrl, '--get-duration', '--no-playlist', '--quiet',
    ]);
    let output = '';
    ytdlp.stdout.on('data', d => output += d.toString());
    ytdlp.on('close', () => {
      const parts = output.trim().split(':').map(Number);
      let seconds = 0;
      if (parts.length === 3) seconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
      else if (parts.length === 2) seconds = parts[0] * 60 + parts[1];
      else if (parts.length === 1) seconds = parts[0];
      resolve(isNaN(seconds) || seconds === 0 ? 180 : seconds);
    });
    setTimeout(() => { ytdlp.kill(); resolve(180); }, 10000);
  });
}

async function playAudio(connection, youtubeUrl, hardcore = false) {
  const player = createAudioPlayer();
  let filterUsed = null;

  const duration = await getDuration(youtubeUrl);

  if (duration > 420) {
    console.log(`⚠️ Vidéo trop longue (${duration}s) — skip`);
    throw new Error('Vidéo trop longue');
  }

  const maxStart = Math.min(Math.floor(duration * 0.6), duration - 35);
  const minStart = Math.min(10, maxStart);
  const startTime = minStart >= maxStart ? minStart : Math.floor(Math.random() * (maxStart - minStart)) + minStart;
  console.log(`⏱️ Durée: ${duration}s — Début à ${startTime}s`);

  const ytdlp = spawn(YTDLP, [
    youtubeUrl, '-f', 'bestaudio', '-o', '-', '--quiet', '--no-part',
  ]);

  let ffmpegArgs;
  if (hardcore) {
    filterUsed = HARDCORE_FILTERS[Math.floor(Math.random() * HARDCORE_FILTERS.length)];
    ffmpegArgs = ['-i', 'pipe:0', '-ss', String(startTime), '-t', '30', '-af', filterUsed.value, '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1'];
  } else {
    ffmpegArgs = ['-i', 'pipe:0', '-ss', String(startTime), '-t', '30', '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1'];
  }

  const ffmpeg = spawn(ffmpegStatic, ffmpegArgs, { stdio: ['pipe', 'pipe', 'ignore'] });

  const chunks = [];
  ytdlp.stdout.on('data', chunk => chunks.push(chunk));
  ytdlp.stdout.on('end', () => {
    const buffer = Buffer.concat(chunks);
    ffmpeg.stdin.write(buffer);
    ffmpeg.stdin.end();
  });

  ytdlp.on('error', e => console.error('yt-dlp error:', e.message));
  ffmpeg.stdin.on('error', () => {});
  ffmpeg.on('error', e => console.error('ffmpeg error:', e.message));

  const resource = createAudioResource(ffmpeg.stdout, { inputType: StreamType.Raw });
  player.on('error', e => console.error('Player error:', e.message));
  player.on('stateChange', (o, n) => console.log(`Player: ${o.status} → ${n.status}`));
  connection.subscribe(player);
  player.play(resource);
  console.log('🔊 Audio lancé !');
  return { player, filterUsed };
}

// ─── AniList API — Personnages pour le jeu Imposteur ─────────────────────────

async function getRandomAnimeCharacters() {
  const page = Math.floor(Math.random() * 50) + 1;
  const query = `
    query ($page: Int) {
      Page(page: $page, perPage: 5) {
        media(type: ANIME, sort: POPULARITY_DESC, format: TV) {
          title { english romaji }
          characters(sort: FAVOURITES_DESC, perPage: 10) {
            nodes { name { full } }
          }
        }
      }
    }
  `;
  const res = await axios.post('https://graphql.anilist.co', {
    query, variables: { page }
  }, { headers: { 'Content-Type': 'application/json' } });

  const medias = res.data.data.Page.media;
  // FIX : seuil relevé à 6 pour éviter les animes avec cast mal documenté
  const valid = medias.filter(m => m.characters.nodes.length >= 6);
  if (!valid.length) throw new Error('Pas assez de personnages');

  const anime = valid[Math.floor(Math.random() * valid.length)];
  const animeName = anime.title.english || anime.title.romaji;
  const chars = anime.characters.nodes.map(c => c.name.full).filter(Boolean);
  const shuffled = [...chars].sort(() => Math.random() - 0.5);

  return { animeName, characters: shuffled };
}

// ─── Imposteur via Ollama ─────────────────────────────────────────────────────

async function getSimilarCharacterFromOllama(referenceCharacter, referenceAnime) {
  const prompt = `Tu es un expert en anime. On joue à un jeu où tous les joueurs reçoivent le même personnage, sauf un imposteur qui reçoit un personnage SIMILAIRE mais DIFFÉRENT.

Personnage de référence : ${referenceCharacter} (de ${referenceAnime})

Trouve UN personnage anime qui partage des traits similaires (apparence, rôle, personnalité, pouvoirs) avec ${referenceCharacter}, mais qui vient d'un anime DIFFÉRENT de "${referenceAnime}".

Exemples de bonne similarité :
- Kakashi (sensei, cheveux blancs, masque) → Gojo Satoru (sensei, cheveux blancs, bandeau)
- Naruto (ninja blond, espiègle, rêve de devenir le plus fort) → Asta (mage sans magie, crie fort, déterminé)
- Levi (petit, fort, froid, épées) → Killua (petit, fort, froid, assassin)

Réponds UNIQUEMENT avec ce format JSON, rien d'autre, pas de texte avant ou après :
{"character": "Nom du personnage", "anime": "Nom de l'anime", "raison": "2-3 traits communs"}`;

  try {
    const res = await axios.post('http://localhost:11434/api/generate', {
      model: 'llama3.2:3b',
      prompt,
      stream: false,
      options: { temperature: 0.7, num_predict: 150 },
    }, { timeout: 30000 });

    const raw = res.data.response.trim();
    const jsonMatch = raw.match(/\{[\s\S]*?\}/);
    if (!jsonMatch) throw new Error('Pas de JSON dans la réponse Ollama');

    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed.character || !parsed.anime) throw new Error('JSON incomplet');
    if (parsed.anime.toLowerCase().includes(referenceAnime.toLowerCase())) throw new Error('Même anime que la référence');

    console.log(`🤖 Ollama → imposteur : ${parsed.character} (${parsed.anime}) | Similarité : ${parsed.raison}`);
    return { character: parsed.character, animeName: parsed.anime };

  } catch (e) {
    console.error('⚠️ Ollama error:', e.message);
    return null;
  }
}

async function getImpostorCharacter(excludeAnime, referenceCharacter = null) {
  // Tente Ollama en priorité si on a un personnage de référence
  if (referenceCharacter) {
    const ollamaResult = await getSimilarCharacterFromOllama(referenceCharacter, excludeAnime);
    if (ollamaResult) return ollamaResult;
    console.log('⚠️ Ollama indisponible ou a échoué — fallback AniList');
  }

  // Fallback AniList
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const page = Math.floor(Math.random() * 100) + 1;
      const query = `
        query ($page: Int) {
          Page(page: $page, perPage: 10) {
            media(type: ANIME, sort: POPULARITY_DESC, format: TV) {
              title { english romaji }
              characters(sort: FAVOURITES_DESC, perPage: 5) {
                nodes { name { full } }
              }
            }
          }
        }
      `;
      const res = await axios.post('https://graphql.anilist.co', {
        query, variables: { page }
      }, { headers: { 'Content-Type': 'application/json' } });

      const medias = res.data.data.Page.media;
      const valid = medias.filter(m => {
        const name = m.title.english || m.title.romaji;
        return name !== excludeAnime && m.characters.nodes.length >= 4;
      });
      if (!valid.length) continue;

      const anime = valid[Math.floor(Math.random() * valid.length)];
      const chars = anime.characters.nodes.map(c => c.name.full).filter(Boolean);
      if (!chars.length) continue;

      return {
        animeName: anime.title.english || anime.title.romaji,
        character: chars[Math.floor(Math.random() * chars.length)],
      };
    } catch { continue; }
  }
  throw new Error('Impossible de trouver un personnage imposteur');
}

// ─── Jeu Imposteur ────────────────────────────────────────────────────────────

async function collectWordFromPlayer(player, channel) {
  await channel.send(`<@${player.id}> C'est ton tour — donne **1 mot** qui décrit ton personnage (tu as 30s) !`);
  const collected = await channel.awaitMessages({
    filter: m => m.author.id === player.id && !m.author.bot,
    max: 1,
    time: 30000,
  }).catch(() => null);

  if (!collected || collected.size === 0) return '...';
  return collected.first().content.trim().split(' ')[0];
}

async function startImpostorGame(interaction, totalRounds, roundTime) {
  const guildId = interaction.guild.id;
  const channel = interaction.channel;

  if (activeImpostorGames.has(guildId)) {
    return interaction.reply({ embeds: [mkError('Partie imposteur déjà en cours.')], ephemeral: true });
  }

  await interaction.reply({ embeds: [mkInfo('Inscription en cours…')] });

  const regEmbed = (t) => new EmbedBuilder()
    .setColor(C.ice)
    .setAuthor({ name: '🕵️  Jeu de l\'Imposteur' })
    .setTitle('Inscription')
    .setDescription(`Réagis avec ✅ pour participer\n\n${bar(t, 15)}`)
    .setFooter({ text: 'Minimum 3 joueurs requis' });

  const msg = await channel.send({ embeds: [regEmbed(15)] });
  await msg.react('✅');
  let t = 15;
  const iv = setInterval(async () => {
    t--;
    if (t <= 0) { clearInterval(iv); return; }
    await msg.edit({ embeds: [regEmbed(t)] }).catch(() => {});
  }, 1000);
  await new Promise(r => setTimeout(r, 15000));
  clearInterval(iv);

  const reaction = msg.reactions.cache.get('✅');
  const users = reaction ? await reaction.users.fetch() : new Map();
  const participants = new Map();
  for (const [id, user] of users) if (!user.bot) participants.set(id, user);

  if (participants.size < 3) {
    return channel.send({ embeds: [mkError('Minimum 3 joueurs requis pour ce jeu.')] });
  }

  const playerList = [...participants.values()];
  const nbImpostors = Math.floor(playerList.length / 3);

  await channel.send({ embeds: [
    new EmbedBuilder()
      .setColor(C.indigo)
      .setAuthor({ name: '🕵️  Jeu de l\'Imposteur' })
      .setTitle('C\'est parti !')
      .setDescription(`**${playerList.length} joueurs**  ·  **${nbImpostors} imposteur(s)**\n\nDistribution des rôles dans **5 secondes…**`)
      .setFooter({ text: 'Vérifiez vos DMs !' })
  ]});
  await new Promise(r => setTimeout(r, 5000));

  const game = { totalRounds, roundTime, participants, currentRound: 0, active: true, scores: {} };
  activeImpostorGames.set(guildId, game);

  for (let round = 1; round <= totalRounds && game.active; round++) {
    game.currentRound = round;

    let animeData, impostorData;
    try {
      const lm = await channel.send({ embeds: [mkLoading('Chargement des personnages…')] });
      animeData = await getRandomAnimeCharacters();
      impostorData = await getImpostorCharacter(animeData.animeName, animeData.characters[0]);
      await lm.delete().catch(() => {});
    } catch (e) {
      console.error('Erreur AniList:', e.message);
      await channel.send({ embeds: [mkError('Erreur chargement personnages, round passé.')] });
      continue;
    }

    // Assigne les rôles
    const shuffledPlayers = [...playerList].sort(() => Math.random() - 0.5);
    const impostors = shuffledPlayers.slice(0, nbImpostors);
    const innocents = shuffledPlayers.slice(nbImpostors);

    // FIX : tous les innocents reçoivent le MÊME personnage
    const sharedCharacter = animeData.characters[0];
    const playerCharacters = new Map();
    for (const player of innocents) {
      playerCharacters.set(player.id, sharedCharacter);
    }
    for (const imp of impostors) {
      playerCharacters.set(imp.id, impostorData.character);
    }

    // FIX : DMs neutres — aucune indication du rôle
    const dmPromises = [];
    for (const player of innocents) {
      const character = playerCharacters.get(player.id);
      dmPromises.push(
        player.send({ embeds: [
          new EmbedBuilder()
            .setColor(C.indigo)
            .setAuthor({ name: `🕵️  Round ${round} / ${totalRounds}` })
            .setTitle(character)
            .setDescription(`*${animeData.animeName}*\n\nInterdit de dire le nom directement.`)
        ]}).catch(() => {})
      );
    }
    for (const imp of impostors) {
      dmPromises.push(
        imp.send({ embeds: [
          new EmbedBuilder()
            .setColor(C.indigo)
            .setAuthor({ name: `🕵️  Round ${round} / ${totalRounds}` })
            .setTitle(impostorData.character)
            .setDescription(`*${impostorData.animeName}*\n\nInterdit de dire le nom directement.`)
        ]}).catch(() => {})
      );
    }
    await Promise.all(dmPromises);

    // 2 manches de mots
    const allWords = new Map();

    for (let wordRound = 1; wordRound <= 2; wordRound++) {
      await channel.send({ embeds: [
        new EmbedBuilder()
          .setColor(C.amber)
          .setAuthor({ name: `🕵️  Round ${round} / ${totalRounds}  ·  Manche ${wordRound} / 2` })
          .setDescription('Chaque joueur donne **1 mot** qui décrit son personnage, tour par tour.\n*Interdit de dire le nom directement !*')
      ]});

      const turnOrder = [...playerList].sort(() => Math.random() - 0.5);

      for (const player of turnOrder) {
        if (!game.active) break;
        const word = await collectWordFromPlayer(player, channel);
        if (!allWords.has(player.id)) allWords.set(player.id, []);
        allWords.get(player.id).push(word);
      }

      if (!game.active) break;

      const recapPublic = playerList.map(p => {
        const words = allWords.get(p.id) || [];
        return `**${p.username}** · ${words.join(' · ')}`;
      });

      await channel.send({ embeds: [
        new EmbedBuilder()
          .setColor(C.ice)
          .setAuthor({ name: `📝  Récap — Manche ${wordRound} / 2` })
          .setDescription(recapPublic.map(l => `> ${l}`).join('\n'))
      ]});

      if (wordRound < 2) await new Promise(r => setTimeout(r, 3000));
    }

    if (!game.active) break;

    // Phase de vote
    const voteOptions = playerList.map((p, i) => `**${i + 1}.** ${p.username}`).join('\n');

    await channel.send({ embeds: [
      new EmbedBuilder()
        .setColor(C.amber)
        .setAuthor({ name: '🗳️  Phase de vote' })
        .setDescription(`${voteOptions}\n\nL'imposteur **survit** s'il reçoit au maximum **1 voix** contre lui.`)
    ]});

    const votes = new Map();

    for (const player of playerList) {
      if (!game.active) break;
      await channel.send(`<@${player.id}> À toi de voter — qui est l'imposteur ?\n${voteOptions}\nRéponds avec le **numéro** (30s)`);
      const collected = await channel.awaitMessages({
        filter: m => m.author.id === player.id && !m.author.bot,
        max: 1,
        time: 30000,
      }).catch(() => null);
      if (collected && collected.size > 0) {
        const num = parseInt(collected.first().content.trim()) - 1;
        if (num >= 0 && num < playerList.length && playerList[num].id !== player.id) {
          votes.set(player.id, playerList[num].id);
          await channel.send(`Vote de **${player.username}** enregistré.`);
        } else {
          await channel.send(`Vote invalide de **${player.username}** — ignoré.`);
        }
      } else {
        await channel.send(`**${player.username}** n'a pas voté à temps.`);
      }
    }

    const voteCount = new Map();
    for (const votedId of votes.values()) {
      voteCount.set(votedId, (voteCount.get(votedId) || 0) + 1);
    }

    const impostorVotes = impostors.reduce((sum, imp) => sum + (voteCount.get(imp.id) || 0), 0);
    const impostorSurvives = impostorVotes <= 1;

    const resultLines = playerList.map(p => {
      const v = voteCount.get(p.id) || 0;
      const isImp = impostors.some(i => i.id === p.id);
      const words = allWords.get(p.id) || [];
      const char = playerCharacters.get(p.id) || '?';
      return `${isImp ? '🔴' : '✅'} **${p.username}** — *${char}* · mots : ${words.join(', ')} · ${v} vote(s)`;
    }).join('\n');

    await channel.send({ embeds: [
      new EmbedBuilder()
        .setColor(impostorSurvives ? C.crimson : C.mint)
        .setAuthor({ name: `🕵️  Round ${round} / ${totalRounds}  ·  Résultat` })
        .setTitle(impostorSurvives ? '😈  L\'imposteur s\'en est sorti !' : '🎉  L\'imposteur a été démasqué !')
        .setDescription(resultLines)
        .addFields(
          { name: '👥  Personnage commun', value: `**${sharedCharacter}**\n*${animeData.animeName}*`, inline: true },
          { name: '🔴  Personnage imposteur', value: `**${impostorData.character}**\n*${impostorData.animeName}*`, inline: true },
        )
        .setFooter({ text: `${impostorVotes} vote(s) contre l'imposteur` })
    ]});

    if (!impostorSurvives) {
      for (const p of innocents) {
        if (!game.scores[p.id]) game.scores[p.id] = { username: p.username, points: 0 };
        game.scores[p.id].points += 2;
      }
    } else {
      for (const imp of impostors) {
        if (!game.scores[imp.id]) game.scores[imp.id] = { username: imp.username, points: 0 };
        game.scores[imp.id].points += 3;
      }
    }

    if (round < totalRounds && game.active) {
      await channel.send({ embeds: [embedScores(game.scores, `Scores — Round ${round}`)] });
      await new Promise(r => setTimeout(r, 5000));
    }
  }

  activeImpostorGames.delete(guildId);
  if (!game.active) return;

  await channel.send({ embeds: [embedScores(game.scores, '🏆  Classement final — Imposteur')] });
}

// ─── Aliases ──────────────────────────────────────────────────────────────────

const ALIASES = {
  'dbz': ['dragon ball z'], 'dbs': ['dragon ball super'], 'db': ['dragon ball'],
  'dbgt': ['dragon ball gt'], 'dbkai': ['dragon ball z kai'],
  'dragon ball': ['dragon ball'], 'dragon ball z': ['dragon ball z'],
  'naruto': ['naruto'], 'shippuden': ['naruto shippuden'], 'boruto': ['boruto'],
  'op': ['one piece'], 'one piece': ['one piece'],
  'bleach': ['bleach'], 'tybw': ['bleach'],
  'aot': ['attack on titan'], 'snk': ['attack on titan', 'shingeki no kyojin'],
  'shingeki': ['shingeki no kyojin', 'attack on titan'],
  'attack on titan': ['attack on titan'],
  'mha': ['my hero academia'], 'bnha': ['my hero academia', 'boku no hero'],
  'boku no hero': ['my hero academia'],
  'ds': ['demon slayer'], 'kny': ['demon slayer', 'kimetsu no yaiba'],
  'kimetsu': ['demon slayer'], 'demon slayer': ['demon slayer'],
  'jjk': ['jujutsu kaisen'], 'jujutsu': ['jujutsu kaisen'],
  'hxh': ['hunter x hunter'], 'hunter': ['hunter x hunter'],
  'fma': ['fullmetal alchemist'], 'fmab': ['fullmetal alchemist brotherhood'],
  'fullmetal': ['fullmetal alchemist'],
  'sao': ['sword art online'], 'sword art': ['sword art online'],
  'jojo': ["jojo's bizarre adventure"], 'jjba': ["jojo's bizarre adventure"],
  'cg': ['code geass'], 'geass': ['code geass'],
  'tg': ['tokyo ghoul'], 'tokyo ghoul': ['tokyo ghoul'],
  'rezero': ['re:zero'], 're zero': ['re:zero'], 're:zero': ['re:zero'],
  'opm': ['one punch man'], 'saitama': ['one punch man'],
  'mob': ['mob psycho 100'], 'mp100': ['mob psycho 100'],
  'ft': ['fairy tail'], 'fairy tail': ['fairy tail'],
  'bc': ['black clover'], 'black clover': ['black clover'],
  'csm': ['chainsaw man'], 'chainsaw': ['chainsaw man'],
  'ngnl': ['no game no life'], 'konosuba': ['konosuba'],
  'sg': ['steins;gate'], 'steins gate': ['steins;gate'],
  'eva': ['evangelion'], 'nge': ['evangelion'], 'evangelion': ['evangelion'],
  'gl': ['gurren lagann'], 'ttgl': ['gurren lagann'], 'gurren': ['gurren lagann'],
  'klk': ['kill la kill'],
  'hq': ['haikyuu'], 'haikyuu': ['haikyuu'], 'haikyu': ['haikyuu'],
  'knb': ['kuroko no basket'], 'kuroko': ['kuroko no basket'],
  'tr': ['tokyo revengers'], 'tokyo rev': ['tokyo revengers'],
  'gintama': ['gintama'], 'gin': ['gintama'],
  'sds': ['the seven deadly sins'], '7ds': ['the seven deadly sins'], 'nanatsu': ['the seven deadly sins'],
  'yyh': ['yu yu hakusho'],
  'poke': ['pokemon'], 'pokemon': ['pokemon'],
  'slime': ['that time i got reincarnated as a slime'], 'tensura': ['that time i got reincarnated as a slime'],
  'khr': ['katekyo hitman reborn'], 'reborn': ['katekyo hitman reborn'],
  'se': ['soul eater'], 'soul eater': ['soul eater'],
  'pp': ['psycho-pass'], 'psycho pass': ['psycho-pass'],
  'parasyte': ['parasyte'], 'kiseijuu': ['parasyte'],
  'vinland': ['vinland saga'],
  'berserk': ['berserk'],
  'cowboy bebop': ['cowboy bebop'], 'cb': ['cowboy bebop'],
  'trigun': ['trigun'], 'hellsing': ['hellsing'],
  'inuyasha': ['inuyasha'], 'inu': ['inuyasha'],
  'sailor moon': ['sailor moon'], 'sm': ['sailor moon'],
  'cardcaptor': ['cardcaptor sakura'], 'ccs': ['cardcaptor sakura'],
  'madoka': ['puella magi madoka magica'], 'pmmm': ['puella magi madoka magica'],
  'digimon': ['digimon'],
  'yugioh': ['yu-gi-oh'], 'yu gi oh': ['yu-gi-oh'], 'ygo': ['yu-gi-oh'],
  'saint seiya': ['saint seiya'], 'chevaliers': ['saint seiya'],
  'slam dunk': ['slam dunk'],
  'captain tsubasa': ['captain tsubasa'], 'tsubasa': ['captain tsubasa'],
  'violet evergarden': ['violet evergarden'], 've': ['violet evergarden'],
  'toradora': ['toradora'], 'tora': ['toradora'],
  'clannad': ['clannad'],
  'angel beats': ['angel beats'], 'ab': ['angel beats'],
  'anohana': ['anohana'],
  'your lie in april': ['your lie in april'], 'ylia': ['your lie in april'], 'shigatsu': ['your lie in april'],
  'mushoku tensei': ['mushoku tensei'], 'mt': ['mushoku tensei'],
  'shield hero': ['the rising of the shield hero'], 'tate': ['the rising of the shield hero'],
  'overlord': ['overlord'], 'log horizon': ['log horizon'],
  'noragami': ['noragami'], 'nora': ['noragami'],
  'blue exorcist': ['blue exorcist'], 'ao no exorcist': ['blue exorcist'],
  'assassination classroom': ['assassination classroom'], 'ansatsu': ['assassination classroom'],
  'magi': ['magi'], 'black lagoon': ['black lagoon'],
  'darker than black': ['darker than black'], 'dtb': ['darker than black'],
  'accel world': ['accel world'], 'aw': ['accel world'],
  'zelda': ['the legend of zelda'], 'botw': ['the legend of zelda'],
  'link': ['the legend of zelda'], 'legend of zelda': ['the legend of zelda'],
  'mario': ['super mario bros'], 'super mario': ['super mario bros'],
  'ff7': ['final fantasy vii', 'final fantasy 7'],
  'ff': ['final fantasy'], 'final fantasy': ['final fantasy'],
  'halo': ['halo'], 'cod': ['call of duty'], 'call of duty': ['call of duty'],
  'mw': ['call of duty modern warfare'],
  'gta': ['gta v', 'grand theft auto'], 'gta 5': ['gta v'],
  'mc': ['minecraft'], 'minecraft': ['minecraft'],
  'lol': ['league of legends'], 'league': ['league of legends'],
  'wow': ['world of warcraft'], 'warcraft': ['world of warcraft'],
  'dark souls': ['dark souls'], 'ds3': ['dark souls'],
  'tlou': ['the last of us'], 'last of us': ['the last of us'],
  'rdr': ['red dead redemption'], 'rdr2': ['red dead redemption 2'],
  'red dead': ['red dead redemption'],
  'witcher': ['the witcher 3'], 'geralt': ['the witcher 3'],
  'god of war': ['god of war'], 'gow': ['god of war'], 'kratos': ['god of war'],
  'skyrim': ['skyrim'], 'elder scrolls': ['skyrim'],
  'fortnite': ['fortnite'], 'overwatch': ['overwatch'], 'ow': ['overwatch'],
  'undertale': ['undertale'], 'sans': ['undertale'],
  'sonic': ['sonic the hedgehog'],
  'street fighter': ['street fighter'], 'sf': ['street fighter'],
  'mortal kombat': ['mortal kombat'], 'mk': ['mortal kombat'],
  'tekken': ['tekken'],
  'metal gear': ['metal gear solid'], 'mgs': ['metal gear solid'],
  'assassins creed': ["assassin's creed"], 'ac': ["assassin's creed"],
  'resident evil': ['resident evil'],
  'dmc': ['devil may cry'], 'devil may cry': ['devil may cry'],
  'kingdom hearts': ['kingdom hearts'], 'kh': ['kingdom hearts'],
  'ffx': ['final fantasy x'], 'ff10': ['final fantasy x'],
  'doom': ['doom'], 'cyberpunk': ['cyberpunk 2077'], 'cp2077': ['cyberpunk 2077'],
  'elden ring': ['elden ring'], 'er': ['elden ring'],
  'hollow knight': ['hollow knight'], 'celeste': ['celeste'],
  'among us': ['among us'], 'valorant': ['valorant'], 'val': ['valorant'],
  'apex': ['apex legends'], 'battlefield': ['battlefield'], 'bf': ['battlefield'],
  'fifa': ['fifa'], 'nba 2k': ['nba 2k'], '2k': ['nba 2k'],
  'crash bandicoot': ['crash bandicoot'], 'crash': ['crash bandicoot'],
  'spyro': ['spyro'], 'donkey kong': ['donkey kong'], 'dk': ['donkey kong'],
  'kirby': ['kirby'], 'metroid': ['metroid'], 'splatoon': ['splatoon'],
  'animal crossing': ['animal crossing'], 'acnh': ['animal crossing'],
  'fire emblem': ['fire emblem'], 'fe': ['fire emblem'],
  'persona 5': ['persona 5'], 'p5': ['persona 5'], 'persona': ['persona 5'],
  'nier': ['nier automata'], 'nier automata': ['nier automata'],
  'sekiro': ['sekiro'], 'bloodborne': ['bloodborne'], 'bb': ['bloodborne'],
  'cuphead': ['cuphead'], 'stardew': ['stardew valley'],
  'lion king': ['the lion king'], 'roi lion': ['the lion king'],
  'frozen': ['frozen'], 'reine des neiges': ['frozen'], 'elsa': ['frozen'],
  'toy story': ['toy story'], 'woody': ['toy story'], 'buzz': ['toy story'],
  'nemo': ['finding nemo'], 'finding nemo': ['finding nemo'],
  'moana': ['moana'], 'vaiana': ['moana'],
  'coco': ['coco'], 'encanto': ['encanto'], 'mulan': ['mulan'], 'aladdin': ['aladdin'],
  'beauty and the beast': ['beauty and the beast'], 'belle': ['beauty and the beast'],
  'little mermaid': ['the little mermaid'], 'ariel': ['the little mermaid'],
  'tarzan': ['tarzan'],
  'tangled': ['tangled'], 'raiponce': ['tangled'], 'rapunzel': ['tangled'],
  'jungle book': ['the jungle book'], 'snow white': ['snow white'],
  'cinderella': ['cinderella'], 'cendrillon': ['cinderella'],
  'sleeping beauty': ['sleeping beauty'], 'belle au bois dormant': ['sleeping beauty'],
  'lilo stitch': ['lilo and stitch'], 'lilo': ['lilo and stitch'],
  'up': ['up'], 'inside out': ['inside out'], 'vice versa': ['inside out'],
  'wall-e': ['wall-e'], 'walle': ['wall-e'], 'cars': ['cars'],
  'ratatouille': ['ratatouille'], 'brave': ['brave'], 'rebelle': ['brave'],
  'zootopia': ['zootopia'], 'zootopie': ['zootopia'],
  'wreck it ralph': ['wreck-it ralph'], 'ralph': ['wreck-it ralph'],
  'big hero 6': ['big hero 6'], 'baymax': ['big hero 6'],
  'hercules': ['hercules'], 'pocahontas': ['pocahontas'],
  'hunchback': ['hunchback of notre dame'], 'notre dame': ['hunchback of notre dame'],
  'incredibles': ['the incredibles'],
  'monsters inc': ['monsters inc'], 'monsters': ['monsters inc'],
  'dumbo': ['dumbo'], 'bambi': ['bambi'], 'pinocchio': ['pinocchio'],
  'peter pan': ['peter pan'],
  'interstellar': ['interstellar'], 'inception': ['inception'],
  'dark knight': ['the dark knight'], 'batman': ['the dark knight'],
  'avengers': ['avengers'], 'marvel': ['avengers'],
  'star wars': ['star wars'], 'sw': ['star wars'], 'luke': ['star wars'],
  'harry potter': ['harry potter'], 'hp': ['harry potter'], 'hogwarts': ['harry potter'],
  'lotr': ['the lord of the rings'], 'lord of the rings': ['the lord of the rings'],
  'le seigneur des anneaux': ['the lord of the rings'],
  'titanic': ['titanic'], 'matrix': ['the matrix'],
  'indiana jones': ['indiana jones'], 'indy': ['indiana jones'],
  'back to the future': ['back to the future'], 'bttf': ['back to the future'],
  'rocky': ['rocky'],
  'mission impossible': ['mission impossible'], 'mi': ['mission impossible'],
  'james bond': ['james bond'], '007': ['james bond'], 'bond': ['james bond'],
  'gladiator': ['gladiator'],
  'pirates': ['pirates of the caribbean'], 'jack sparrow': ['pirates of the caribbean'],
  'forrest gump': ['forrest gump'], 'schindler': ['schindler list'],
  'dune': ['dune'], 'social network': ['the social network'],
  'whiplash': ['whiplash'], 'la la land': ['la la land'],
  'bohemian rhapsody': ['bohemian rhapsody'], 'queen': ['bohemian rhapsody'],
  'top gun': ['top gun'], 'maverick': ['top gun'], 'avatar': ['avatar'],
  'spiderman': ['spider-man'], 'spider man': ['spider-man'],
  'iron man': ['iron man'], 'thor': ['thor'],
  'jurassic park': ['jurassic park'], 'jp': ['jurassic park'],
  'terminator': ['terminator'], 'alien': ['alien'], 'predator': ['predator'],
  'goodfellas': ['goodfellas'], 'pulp fiction': ['pulp fiction'],
  'fight club': ['fight club'],
  'the godfather': ['the godfather'], 'godfather': ['the godfather'],
  'scarface': ['scarface'], 'joker': ['joker'], 'oppenheimer': ['oppenheimer'],
  'barbie': ['barbie'],
};

function checkAnswer(input, opening) {
  const raw = input.toLowerCase().trim();
  const answerLower = opening.answer.toLowerCase();

  if (raw.length < 3) return false;
  if (answerLower === raw) return true;

  for (const [alias, targets] of Object.entries(ALIASES)) {
    if (raw === alias) {
      for (const target of targets) {
        if (answerLower.includes(target)) return true;
      }
    }
  }

  if (raw.length >= 4 && answerLower.includes(raw)) return true;
  if (raw.length >= 4 && raw.includes(answerLower)) return true;

  const answerWords = answerLower.split(/\s+/).filter(w => w.length > 3);
  const inputWords = raw.split(/\s+/).filter(w => w.length > 3);

  if (answerWords.length > 0 && inputWords.length > 0) {
    const matchCount = answerWords.filter(aw =>
      inputWords.some(iw => iw === aw || (iw.length >= 5 && (iw.includes(aw) || aw.includes(iw))))
    ).length;
    const ratio = matchCount / answerWords.length;
    if (ratio >= 0.6 && matchCount >= 1) return true;
  }

  if (raw.length >= 5) {
    const fuse = new Fuse([{ text: opening.answer }], { keys: ['text'], threshold: 0.2, ignoreLocation: false });
    const results = fuse.search(raw);
    if (results.length > 0 && results[0].score !== undefined && results[0].score < 0.2) return true;
  }

  return false;
}

// ─── UI ───────────────────────────────────────────────────────────────────────

const C = {
  indigo:  0x5865F2,
  mint:    0x2ECC71,
  crimson: 0xE74C3C,
  amber:   0xF39C12,
  slate:   0x34495E,
  sakura:  0xFF6B9D,
  ice:     0x74B9FF,
  // Alias
  blue:    0x5865F2,
  green:   0x2ECC71,
  red:     0xE74C3C,
  yellow:  0xF39C12,
  purple:  0x34495E,
  orange:  0xE67E22,
};

const THEME_LABELS = {
  anime:  '🎌 Anime',
  jeux:   '🎮 Jeux vidéo',
  disney: '🏰 Disney',
  films:  '🎬 Films & Séries',
  mix:    '🎵 Mix',
};

function bar(t, total) {
  const pct    = Math.max(0, Math.min(1, t / total));
  const filled = Math.round(pct * 12);
  const empty  = 12 - filled;
  return '█'.repeat(filled) + '░'.repeat(empty) + `  **${t}s**`;
}

function medal(i) {
  return ['🥇', '🥈', '🥉'][i] ?? `**${i + 1}.**`;
}

function embedScores(scores, title) {
  const sorted = Object.values(scores).sort((a, b) => b.points - a.points);
  const desc = sorted.length === 0
    ? '*Aucun point pour l\'instant*'
    : sorted.map((p, i) => `${medal(i)}  **${p.username}** — \`${p.points} pt\``).join('\n');

  return new EmbedBuilder()
    .setColor(C.slate)
    .setAuthor({ name: '📊  Classement' })
    .setTitle(title)
    .setDescription(desc)
    .setFooter({ text: 'ArpoutchOpening' });
}

function mkError(message) {
  return new EmbedBuilder().setColor(C.crimson).setDescription(`❌  ${message}`);
}

function mkSuccess(message) {
  return new EmbedBuilder().setColor(C.mint).setDescription(`✅  ${message}`);
}

function mkInfo(message) {
  return new EmbedBuilder().setColor(C.indigo).setDescription(`ℹ️  ${message}`);
}

function mkLoading(label = 'Chargement…') {
  return new EmbedBuilder().setColor(C.slate).setDescription(`⏳  *${label}*`);
}

// ─── Inscription ──────────────────────────────────────────────────────────────

async function runRegistration(channel, time = 15) {
  const mk = (t) => new EmbedBuilder()
    .setColor(C.ice)
    .setAuthor({ name: '🎵  Guess The Music' })
    .setTitle('Rejoins la partie !')
    .setDescription(`Réagis avec ✅ pour t'inscrire\n\n${bar(t, time)}`)
    .setFooter({ text: 'Normal : réponses en DM  ·  Speed : réponses dans le channel' });

  const msg = await channel.send({ embeds: [mk(time)] });
  await msg.react('✅');
  let t = time;
  const iv = setInterval(async () => {
    t--;
    if (t <= 0) { clearInterval(iv); return; }
    await msg.edit({ embeds: [mk(t)] }).catch(() => {});
  }, 1000);
  await new Promise(r => setTimeout(r, time * 1000));
  clearInterval(iv);
  const reaction = msg.reactions.cache.get('✅');
  const users = reaction ? await reaction.users.fetch() : new Map();
  const participants = new Map();
  for (const [id, user] of users) if (!user.bot) participants.set(id, user);
  return { participants };
}

// ─── Round Normal DM ──────────────────────────────────────────────────────────

async function playRound(channel, game, voiceChannel) {
  let opening;
  try {
    const lm = await channel.send({ embeds: [mkLoading()] });
    opening = await getRandomOpening(game.theme, game.mode, game.customList, game.playedTitles);
    await lm.delete().catch(() => {});
  } catch (e) {
    console.error('Erreur chargement:', e.message);
    await channel.send({ embeds: [mkError('Impossible de charger un morceau, round passé.')] });
    return null;
  }

  let connection = getVoiceConnection(voiceChannel.guild.id);
  if (!connection) {
    connection = joinVoiceChannel({ channelId: voiceChannel.id, guildId: voiceChannel.guild.id, adapterCreator: voiceChannel.guild.voiceAdapterCreator, selfDeaf: false });
    try { await entersState(connection, VoiceConnectionStatus.Ready, 20_000); }
    catch { safeDestroyConnection(voiceChannel.guild.id); await channel.send({ embeds: [mkError('Impossible de rejoindre le salon vocal.')] }); return null; }
  }

  let player, filterUsed;
  try {
    const result = await playAudio(connection, opening.youtubeUrl, game.difficulte === 'hardcore');
    player = result.player; filterUsed = result.filterUsed;
  } catch (e) {
    console.error('❌ Erreur audio:', e.message);
    await channel.send({ embeds: [mkError('Erreur audio, round passé.')] });
    return null;
  }

  await Promise.all([...game.participants.values()].map(u =>
    u.send(`${THEME_LABELS[opening.theme]} **Écoute bien !**\nEnvoie ta réponse ici dès que tu sais.`).catch(() => {})
  ));

  let timeLeft = game.roundTime;
  const dmAnswers = new Map();
  const pending = new Set(game.participants.keys());
  const collectors = [];
  let allTimer = null;
  let resolveRound;
  const roundPromise = new Promise(r => { resolveRound = r; });
  const hardcoreLabel = game.difficulte === 'hardcore' && filterUsed ? `  ·  🔥 ${filterUsed.name}` : '';
  const themeLabel = THEME_LABELS[opening.theme] || opening.theme;

  const mkRoundEmbed = (tl, answered) => new EmbedBuilder()
    .setColor(game.difficulte === 'hardcore' ? C.amber : C.indigo)
    .setAuthor({ name: `Round ${game.currentRound} / ${game.totalRounds}${hardcoreLabel}` })
    .setTitle(`${themeLabel}  ·  Réponds en DM au bot`)
    .setDescription(bar(tl, game.roundTime))
    .setFooter({ text: `${answered} / ${game.participants.size} réponses  ·  ${game.pointsPerCorrect} pt` });

  const roundMsg = await channel.send({ embeds: [mkRoundEmbed(timeLeft, 0)] });

  const iv = setInterval(async () => {
    timeLeft--;
    if (timeLeft <= 0) { clearInterval(iv); return; }
    const answered = game.participants.size - pending.size;
    await roundMsg.edit({ embeds: [mkRoundEmbed(timeLeft, answered)] }).catch(() => {});
  }, 1000);

  const globalTimeout = setTimeout(() => {
    clearInterval(iv);
    if (allTimer) clearTimeout(allTimer);
    collectors.forEach(c => c.stop());
    resolveRound();
  }, (game.roundTime + 11) * 1000);

  game.skipResolve = () => {
    clearInterval(iv); clearTimeout(globalTimeout);
    if (allTimer) clearTimeout(allTimer);
    collectors.forEach(c => c.stop()); resolveRound();
  };

  for (const [userId, user] of game.participants) {
    try {
      const dm = await user.createDM();
      const col = dm.createMessageCollector({ time: game.roundTime * 1000 });
      collectors.push(col);
      col.on('collect', async (m) => {
        if (m.author.bot || dmAnswers.has(userId)) return;
        const correct = checkAnswer(m.content, opening);
        dmAnswers.set(userId, { user, correct });
        pending.delete(userId);
        await m.reply('✅ Réponse enregistrée.').catch(() => {});
        const answered = game.participants.size - pending.size;
        await roundMsg.edit({ embeds: [mkRoundEmbed(timeLeft, answered)] }).catch(() => {});
        if (pending.size === 0 && !allTimer) {
          clearInterval(iv);
          await channel.send({ embeds: [mkInfo('Tout le monde a répondu — révélation dans 10 secondes')] });
          allTimer = setTimeout(() => {
            clearTimeout(globalTimeout); collectors.forEach(c => c.stop()); resolveRound();
          }, 10_000);
        }
      });
    } catch { pending.delete(userId); }
  }

  await roundPromise;
  collectors.forEach(c => c.stop());
  if (player) player.stop();

  const correct = [], wrong = [];
  for (const [uid, d] of dmAnswers) {
    if (d.correct) {
      correct.push(d.user.username);
      if (!game.scores[uid]) game.scores[uid] = { username: d.user.username, points: 0 };
      game.scores[uid].points += game.pointsPerCorrect;
    } else wrong.push(d.user.username);
  }
  const noAns = [...pending].map(id => game.participants.get(id)?.username).filter(Boolean);

  const resultEmbed = new EmbedBuilder()
    .setColor(correct.length > 0 ? C.mint : C.crimson)
    .setAuthor({ name: `Round ${game.currentRound} / ${game.totalRounds}  ·  Résultat` })
    .setTitle(opening.title)
    .setDescription(
      (opening.song ? `*${opening.song}*` : '') +
      (filterUsed ? `\n🔊 Filtre : ${filterUsed.name}` : '')
    )
    .addFields(
      { name: `Trouvé  (${correct.length})`, value: correct.length > 0 ? correct.map(u => `✅  ${u}  \`+${game.pointsPerCorrect} pt\``).join('\n') : '*Personne*', inline: true },
      { name: `Raté  (${wrong.length})`,     value: wrong.length > 0 ? wrong.map(u => `❌  ${u}`).join('\n') : '—', inline: true },
    );
  if (noAns.length > 0) resultEmbed.addFields({ name: `Absent  (${noAns.length})`, value: noAns.join(', '), inline: false });

  await roundMsg.edit({ embeds: [resultEmbed] });

  for (const [uid, d] of dmAnswers) {
    await d.user.send(`${d.correct ? '✅ Correct' : '❌ Incorrect'} — **${opening.title}**${opening.song ? ` · *${opening.song}*` : ''}${filterUsed ? ` · Filtre : ${filterUsed.name}` : ''}`).catch(() => {});
  }
  for (const id of pending) {
    const u = game.participants.get(id);
    if (u) await u.send(`C'était **${opening.title}**`).catch(() => {});
  }
  return opening;
}

// ─── Round Speed ──────────────────────────────────────────────────────────────

async function playRoundSpeed(channel, game, voiceChannel) {
  let opening;
  try {
    const lm = await channel.send({ embeds: [mkLoading()] });
    opening = await getRandomOpening(game.theme, game.mode, game.customList, game.playedTitles);
    await lm.delete().catch(() => {});
  } catch (e) {
    console.error('Erreur chargement speed:', e.message);
    await channel.send({ embeds: [mkError('Impossible de charger un morceau, round passé.')] });
    return null;
  }

  let connection = getVoiceConnection(voiceChannel.guild.id);
  if (!connection) {
    connection = joinVoiceChannel({ channelId: voiceChannel.id, guildId: voiceChannel.guild.id, adapterCreator: voiceChannel.guild.voiceAdapterCreator, selfDeaf: false });
    try { await entersState(connection, VoiceConnectionStatus.Ready, 20_000); }
    catch { safeDestroyConnection(voiceChannel.guild.id); await channel.send({ embeds: [mkError('Impossible de rejoindre le salon vocal.')] }); return null; }
  }

  let player, filterUsed;
  try {
    const result = await playAudio(connection, opening.youtubeUrl, game.difficulte === 'hardcore');
    player = result.player; filterUsed = result.filterUsed;
  } catch (e) {
    console.error('❌ Erreur audio speed:', e.message);
    await channel.send({ embeds: [mkError('Erreur audio, round passé.')] });
    return null;
  }

  let timeLeft = game.roundTime;
  const allowed = new Set(game.participants.keys());
  const correct = [];
  let resolveRound;
  const roundPromise = new Promise(r => { resolveRound = r; });
  const themeLabel = THEME_LABELS[opening.theme] || opening.theme;
  const hardcoreLabel = game.difficulte === 'hardcore' && filterUsed ? `  ·  🔥 ${filterUsed.name}` : '';

  const mkSpeedEmbed = (tl) => new EmbedBuilder()
    .setColor(C.amber)
    .setAuthor({ name: `Round ${game.currentRound} / ${game.totalRounds}  ·  ⚡ Speed${hardcoreLabel}` })
    .setTitle(`${themeLabel}  ·  Écris ta réponse ici`)
    .setDescription(bar(tl, game.roundTime))
    .setFooter({ text: `🥇 Premier › ${game.pointsPerCorrect * 3} pt  ·  Autres › ${game.pointsPerCorrect} pt` });

  const roundMsg = await channel.send({ embeds: [mkSpeedEmbed(timeLeft)] });

  const iv = setInterval(async () => {
    timeLeft--;
    if (timeLeft <= 0) { clearInterval(iv); return; }
    await roundMsg.edit({ embeds: [mkSpeedEmbed(timeLeft)] }).catch(() => {});
  }, 1000);

  const globalTimeout = setTimeout(() => { clearInterval(iv); col.stop(); resolveRound(); }, game.roundTime * 1000);
  game.skipResolve = () => { clearInterval(iv); clearTimeout(globalTimeout); col.stop(); resolveRound(); };

  const col = channel.createMessageCollector({ time: game.roundTime * 1000 });
  col.on('collect', async (m) => {
    if (m.author.bot || !allowed.has(m.author.id)) return;
    if (!checkAnswer(m.content, opening)) return;
    const isFirst = correct.length === 0;
    const pts = isFirst ? game.pointsPerCorrect * 3 : game.pointsPerCorrect;
    correct.push(m.author.username);
    allowed.delete(m.author.id);
    if (!game.scores[m.author.id]) game.scores[m.author.id] = { username: m.author.username, points: 0 };
    game.scores[m.author.id].points += pts;
    await m.react(isFirst ? '🥇' : '✅').catch(() => {});
    if (isFirst) {
      await channel.send({ embeds: [mkSuccess(`**${m.author.username}** a trouvé en premier — \`+${pts} pt\``)] });
    }
    if (allowed.size === 0) { clearInterval(iv); clearTimeout(globalTimeout); col.stop(); resolveRound(); }
  });
  col.on('end', () => { clearInterval(iv); clearTimeout(globalTimeout); resolveRound(); });

  await roundPromise;
  if (player) player.stop();

  const noAns = [...allowed].map(id => game.participants.get(id)?.username).filter(Boolean);
  await roundMsg.delete().catch(() => {});
  await channel.send({ embeds: [
    new EmbedBuilder()
      .setColor(correct.length > 0 ? C.mint : C.crimson)
      .setAuthor({ name: `Round ${game.currentRound} / ${game.totalRounds}  ·  Résultat  ·  ⚡ Speed` })
      .setTitle(opening.title)
      .setDescription(
        (opening.song ? `*${opening.song}*` : '') +
        (filterUsed ? `\n🔊 Filtre : ${filterUsed.name}` : '')
      )
      .addFields(
        { name: `Trouvé  (${correct.length})`, value: correct.length > 0 ? correct.map(u => `✅  ${u}`).join('\n') : '*Personne*', inline: true },
        { name: `Absent  (${noAns.length})`,   value: noAns.length > 0 ? noAns.join(', ') : '—', inline: true },
      )
  ]});
  return opening;
}

// ─── Game loop ────────────────────────────────────────────────────────────────

async function startGame(interaction, theme, mode, type, difficulte, totalRounds, roundTime, pointsPerCorrect) {
  const guildId = interaction.guild.id;
  const channel = interaction.channel;
  const voiceChannel = interaction.member?.voice?.channel;

  if (!voiceChannel) return interaction.editReply({ embeds: [mkError('Rejoins un salon vocal d\'abord.')] });

  const customList = loadCustomAnimes();
  if (mode === 'custom' && customList.length === 0) {
    return interaction.editReply({ embeds: [mkError('Liste custom vide. Utilise /addanime pour en ajouter.')] });
  }

  const connection = joinVoiceChannel({ channelId: voiceChannel.id, guildId: voiceChannel.guild.id, adapterCreator: voiceChannel.guild.voiceAdapterCreator, selfDeaf: false });
  try { await entersState(connection, VoiceConnectionStatus.Ready, 20_000); }
  catch { safeDestroyConnection(guildId); return interaction.editReply({ embeds: [mkError('Impossible de rejoindre le salon vocal.')] }); }

  connection.on('error', (err) => { console.error('❌ Erreur connexion vocale:', err.message); });
  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
    } catch { safeDestroyConnection(guildId); }
  });

  await interaction.editReply({ embeds: [mkSuccess('Inscription lancée !')] });
  const { participants } = await runRegistration(channel);
  if (participants.size === 0) {
    safeDestroyConnection(guildId);
    return channel.send({ embeds: [mkError('Aucun participant. Partie annulée.')] });
  }

  const typeLabel = type === 'speed' ? '⚡ Speed' : '🎵 Normal';
  const diffLabel = difficulte === 'hardcore' ? '🔥 Hardcore' : '😊 Normal';
  const namesStr = [...participants.values()].map(u => `**${u.username}**`).join(', ');

  await channel.send({ embeds: [
    new EmbedBuilder()
      .setColor(C.indigo)
      .setAuthor({ name: '🎮  C\'est parti !' })
      .setTitle(`${THEME_LABELS[theme] ?? theme}  ·  ${typeLabel}`)
      .setDescription(
        `${namesStr}\n\n` +
        `**Mode** › ${mode}  ·  **Difficulté** › ${diffLabel}\n` +
        `**${totalRounds} rounds**  ·  **${roundTime}s** par round  ·  **${pointsPerCorrect} pt** / bonne réponse\n\n` +
        `*Démarre dans 5 secondes…*`
      )
      .setFooter({ text: 'ArpoutchOpening' })
  ]});
  await new Promise(r => setTimeout(r, 5000));

  const game = { totalRounds, roundTime, pointsPerCorrect, theme, mode, type, difficulte, customList, currentRound: 0, scores: {}, participants, active: true, skipResolve: null, playedTitles: new Set() };
  activeGames.set(guildId, game);

  while (game.active && game.currentRound < game.totalRounds) {
    game.currentRound++;
    skipVotes.delete(guildId);
    if (type === 'speed') await playRoundSpeed(channel, game, voiceChannel);
    else await playRound(channel, game, voiceChannel);
    if (game.active && game.currentRound < game.totalRounds) {
      await channel.send({ embeds: [embedScores(game.scores, `Scores — Round ${game.currentRound}`)] });
      await new Promise(r => setTimeout(r, 4000));
    }
  }

  activeGames.delete(guildId);
  safeDestroyConnection(guildId);
  if (!game.active) return;

  await channel.send({ embeds: [embedScores(game.scores, '🏆  Classement final')] });
  if (type !== 'speed') {
    await Promise.all([...participants.values()].map(u =>
      u.send('Partie terminée. À bientôt !').catch(() => {})
    ));
  }
}

// ─── ArpoutchMotus ────────────────────────────────────────────────────────────

async function getMotusCharacter(dayMode = true) {
  const today = new Date();
  const seed = dayMode
    ? today.getFullYear() * 10000 + (today.getMonth() + 1) * 100 + today.getDate()
    : Math.floor(Math.random() * 999999);
  const page = (seed % 50) + 1;
  const query = `
    query ($page: Int) {
      Page(page: $page, perPage: 20) {
        media(type: ANIME, sort: POPULARITY_DESC, format: TV) {
          title { english romaji }
          characters(sort: FAVOURITES_DESC, perPage: 10) {
            nodes {
              name { full }
              description(asHtml: false)
              gender
              age
            }
          }
        }
      }
    }
  `;
  const res = await axios.post('https://graphql.anilist.co', {
    query, variables: { page }
  }, { headers: { 'Content-Type': 'application/json' } });

  const medias = res.data.data.Page.media;
  const allChars = [];
  for (const media of medias) {
    for (const char of media.characters.nodes) {
      const name = char.name?.full;
      if (!name || name.length < 3 || name.length > 18) continue;
      if (name.split(' ').length > 3) continue;
      const firstName = name.split(' ')[0];
      if (!firstName || firstName.length < 3 || firstName.length > 12) continue;
      allChars.push({
        name: firstName,
        fullName: name,
        animeName: media.title.english || media.title.romaji,
        description: char.description ? char.description.replace(/~!.*?!~/gs, '').trim().slice(0, 250) : null,
        gender: char.gender || null,
        age: char.age || null,
      });
    }
  }
  if (!allChars.length) throw new Error('Aucun personnage trouvé');
  const idx = Math.abs(seed) % allChars.length;
  return allChars[idx];
}

function renderMotusGrid(attempts, answer) {
  const answerUp = answer.toUpperCase();
  const rows = [];
  for (const attempt of attempts) {
    const attemptUp = attempt.toUpperCase();
    const used = Array(answerUp.length).fill(false);
    const result = Array(attemptUp.length).fill('⬛');
    for (let i = 0; i < attemptUp.length; i++) {
      if (i < answerUp.length && attemptUp[i] === answerUp[i]) {
        result[i] = '🟩'; used[i] = true;
      }
    }
    for (let i = 0; i < attemptUp.length; i++) {
      if (result[i] !== '🟩') {
        for (let j = 0; j < answerUp.length; j++) {
          if (!used[j] && attemptUp[i] === answerUp[j]) {
            result[i] = '🟨'; used[j] = true; break;
          }
        }
      }
    }
    rows.push(result.join('') + '  `' + attemptUp + '`');
  }
  return rows.join('\n');
}

function getMotusHint(answer, attempts) {
  const answerUp = answer.toUpperCase();
  const found = new Set([0]);
  for (const attempt of attempts) {
    for (let i = 0; i < attempt.length; i++) {
      if (attempt[i].toUpperCase() === answerUp[i]) found.add(i);
    }
  }
  return answerUp.split('').map((l, i) => found.has(i) ? l : '?').join(' ');
}

const motusDailyPlayed = new Map();

function getTodayString() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

async function startArpoutchMotus(interaction, dayMode = true) {
  const guildId = interaction.guild.id;
  const channel = interaction.channel;

  await interaction.reply({ content: '`Chargement...`', flags: 64 });

  let charData;
  try {
    charData = await getMotusCharacter(dayMode);
  } catch (e) {
    console.error('Motus error:', e.message);
    return interaction.editReply({ embeds: [mkError('Erreur chargement. Réessaie.')] });
  }

  const answer = charData.name;
  const game = {
    answer,
    fullName: charData.fullName || charData.name,
    animeName: charData.animeName,
    description: charData.description,
    gender: charData.gender,
    age: charData.age,
    dayMode,
    active: true,
    scores: {},
    playerStates: new Map(),
    participants: new Map(),
    channel,
  };
  activeExtraGames.set(guildId, game);

  console.log(`ArpoutchMotus — Réponse: ${answer} (${charData.animeName})`);

  const blanks = answer.split('').map((l, i) => i === 0 ? `**${l.toUpperCase()}**` : '\\_').join('  ');

  await channel.send({ embeds: [
    new EmbedBuilder()
      .setColor(C.sakura)
      .setAuthor({ name: `🔤  ArpoutchMotus  ·  ${dayMode ? 'Mot du jour' : 'Mot libre'}` })
      .setTitle(blanks)
      .setDescription('La partie est lancée — check tes DMs !')
      .setFooter({ text: dayMode ? "Même personnage pour tout le monde aujourd'hui" : 'Personnage aléatoire' })
  ]});

  await channel.send(`<@${interaction.user.id}> La partie est prête — check tes DMs !`);

  const launcher = interaction.user;
  game.playerStates.set(launcher.id, { attempts: [], done: false, won: false });
  game.participants.set(launcher.id, launcher);
  const modeLabel = dayMode ? 'du jour' : 'libre';
  const blanksWelcomeInit = answer.split('').map(() => '\\_').join(' ');
  await launcher.send({ embeds: [
    new EmbedBuilder()
      .setColor(C.sakura)
      .setAuthor({ name: `🔤  ArpoutchMotus  ·  Mot ${modeLabel}` })
      .setTitle('Devine le prénom du personnage !')
      .setDescription(
        `**${blanksWelcomeInit}**\n\n` +
        `\`🟩\`  Bonne lettre, bonne place\n` +
        `\`🟨\`  Bonne lettre, mauvaise place\n` +
        `\`⬛\`  Lettre absente\n\n` +
        `**Indice :** \`${getMotusHint(answer, [])}\`\n\n` +
        `*Envoie ton premier essai !*`
      )
  ]}).catch(() => {});

  game.hintInterval = null;

  setTimeout(() => {
    if (activeExtraGames.get(guildId) === game) {
      if (game.hintInterval) clearInterval(game.hintInterval);
      activeExtraGames.delete(guildId);
      game.active = false;
      channel.send({ embeds: [
        new EmbedBuilder()
          .setColor(C.crimson)
          .setAuthor({ name: '⏰  ArpoutchMotus  ·  Temps écoulé' })
          .setDescription(`Le personnage était **${answer}** *(${charData.animeName})*.`)
      ]}).catch(() => {});
    }
  }, 6 * 60 * 60 * 1000);
}

// Handler DM global pour ArpoutchMotus
client.on('messageCreate', async (msg) => {
  if (msg.author.bot || msg.guild) return;

  const userId = msg.author.id;
  const input = msg.content.trim();

  let foundGame = null;
  for (const [, game] of activeExtraGames) {
    if (game.active && game.answer) { foundGame = game; break; }
  }
  if (!foundGame) return;

  const game = foundGame;
  const answer = game.answer;
  const answerUp = answer.toUpperCase();
  const inputUp = input.toUpperCase();

  if (!game.playerStates.has(userId)) {
    if (game.dayMode) {
      const today = getTodayString();
      if (motusDailyPlayed.get(userId) === today) {
        await msg.author.send('Tu as déjà joué le motus du jour ! Reviens demain.').catch(() => {});
        return;
      }
    }
    game.playerStates.set(userId, { attempts: [], done: false, won: false });
    game.participants.set(userId, msg.author);
    const modeLabel = game.dayMode ? 'du jour' : 'libre';
    const blanksWelcome = answer.split('').map(() => '\\_').join(' ');
    await msg.author.send({ embeds: [
      new EmbedBuilder()
        .setColor(C.sakura)
        .setAuthor({ name: `🔤  ArpoutchMotus  ·  Mot ${modeLabel}` })
        .setTitle('Devine le prénom du personnage !')
        .setDescription(
          `**${blanksWelcome}**\n\n` +
          `\`🟩\`  Bonne lettre, bonne place\n` +
          `\`🟨\`  Bonne lettre, mauvaise place\n` +
          `\`⬛\`  Lettre absente\n\n` +
          `**Indice :** \`${getMotusHint(answer, [])}\`\n\n` +
          `*Envoie ton premier essai !*`
        )
    ]}).catch(() => {});
    return;
  }

  const state = game.playerStates.get(userId);
  if (state.done) { await msg.reply('Tu as déjà terminé le motus du jour !').catch(() => {}); return; }

  if (input.length !== answer.length) {
    const blanksHint = answer.split('').map((l, i) => {
      if (i === 0) return l.toUpperCase();
      const found = state.attempts.some(a => a[i]?.toUpperCase() === l.toUpperCase());
      return found ? l.toUpperCase() : '\\_';
    }).join(' ');
    await msg.reply(`Le prénom fait **${answer.length} lettres** : ${blanksHint}`).catch(() => {});
    return;
  }
  if (!/^[a-zA-ZÀ-ÿ\s\-]+$/.test(input)) {
    await msg.reply('Lettres uniquement.').catch(() => {});
    return;
  }

  state.attempts.push(input);
  const grid = renderMotusGrid(state.attempts, answer);
  const correct = inputUp === answerUp;

  if (correct) {
    state.done = true; state.won = true;
    const pts = Math.max(1, 7 - Math.min(state.attempts.length, 6));
    if (!game.scores[userId]) game.scores[userId] = { username: msg.author.username, points: 0 };
    game.scores[userId].points = pts;
    if (game.dayMode) motusDailyPlayed.set(userId, getTodayString());
    await msg.author.send({ embeds: [
      new EmbedBuilder()
        .setColor(C.mint)
        .setAuthor({ name: '🎉  Trouvé !' })
        .setTitle(`**${game.fullName || answer}**  ·  *${game.animeName}*`)
        .setDescription(
          `${grid}\n\n` +
          `Trouvé en **${state.attempts.length} essai(s)**` +
          (pts > 0 ? `  ·  \`+${pts} pt\`` : '')
        )
    ]}).catch(() => {});
    const modeLabel = game.dayMode ? 'du jour ' : '';
    await game.channel.send(`**${msg.author.username}** a trouvé le personnage ${modeLabel}en ${state.attempts.length} essai(s) !`).catch(() => {});
  } else {
    const hint = getMotusHint(answer, state.attempts);
    const n = state.attempts.length;

    const dmHints = [];
    if (n >= 1 && game.gender) dmHints.push(`Genre : ${game.gender}`);
    if (n >= 2 && game.age) dmHints.push(`Âge : ${game.age}`);
    if (n >= 3 && game.description) dmHints.push(`*${game.description.split('.')[0].trim()}*`);
    if (n >= 4) dmHints.push(`Anime : **${game.animeName}**`);

    const hintsText = dmHints.length > 0 ? '\n\n' + dmHints.join('\n') : '';

    await msg.author.send({ embeds: [
      new EmbedBuilder()
        .setColor(C.amber)
        .setAuthor({ name: `🔤  Essai ${n}` })
        .setDescription(`${grid}\n\n**Indice lettres :** \`${hint}\`${hintsText}`)
    ]}).catch(() => {});
  }
});

// ─── Interactions ─────────────────────────────────────────────────────────────

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const { commandName, guild } = interaction;
  const guildId = guild?.id;

  if (commandName === 'guess') {
    if (activeGames.has(guildId)) return interaction.reply({ embeds: [mkError('Partie déjà en cours. /stop pour arrêter.')], ephemeral: true });
    const theme = interaction.options.getString('theme') || 'anime';
    const mode = interaction.options.getString('mode') || 'mainstream';
    const type = interaction.options.getString('type') || 'normal';
    const difficulte = interaction.options.getString('difficulte') || 'normal';
    const rounds = interaction.options.getInteger('rounds') || 5;
    const temps = interaction.options.getInteger('temps') || 30;
    const points = interaction.options.getInteger('points') || 1;
    await interaction.reply({ embeds: [mkInfo(`Lancement — Thème : ${THEME_LABELS[theme] ?? theme}  ·  Type : ${type}  ·  Difficulté : ${difficulte}`)] });
    await startGame(interaction, theme, mode, type, difficulte, rounds, temps, points);
    return;
  }

  if (commandName === 'extra') {
    const mode = interaction.options.getString('mode');
    if (mode === 'imposteur') {
      if (activeImpostorGames.has(guildId)) return interaction.reply({ embeds: [mkError('Partie imposteur déjà en cours.')], ephemeral: true });
      const rounds = interaction.options.getInteger('rounds') || 2;
      const temps = interaction.options.getInteger('temps') || 60;
      await startImpostorGame(interaction, rounds, temps);
    } else if (mode === 'motus_jour') {
      if (activeExtraGames.has(guildId)) return interaction.reply({ embeds: [mkError('ArpoutchMotus déjà en cours.')], ephemeral: true });
      await startArpoutchMotus(interaction, true);
    } else if (mode === 'motus_libre') {
      if (activeExtraGames.has(guildId)) return interaction.reply({ embeds: [mkError('ArpoutchMotus déjà en cours.')], ephemeral: true });
      await startArpoutchMotus(interaction, false);
    }
    return;
  }

  if (commandName === 'stop') {
    const game = activeGames.get(guildId) || activeImpostorGames.get(guildId) || activeExtraGames.get(guildId);
    if (!game) return interaction.reply({ embeds: [mkError('Aucune partie en cours.')], ephemeral: true });
    game.active = false;
    if (game.skipResolve) game.skipResolve();
    activeGames.delete(guildId);
    activeImpostorGames.delete(guildId);
    activeExtraGames.delete(guildId);
    safeDestroyConnection(guildId);
    await interaction.reply({ embeds: [embedScores(game.scores, '🛑  Partie arrêtée')] });
    if (game.participants && game.type !== 'speed') {
      await Promise.all([...game.participants.values()].map(u => u.send('Partie arrêtée.').catch(() => {})));
    }
    return;
  }

  if (commandName === 'skip') {
    const game = activeGames.get(guildId);
    if (!game) return interaction.reply({ embeds: [mkError('Aucune partie en cours.')], ephemeral: true });
    if (!game.participants.has(interaction.user.id)) return interaction.reply({ embeds: [mkError('Tu ne participes pas.')], ephemeral: true });
    if (!skipVotes.has(guildId)) skipVotes.set(guildId, new Set());
    const votes = skipVotes.get(guildId);
    votes.add(interaction.user.id);
    const needed = Math.min(2, game.participants.size);
    if (votes.size >= needed) {
      skipVotes.delete(guildId);
      if (game.skipResolve) { game.skipResolve(); game.skipResolve = null; }
      await interaction.reply({ embeds: [
        new EmbedBuilder().setColor(C.amber).setDescription('⏭️  Skip validé — passage au round suivant')
      ]});
    } else {
      await interaction.reply({ embeds: [mkInfo(`⏭️  Vote skip : \`${votes.size} / ${needed}\``)], ephemeral: true });
    }
    return;
  }

  if (commandName === 'scores') {
    const game = activeGames.get(guildId) || activeImpostorGames.get(guildId);
    if (!game) return interaction.reply({ embeds: [mkError('Aucune partie en cours.')], ephemeral: true });
    await interaction.reply({ embeds: [embedScores(game.scores, 'Scores actuels')] });
    return;
  }

  if (commandName === 'join') {
    const vc = interaction.member?.voice?.channel;
    if (!vc) return interaction.reply({ embeds: [mkError('Rejoins un vocal d\'abord.')], ephemeral: true });
    const conn = joinVoiceChannel({ channelId: vc.id, guildId: vc.guild.id, adapterCreator: vc.guild.voiceAdapterCreator, selfDeaf: false });
    try { await entersState(conn, VoiceConnectionStatus.Ready, 10_000); await interaction.reply({ embeds: [mkSuccess('Connecté.')] }); }
    catch { safeDestroyConnection(guildId); await interaction.reply({ embeds: [mkError('Impossible de rejoindre.')], ephemeral: true }); }
    return;
  }

  if (commandName === 'leave') {
    safeDestroyConnection(guildId);
    await interaction.reply({ embeds: [mkInfo('👋  Déconnecté.')] });
    return;
  }

  if (commandName === 'addanime') {
    const name = interaction.options.getString('anime');
    const list = loadCustomAnimes();
    if (list.includes(name)) return interaction.reply({ embeds: [mkError(`"${name}" est déjà dans la liste.`)], ephemeral: true });
    list.push(name);
    saveCustomAnimes(list);
    await interaction.reply({ embeds: [mkSuccess(`**${name}** ajouté à ta liste\n*${list.length} animé(s) au total*`)] });
    return;
  }

  if (commandName === 'removeanime') {
    const name = interaction.options.getString('anime');
    let list = loadCustomAnimes();
    if (!list.includes(name)) return interaction.reply({ embeds: [mkError(`"${name}" n'est pas dans la liste.`)], ephemeral: true });
    list = list.filter(a => a !== name);
    saveCustomAnimes(list);
    await interaction.reply({ embeds: [
      new EmbedBuilder().setColor(C.crimson).setDescription(`🗑️  **${name}** retiré\n*${list.length} animé(s) au total*`)
    ]});
    return;
  }

  if (commandName === 'listanime') {
    const list = loadCustomAnimes();
    await interaction.reply({ embeds: [
      new EmbedBuilder()
        .setColor(C.indigo)
        .setAuthor({ name: '📋  Liste custom' })
        .setDescription(
          list.length === 0
            ? '*Vide — utilise `/addanime` pour commencer*'
            : list.map((a, i) => `\`${String(i + 1).padStart(2, ' ')}.\`  ${a}`).join('\n')
        )
    ]});
    return;
  }

  if (commandName === 'help') {
    await interaction.reply({ embeds: [
      new EmbedBuilder()
        .setColor(C.indigo)
        .setAuthor({ name: '🎵  Guess The Music  ·  Aide' })
        .addFields(
          {
            name: '/guess',
            value:
              '> **theme** › 🎌 anime · 🎮 jeux · 🏰 disney · 🎬 films · 🎵 mix\n' +
              '> **mode** › random · mainstream · custom\n' +
              '> **type** › normal (DM) · speed (channel)\n' +
              '> **difficulte** › normal · hardcore 📻🌊🐿️\n' +
              '> **rounds** · **temps** · **points**',
            inline: false,
          },
          {
            name: '/extra',
            value:
              '> **imposteur** — trouve qui a un personnage différent (min. 3 joueurs)\n' +
              '> **motus_jour** — mot du jour, même pour tout le monde\n' +
              '> **motus_libre** — mot aléatoire à chaque partie',
            inline: false,
          },
          {
            name: 'Commandes utiles',
            value: '`/stop`  `/skip`  `/scores`  `/join`  `/leave`\n`/addanime`  `/removeanime`  `/listanime`',
            inline: false,
          },
        )
        .setFooter({ text: 'ArpoutchOpening · Bonne chance !' })
    ], ephemeral: true });
    return;
  }
});

// ─── Process handlers ─────────────────────────────────────────────────────────

process.on('unhandledRejection', (err) => {
  console.error('Erreur non gérée:', err.message);
  for (const [guildId] of activeGames) {
    safeDestroyConnection(guildId);
    activeGames.delete(guildId);
  }
  for (const [guildId] of activeImpostorGames) {
    activeImpostorGames.delete(guildId);
  }
});

process.on('uncaughtException', (err) => {
  console.error('Exception non capturée:', err.message);
  for (const [guildId] of activeGames) {
    safeDestroyConnection(guildId);
    activeGames.delete(guildId);
  }
});

client.login(TOKEN);
