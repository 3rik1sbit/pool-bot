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

// Undo last match
async function undoLastMatch(message) {
  try {
    // Get matches
    const matches = await db.getData('/matches');
    
    // Check if there are any matches
    if (!matches || matches.length === 0) {
      return message.reply('No matches found to undo.');
    }
    
    // Get the last match
    const lastMatch = matches.pop();
    
    // Get winner and loser data
    const winner = await getPlayer(lastMatch.winnerId);
    const loser = await getPlayer(lastMatch.loserId);
    
    if (!winner || !loser) {
      return message.reply('Could not find players from the last match.');
    }
    
    // Save original data for the message
    const winnerName = winner.name;
    const loserName = loser.name;
    const winnerElo = winner.elo;
    const loserElo = loser.elo;
    const winnerGain = lastMatch.winnerGain;
    const loserLoss = lastMatch.loserLoss;
    
    // Revert ELO changes
    winner.elo = winnerElo - winnerGain;
    loser.elo = loserElo + loserLoss;
    
    // Revert win/loss count
    winner.wins--;
    loser.losses--;
    
    // Remove the match from player history
    winner.matches = winner.matches.filter(match => 
      match.timestamp !== lastMatch.timestamp || match.opponent !== lastMatch.loserId
    );
    
    loser.matches = loser.matches.filter(match => 
      match.timestamp !== lastMatch.timestamp || match.opponent !== lastMatch.winnerId
    );
    
    // Update players in the database
    await db.push(`/players/${winner.id}`, winner);
    await db.push(`/players/${loser.id}`, loser);
    
    // Update matches in the database
    await db.push('/matches', matches);
    
    // Send confirmation
    const embed = new EmbedBuilder()
      .setTitle('Match Reverted')
      .setColor('#FF3300')
      .setDescription(`The last match has been reverted.`)
      .addFields(
        { name: 'Reverted Match', value: `${winnerName} vs ${loserName}`, inline: false },
        { name: `${winnerName}`, value: `${winnerElo} → ${winner.elo} (-${winnerGain} ELO)`, inline: true },
        { name: `${loserName}`, value: `${loserElo} → ${loser.elo} (+${loserLoss} ELO)`, inline: true }
      )
      .setFooter({ text: 'Office Pool ELO System' });
    
    message.reply({ embeds: [embed] });
  } catch (error) {
    console.error('Error undoing last match:', error);
    message.reply('Error undoing last match.');
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
      case 'undo':
        await undoLastMatch(message);
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
      { name: '!pool undo', value: 'Revert the last recorded match (in case of mistakes)', inline: false },
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
        // Mock getPlayer for testing if necessary
        // const player = { id: id, name: user.username, elo: Math.floor(Math.random() * 300) + 800 };
        const player = await getPlayer(id); // Use your actual getPlayer function
        if (player) {
          playerList.push(player);
        } else {
          // Optional: Notify if a mentioned user isn't a registered player
          // message.channel.send(`${user.username} is not a registered player.`);
        }
      }

      if (playerList.length < 2) {
        return message.reply('Please mention at least 2 registered players for the tournament.');
      }
    } else {
      // Otherwise use all registered players
      try {
        // Mock db.getData for testing if necessary
        /*
        const players = {
          '1': { id: '1', name: 'Alice', elo: 1000 },
          '2': { id: '2', name: 'Bob', elo: 950 },
          '3': { id: '3', name: 'Charlie', elo: 1050 },
          '4': { id: '4', name: 'David', elo: 900 }
        };
        */
        const players = await db.getData('/players'); // Use your actual db access
        playerList = Object.values(players);

        if (playerList.length < 2) {
          return message.reply('Need at least 2 registered players for a tournament. Currently there are not enough players registered.');
        }
      } catch (error) {
        // Handle case where '/players' might not exist yet
        if (error.constructor.name === 'DataError') {
          return message.reply('No players registered yet. Use the register command!');
        }
        console.error('Error loading players:', error);
        return message.reply('Error loading player data. Please make sure there are registered players.');
      }
    }

    // Shuffle the players randomly
    playerList = shuffleArray(playerList);

    // Determine bracket size (next power of 2)
    const initialPlayerCount = playerList.length;
    const bracketSize = nextPowerOf2(initialPlayerCount);

    // Create matchups for the first round
    const round1Matches = [];
    let remainingPlayers = [...playerList];

    // If we don't have a perfect power of 2, some players get byes
    const byeCount = bracketSize - initialPlayerCount;

    // Generate first round matches (indices 1 to bracketSize/2)
    for (let i = 0; i < bracketSize / 2; i++) {
      const matchIndex = i + 1; // Match numbers start from 1
      if (i < byeCount) {
        // This match is a bye - player advances automatically
        if (remainingPlayers.length > 0) {
          round1Matches.push({
            matchNumber: matchIndex,
            player1: remainingPlayers.shift(),
            player2: null, // Indicates a bye
            breaker: 'player1' // Breaker doesn't matter for a bye, but assign for consistency
          });
        } else {
          // This case should ideally not happen with correct byeCount logic
          console.error("Error creating bye match: No remaining players.");
        }
      } else {
        // Regular match between two players
        if (remainingPlayers.length >= 2) {
          round1Matches.push({
            matchNumber: matchIndex,
            player1: remainingPlayers.shift(),
            player2: remainingPlayers.shift(),
            // Randomly assign who breaks first
            breaker: Math.random() < 0.5 ? 'player1' : 'player2'
          });
        } else {
          // This case should ideally not happen if logic is correct
          console.error("Error creating regular match: Not enough remaining players.");
        }
      }
    }

    // Generate a Swedish tournament name (assuming this function is defined as per previous request)
    const tournamentName = generateSwedishPoolTournamentName().toUpperCase(); // Using the uppercase version

    // Create the tournament bracket embed
    const embed = new EmbedBuilder()
        .setTitle(`🏆 ${tournamentName} 🏆`)
        .setColor('#FF9900')
        .setDescription(`Tournament with ${initialPlayerCount} players.\nBracket Size: ${bracketSize}. ${byeCount > 0 ? `(${byeCount} players receive first-round byes)` : ''}`)
        .setFooter({ text: 'Office Pool Tournament | Göteborg Edition' }); // Adjusted footer text

    // --- Add field for each FIRST ROUND match ---
    embed.addFields({ name: '--- Round 1 ---', value: '\u200B' }); // Separator for clarity
    round1Matches.forEach((match) => {
      if (match.player2) {
        // Regular match
        const breakerName = match.breaker === 'player1' ? match.player1.name : match.player2.name;
        embed.addFields({
          name: `Match ${match.matchNumber}`,
          value: `**${match.player1.name}** (${match.player1.elo} ELO) vs **${match.player2.name}** (${match.player2.elo} ELO)\n*${breakerName} breaks first*`,
          inline: false
        });
      } else if (match.player1) {
        // Bye match
        embed.addFields({
          name: `Match ${match.matchNumber}`,
          value: `**${match.player1.name}** (${match.player1.elo} ELO) - *Bye to next round*`,
          inline: false
        });
      }
      // Handle potential errors where a match object might be malformed (optional)
      else {
        console.error(`Malformed match object encountered: ${JSON.stringify(match)}`);
        embed.addFields({ name: `Match ${match.matchNumber || 'N/A'}`, value: 'Error generating match details.', inline: false });
      }
    });

    // --- Calculate and Add Subsequent Match Break Info ---
    const subsequentBreaksInfo = [];
    let currentMatchNumber = round1Matches.length; // Start numbering after round 1 matches
    let matchesInPreviousRound = round1Matches.length; // Number of matches feeding into the next round
    let roundCounter = 2;
    let prereqRoundStartMatchNumber = 1;

    // Loop through subsequent rounds until only the final match remains
    while (matchesInPreviousRound > 1) {
      const matchesInCurrentRound = matchesInPreviousRound / 2;
      const roundTitle = `--- Round ${roundCounter} ${matchesInCurrentRound === 1 ? '(Final)' : matchesInCurrentRound === 2 ? '(Semi-Finals)' : ''} ---`;
      subsequentBreaksInfo.push(`\n**${roundTitle}**`); // Add round title

      for (let i = 0; i < matchesInCurrentRound; i++) {
        currentMatchNumber++;
        // Calculate the match numbers from the previous round that feed into this one
        // The indices are offset by the total matches before the previous round started.

	const prereqMatch1Index = prereqRoundStartMatchNumber + (2 * i);
        const prereqMatch2Index = prereqRoundStartMatchNumber + (2 * i) + 1;
        
	// Determine the breaker based on the lower prerequisite match index
        const breakerMatchIndex = prereqMatch1Index; // Winner of the first listed prerequisite match breaks

        const matchDescription = `Match ${currentMatchNumber}: Winner M${prereqMatch1Index} vs Winner M${prereqMatch2Index}\n*Winner of Match ${breakerMatchIndex} breaks first*`;
        subsequentBreaksInfo.push(matchDescription);
      }

      // Update prereqRoundStartMatchNumber for the NEXT iteration of the while loop.
      // The round we just processed will be the "previous round" for the next one.
      prereqRoundStartMatchNumber = currentMatchNumber - matchesInCurrentRound + 1;    
      matchesInPreviousRound = matchesInCurrentRound; // Update for the next loop iteration
      roundCounter++;
    }

    // Add the subsequent break info as a single field if there are subsequent matches
    if (subsequentBreaksInfo.length > 0) {
      // Join the array into a single string, respecting Discord's field value limit (1024 chars)
      let subsequentBreaksValue = subsequentBreaksInfo.join('\n');
      if (subsequentBreaksValue.length > 1024) {
        subsequentBreaksValue = subsequentBreaksValue.substring(0, 1021) + '...'; // Truncate if too long
      }
      embed.addFields({
        name: 'Subsequent Rounds & Breaks',
        value: subsequentBreaksValue,
        inline: false
      });
    }
    // --- End of Subsequent Match Info ---

    // Send the embed
    message.reply({ embeds: [embed] });

  } catch (error) {
    console.error('Error generating tournament:', error);
    message.reply(`An error occurred while generating the tournament bracket: ${error.message}`);
  }
}

// Helper function to pick a random element from an array
function randomChoice(arr) {
  if (!arr || arr.length === 0) {
    return ""; // Return empty string if array is empty or undefined
  }
  return arr[Math.floor(Math.random() * arr.length)];
}

// Generate an *UPPERCASE* punny Swedish pool tournament name focused on West Coast / Workplace
function generateSwedishPoolTournamentName() {
  const prefixes = [
    "Biljard", "Pool", "Kö", "Kritmagi", "Boll", "Klot", "Spel", "Hål", "Prick",
    "Rackare", "Klack", "Kant", "Stöt", "Krita", "Triangel", "Grön", "Snooker",
    "Vall", "Ficka", "Sänk", "Effekt", "Massé", "Vit", "Svart"
  ];

  const suffixes = [
    "mästerskapet", "turneringen", "kampen", "utmaningen", "duellen", "spelandet",
    "striden", "fajten", "tävlingen", "bataljen", "kalaset", "festen", "smällen",
    "stöten", "bragden", "träffen", "mötet", "drabbningen", "uppgörelsen",
    "ligan", "cupen", "serien", "racet", "jippot", "spektaklet", "finalen", "derbyt"
  ];

  const adjectives = [
    "Kungliga", "Magnifika", "Legendariska", "Otroliga", "Galna", "Vilda", "Episka",
    "Fantastiska", "Häftiga", "Glada", "Mäktiga", "Snabba", "Precisa", "Strategiska",
    "Oförglömliga", "Prestigefyllda", "Heta", "Svettiga", "Spännande", "Årliga",
    "Knivskarpa", "Ostoppbara", "Fruktade", "Ökända", "Hemliga", "Officiella",
    "Inofficiella", "Kollegiala", "Obarmhärtiga", "Avgörande"
  ];

  const puns = [
    "Kö-los Före Resten", "Boll-i-gare Än Andra", "Stöt-ande Bra Spel",
    "Hål-i-ett Sällskap", "Krit-iskt Bra", "Rack-a Ner På Motståndaren",
    "Klot-rent Mästerskap", "Kant-astiskt Spel", "Prick-säkra Spelare",
    "Tri-angel-utmaningen", "Kö-a För Segern", "Boll-virtuoserna",
    "Grön-saksodlare På Bordet", "Snooker-sväng Med Stil",
    "Stöt-i-rätt-hålet", "Klack-sparkarnas Kamp", "Krit-a På Näsan",
    "Rena Sänk-ningen", "Rack-a-rökare", "Helt Vall-galet",
    "Fick-lampornas Kamp", "Effekt-sökarna", "Värsta Vit-ingarna",
    "Svart-listade Spelare", "Triangel-dramat", "Krit-erianerna",
    "Boll-änska Ligan", "Måndags-Massé", "Fredags-Fajten", "Team-Stöten",
    "Projekt Pool", "Excel-lent Spel", "Kod & Klot", "Kaffe & Krita",
    "Fika & Fickor", "Vall-öften", "Stöt-tålig Personal",
    "Inga Sura Miner, Bara Sura Stötar"
  ];

  const locations = [
    "i Kungsbacka", "från Kungsbackaskogarna", "vid Kungsbackaån",
    "på Kungsbacka Torg", "i Göteborg", "på Hisingen", "vid Älvsborgsbron",
    "i Majorna", "i Götet", "på Västkusten", "i Halland", "vid Tjolöholm",
    "i Onsala", "i Fjärås", "i Anneberg", "runt Liseberg", "vid Feskekörka",
    "i Kontoret", "på Jobbet", "i Fikarummet", "vid Kaffeautomaten",
    "i Mötesrummet", "vid Skrivaren", "på Lagret", "i Källaren"
  ];

  const nameStyles = [
    () => `Det ${randomChoice(adjectives)} ${randomChoice(prefixes)}${randomChoice(suffixes)}`,
    () => `${randomChoice(prefixes)}${randomChoice(suffixes)} ${randomChoice(locations)}`,
    () => `${randomChoice(puns)}`,
    () => `${new Date().getFullYear()} års ${randomChoice(prefixes)}${randomChoice(suffixes)}`,
    () => `${randomChoice(prefixes)}-${randomChoice(prefixes)} ${randomChoice(suffixes)}`,
    () => `Den ${randomChoice(adjectives)} ${randomChoice(puns)}`,
    () => `${randomChoice(puns)} ${randomChoice(locations)}`
  ];

  // Generate the name using a random style
  const generatedName = randomChoice(nameStyles)();

  // *** Convert the entire name to uppercase before returning ***
  return generatedName.toUpperCase();
}

// When the client is ready, run this code (only once)
client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await initializeDatabase();
});

// Login to Discord with your client's token
client.login(process.env.TOKEN);
