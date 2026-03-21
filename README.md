# 🎵 Guess The Opening — Bot Discord

Bot Discord pour deviner les openings d'animes !

## Installation

```bash
npm install
```

## Configuration

1. Va sur https://discord.com/developers/applications
2. Crée une nouvelle application → Bot
3. Copie le token
4. Colle-le dans le fichier `.env` :
```
DISCORD_TOKEN=ton_token_ici
```

## Lancer le bot

```bash
node index.js
```

## Commandes

| Commande | Description |
|----------|-------------|
| `!guess` | Lance une partie (5 rounds, 30s, 1pt) |
| `!guess 10` | 10 rounds |
| `!guess 10 45` | 10 rounds, 45s par round |
| `!guess 10 45 3` | 10 rounds, 45s, 3pts par bonne réponse |
| `!stop` | Arrête la partie |
| `!scores` | Scores de la partie en cours |
| `!help` | Affiche l'aide |

## Comment ça marche

1. Rejoins un salon vocal
2. Tape `!guess`
3. Le bot joue un extrait d'opening (~30s depuis Deezer)
4. Écris le nom de **l'anime** OU de **la chanson** dans le chat
5. Le bot accepte les fautes de frappe et les raccourcis (ex: "jojo" pour "JoJo's Bizarre Adventure")
6. À la fin du countdown, le bot révèle la réponse et met à jour les scores
7. À la fin de la partie, le classement final s'affiche !

## Intents Discord requis

Dans le portail développeur, active :
- `MESSAGE CONTENT INTENT`
- `SERVER MEMBERS INTENT`
- `PRESENCE INTENT`

## Permissions bot requises

- Read Messages / View Channels
- Send Messages
- Add Reactions
- Connect (vocal)
- Speak (vocal)
