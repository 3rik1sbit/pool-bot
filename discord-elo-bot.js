// Discord Pool ELO Bot
// Required packages: discord.js, dotenv, node-json-db

// Install packages with:
// npm install discord.js dotenv node-json-db

require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { JsonDB, Config } = require('node-json-db');

// Create a new client instance
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ]
});

// Initialize the database
const db = new JsonDB(new Config("poolEloDatabase", true, false, '/'));

// Default ELO settings
const DEFAULT_ELO = 1000;
const K_FACTOR = 32; // How quickly ratings change

// Initialize database if needed
async function initializeDatabase() {
  try {
    await db.getData("/players");
  } catch (error) {
    // Players collection doesn't exist yet, create it
    await db.push("/players", {});
    console.log("Database initialized with empty players collection");
  }

  try {
    await db.getData("/matches");
  } catch (error) {
    // Matches collection doesn't exist yet, create it
    await db.push("/matches", []);
    console.log("Database initialized with empty matches collection");
  }
}

// Calculate new ELO ratings after a match
function calculateElo(winnerElo, loserElo) {
  // Calculate expected scores
  const expectedWinner = 1 / (1 + Math.pow(10, (loserElo - winnerElo) / 400));
  const expectedLoser = 1 / (1 + Math.pow(10, (winnerElo - loserElo) / 400));
  
  // Calculate new ratings
  const newWinnerElo = Math.round(winnerElo + K_FACTOR * (1 - expectedWinner));
  const newLoserElo = Math.round(loserElo + K_FACTOR * (0 - expectedLoser));
  
  return {
    newWinnerElo,
    newLoserElo,
    winnerGain: newWinnerElo - winnerElo,
    loserLoss: loserElo - newLoserElo
  };
}

// Helper function to get player data
async function getPlayer(playerId) {
  try {
    return await db.getData(`/players/${playerId}`);
  } catch (error) {
    return null;
  }
}

// Process commands
client.on('messageCreate', async message => {
  // Ignore messages from bots
  if (message.author.bot) return;
  
  // Check if message starts with !pool
  if (!message.content.startsWith('!pool')) return;
  
  const args = message.content.slice(6).trim().split(/ +/);
  const command = args.shift().toLowerCase();
  
  try {
    switch (command) {
      case 'register':
        await registerPlayer(message, args);
        break;
      case 'match':
        await recordMatch(message, args);
        break;
      case 'rankings':
        await showRankings(message);
        break;
      case 'stats':
        await showPlayerStats(message, args);
        break;
      case 'tournament':
        await generateTournament(message, args);
        break;
      case 'help':
        await showHelp(message);
        break;
      default:
        message.reply('Unknown command. Type `!pool help` for a list of commands.');
    }
  } catch (error) {
    console.error('Error handling command:', error);
    message.reply('There was an error processing your command.');
  }
});

// Register a new player
async function registerPlayer(message, args) {
  if (args.length < 1) {
    return message.reply('Please provide a name. Usage: `!pool register YourName`');
  }
  
  const playerName = args.join(' ');
  const playerId = message.author.id;
  
  const existingPlayer = await getPlayer(playerId);
  
  if (existingPlayer) {
    return message.reply(`You are already registered as ${existingPlayer.name}.`);
  }
  
  // Create new player
  const playerData = {
    id: playerId,
    name: playerName,
    elo: DEFAULT_ELO,
    wins: 0,
    losses: 0,
    matches: []
  };
  
  await db.push(`/players/${playerId}`, playerData);
  
  message.reply(`Successfully registered as **${playerName}** with an initial ELO of ${DEFAULT_ELO}.`);
}

// Record match result
async function recordMatch(message, args) {
  if (args.length < 1) {
    return message.reply('Please mention the player you defeated. Usage: `!pool match @opponent`');
  }
  
  const winnerId = message.author.id;
  const winner = await getPlayer(winnerId);
  
  if (!winner) {
    return message.reply('You need to register first with `!pool register YourName`.');
  }
  
  // Try to get the loser from the mention
  const mention = message.mentions.users.first();
  if (!mention) {
    return message.reply('Please mention the player you defeated.');
  }
  
  const loserId = mention.id;
  
  if (winnerId === loserId) {
    return message.reply('You cannot play against yourself.');
  }
  
  const loser = await getPlayer(loserId);
  if (!loser) {
    return message.reply(`The player you mentioned is not registered yet.`);
  }
  
  // Calculate new ELO ratings
  const { newWinnerElo, newLoserElo, winnerGain, loserLoss } = calculateElo(winner.elo, loser.elo);
  
  // Update winner data
  winner.elo = newWinnerElo;
  winner.wins++;
  winner.matches.push({
    opponent: loserId,
    result: 'win',
    eloChange: winnerGain,
    timestamp: new Date().toISOString()
  });
  
  // Update loser data
  loser.elo = newLoserElo;
  loser.losses++;
  loser.matches.push({
    opponent: winnerId,
    result: 'loss',
    eloChange: -loserLoss,
    timestamp: new Date().toISOString()
  });
  
  // Save match in the matches collection
  const matchData = {
    winnerId,
    loserId,
    winnerElo: newWinnerElo,
    loserElo: newLoserElo,
    winnerGain,
    loserLoss,
    timestamp: new Date().toISOString()
  };
  
  const matches = await db.getData('/matches');
  matches.push(matchData);
  
  // Update the database
  await db.push(`/players/${winnerId}`, winner);
  await db.push(`/players/${loserId}`, loser);
  await db.push('/matches', matches);
  
  // Send confirmation
  const embed = new EmbedBuilder()
    .setTitle('Match Result Recorded')
    .setColor('#00FF00')
    .addFields(
      { name: 'Winner', value: `${winner.name} (${newWinnerElo} ELO, +${winnerGain})`, inline: false },
      { name: 'Loser', value: `${loser.name} (${newLoserElo} ELO, -${loserLoss})`, inline: false }
    )
    .setFooter({ text: 'Office Pool ELO System' });
  
  message.reply({ embeds: [embed] });
}

// Show current rankings
async function showRankings(message) {
  try {
    const players = await db.getData('/players');
    
    if (Object.keys(players).length === 0) {
      return message.reply('No players are registered yet.');
    }
    
    // Convert to array and sort by ELO
    const rankedPlayers = Object.values(players).sort((a, b) => b.elo - a.elo);
    
    const embed = new EmbedBuilder()
      .setTitle('Office Pool Rankings')
      .setColor('#0099FF')
      .setFooter({ text: 'Office Pool ELO System' });
    
    // Add top players to the embed
    rankedPlayers.slice(0, 10).forEach((player, index) => {
      embed.addFields({
        name: `#${index + 1} ${player.name}`,
        value: `ELO: ${player.elo} | W: ${player.wins} | L: ${player.losses}`,
        inline: false
      });
    });
    
    message.reply({ embeds: [embed] });
  } catch (error) {
    console.error('Error showing rankings:', error);
    message.reply('Error retrieving rankings.');
  }
}

// Show player stats
async function showPlayerStats(message, args) {
  let playerId;
  
  if (message.mentions.users.size > 0) {
    // Get stats for mentioned user
    playerId = message.mentions.users.first().id;
  } else {
    // Get stats for message author
    playerId = message.author.id;
  }
  
  const player = await getPlayer(playerId);
  
  if (!player) {
    return message.reply('This player is not registered yet.');
  }
  
  const embed = new EmbedBuilder()
    .setTitle(`${player.name}'s Stats`)
    .setColor('#0099FF')
    .addFields(
      { name: 'ELO Rating', value: `${player.elo}`, inline: true },
      { name: 'Wins', value: `${player.wins}`, inline: true },
      { name: 'Losses', value: `${player.losses}`, inline: true },
      { name: 'Win Rate', value: `${player.wins + player.losses > 0 ? Math.round((player.wins / (player.wins + player.losses)) * 100) : 0}%`, inline: true }
    )
    .setFooter({ text: 'Office Pool ELO System' });
  
  // Add recent matches
  if (player.matches.length > 0) {
    const recentMatches = player.matches.slice(-5).reverse();
    let matchesText = '';
    
    for (const match of recentMatches) {
      const opponent = await getPlayer(match.opponent);
      const opponentName = opponent ? opponent.name : 'Unknown';
      const result = match.result === 'win' ? 'Won' : 'Lost';
      const eloChange = match.eloChange > 0 ? `+${match.eloChange}` : match.eloChange;
      const date = new Date(match.timestamp).toLocaleDateString();
      
      matchesText += `${result} vs ${opponentName} (${eloChange}) - ${date}\n`;
    }
    
    embed.addFields({ name: 'Recent Matches', value: matchesText || 'No matches yet', inline: false });
  }
  
  message.reply({ embeds: [embed] });
}

// Show help message
async function showHelp(message) {
  const embed = new EmbedBuilder()
    .setTitle('Office Pool ELO Bot Commands')
    .setColor('#0099FF')
    .setDescription('Here are the available commands:')
    .addFields(
      { name: '!pool register [name]', value: 'Register yourself as a player', inline: false },
      { name: '!pool match @opponent', value: 'Record that you won a match against the mentioned player', inline: false },
      { name: '!pool rankings', value: 'Show the current player rankings', inline: false },
      { name: '!pool stats', value: 'Show your stats or the stats of a mentioned player', inline: false },
      { name: '!pool tournament [@player1 @player2...]', value: 'Generate a tournament bracket with mentioned players or all players if none mentioned', inline: false },
      { name: '!pool help', value: 'Show this help message', inline: false }
    )
    .setFooter({ text: 'Office Pool ELO System' });
  
  message.reply({ embeds: [embed] });
}

// Generate tournament bracket
async function generateTournament(message, args) {
  try {
    // Helper function to get next power of 2
    function nextPowerOf2(n) {
      let power = 1;
      while (power < n) {
        power *= 2;
      }
      return power;
    }
    
    // Helper function to shuffle array (Fisher-Yates algorithm)
    function shuffleArray(array) {
      const newArray = [...array];
      for (let i = newArray.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [newArray[i], newArray[j]] = [newArray[j], newArray[i]];
      }
      return newArray;
    }
    
    let playerList = [];
    
    // If player mentions are provided, use them
    if (message.mentions.users.size > 0) {
      for (const [id, user] of message.mentions.users) {
        const player = await getPlayer(id);
        if (player) {
          playerList.push(player);
        }
      }
      
      if (playerList.length < 2) {
        return message.reply('Please mention at least 2 registered players for the tournament.');
      }
    } else {
      // Otherwise use all registered players
      try {
        const players = await db.getData('/players');
        playerList = Object.values(players);
        
        if (playerList.length < 2) {
          return message.reply('Need at least 2 registered players for a tournament. Currently there are not enough players registered.');
        }
      } catch (error) {
        console.error('Error loading players:', error);
        return message.reply('Error loading player data. Please make sure there are registered players.');
      }
    }
    
    // Shuffle the players randomly
    playerList = shuffleArray(playerList);
    
    // Determine bracket size (next power of 2)
    const bracketSize = nextPowerOf2(playerList.length);
    
    // Create matchups
    const matches = [];
    let remainingPlayers = [...playerList];
    
    // If we don't have a perfect power of 2, some players get byes
    const byeCount = bracketSize - playerList.length;
    
    // First round with byes
    for (let i = 0; i < bracketSize / 2; i++) {
      if (i < byeCount) {
        // This match is a bye - player advances automatically
        if (remainingPlayers.length > 0) {
          matches.push({
            player1: remainingPlayers.shift(),
            player2: null,
            breaker: Math.random() < 0.5 ? 'player1' : 'player2'
          });
        }
      } else {
        // Regular match between two players
        if (remainingPlayers.length >= 2) {
          matches.push({
            player1: remainingPlayers.shift(),
            player2: remainingPlayers.shift(),
            breaker: Math.random() < 0.5 ? 'player1' : 'player2'
          });
        }
      }
    }
    
    // Generate a Swedish tournament name
    const tournamentName = generateSwedishPoolTournamentName();
    
    // Create the tournament bracket embed
    const embed = new EmbedBuilder()
      .setTitle(`🏆 ${tournamentName} 🏆`)
      .setColor('#FF9900')
      .setDescription(`Tournament with ${playerList.length} players\n${byeCount > 0 ? `(${byeCount} players receive first-round byes)` : ''}`)
      .setFooter({ text: 'Office Pool Tournament | Randomly generated matchups' });
    
    // Add field for each match
    matches.forEach((match, index) => {
      if (match.player2) {
        // Regular match
        const breakerName = match.breaker === 'player1' ? match.player1.name : match.player2.name;
        embed.addFields({
          name: `Match ${index + 1}`,
          value: `**${match.player1.name}** (${match.player1.elo} ELO) vs **${match.player2.name}** (${match.player2.elo} ELO)\n*${breakerName} breaks first*`,
          inline: false
        });
      } else {
        // Bye match
        embed.addFields({
          name: `Match ${index + 1}`,
          value: `**${match.player1.name}** (${match.player1.elo} ELO) - *Bye to next round*`,
          inline: false
        });
      }
    });
    
    message.reply({ embeds: [embed] });
  } catch (error) {
    console.error('Error generating tournament:', error);
    message.reply(`Error generating tournament bracket: ${error.message}`);
  }
}

// Helper function to shuffle array (Fisher-Yates algorithm)
function shuffleArray(array) {
  const newArray = [...array];
  for (let i = newArray.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [newArray[i], newArray[j]] = [newArray[j], newArray[i]];
  }
  return newArray;
}

// Generate a punny Swedish pool tournament name
function generateSwedishPoolTournamentName() {
  const prefixes = [
    "Biljard", "Pool", "Kö", "Kritmagi", "Boll", "Klot", "Spel", "Hål", "Prick", 
    "Rackare", "Klack", "Kant", "Stöt", "Krita", "Triangel", "Grön", "Snooker"
  ];
  
  const suffixes = [
    "mästerskapet", "turneringen", "kampen", "utmaningen", "duellen", "spelandet",
    "striden", "fajten", "tävlingen", "bataljen", "kalaset", "festen", "smällen",
    "stöten", "bragden", "träffen", "mötet", "drabbningen", "uppgörelsen"
  ];
  
  const adjectives = [
    "Kungliga", "Magnifika", "Legendariska", "Otroliga", "Galna", "Vilda", "Episka",
    "Fantastiska", "Häftiga", "Glada", "Mäktiga", "Snabba", "Precisa", "Strategiska",
    "Oförglömliga", "Prestigefyllda", "Heta", "Svettiga", "Spännande", "Årliga"
  ];
  
  const puns = [
    "Kö-los Före Resten", "Boll-i-gare Än Andra", "Stöt-ande Bra Spel",
    "Hål-i-ett Sällskap", "Krit-iskt Bra", "Rack-a Ner På Motståndaren",
    "Klot-rent Mästerskap", "Kant-astiskt Spel", "Prick-säkra Spelare",
    "Tri-angel-utmaningen", "Kö-a För Segern", "Boll-virtuoserna",
    "Grön-saksodlare På Bordet", "Snooker-sväng Med Stil",
    "Stöt-i-rätt-hålet", "Klack-sparkarnas Kamp", "Krit-a På Näsan"
  ];
  
  const locations = [
    "i Stockholm", "på Vasa", "i Göteborg", "i Uppsala", "på Östermalm",
    "i Gamla Stan", "på Söder", "i Malmö", "i Norrland", "vid Vättern",
    "i Kontoret", "på Jobbet", "i Fikarummet", "vid Kaffeautomaten"
  ];
  
  // Different name generation styles
  const nameStyles = [
    // Standard format: "Det [Adjective] [Prefix][Suffix]"
    () => `Det ${randomChoice(adjectives)} ${randomChoice(prefixes)}${randomChoice(suffixes)}`,
    
    // Location format: "[Prefix][Suffix] [location]"
    () => `${randomChoice(prefixes)}${randomChoice(suffixes)} ${randomChoice(locations)}`,
    
    // Punny format: "[Punny phrase]"
    () => `${randomChoice(puns)}`,
    
    // Year format: "[Year] års [Prefix][Suffix]"
    () => `${new Date().getFullYear()} års ${randomChoice(prefixes)}${randomChoice(suffixes)}`,
    
    // Compound format: "[Prefix]-[Prefix] [Suffix]"
    () => `${randomChoice(prefixes)}-${randomChoice(prefixes)} ${randomChoice(suffixes)}`
  ];
  
  return randomChoice(nameStyles)();
}

// Helper function to choose random element from array
function randomChoice(array) {
  return array[Math.floor(Math.random() * array.length)];
}

// When the client is ready, run this code (only once)
client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await initializeDatabase();
});

// Login to Discord with your client's token
client.login(process.env.TOKEN);
