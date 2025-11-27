require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function seedAllSeasons() {
    console.log("🌱 Seeding/Fixing ALL Previous Seasons...");

    // 1. Get the "Legacy" Board
    const legacyBoard = await prisma.leaderboard.findFirst({ 
        where: { name: "Office Pool (Legacy)" } 
    });
    if (!legacyBoard) throw new Error("Legacy board not found! Run migration first.");

    // 2. Create a Map of Legacy UUIDs -> Player Details
    // We need this because the Match object only has the Legacy UUID of the breaker, 
    // and we need to translate that to a Discord ID to find them in the Season.
    console.log("   Loading legacy player map...");
    const legacyPlayers = await prisma.player.findMany({
        where: { leaderboardId: legacyBoard.id }
    });
    const legacyPlayerMap = new Map();
    legacyPlayers.forEach(p => legacyPlayerMap.set(p.id, p));

    // 3. Fetch ALL matches from history
    const allMatches = await prisma.match.findMany({
        where: { leaderboardId: legacyBoard.id },
        orderBy: { timestamp: 'asc' },
        include: { winner: true, loser: true }
    });

    console.log(`📄 Found ${allMatches.length} total matches in history.`);

    // 4. Group matches by "YYYY-MM"
    const seasons = {};
    for (const match of allMatches) {
        const date = new Date(match.timestamp);
        const key = `${date.getFullYear()}-${(date.getMonth() + 1).toString().padStart(2, '0')}`;
        if (!seasons[key]) seasons[key] = [];
        seasons[key].push(match);
    }

    // 5. Iterate through seasons
    const sortedKeys = Object.keys(seasons).sort();
    
    for (const seasonKey of sortedKeys) {
        const seasonName = `Pool ${seasonKey}`;
        const matchesInSeason = seasons[seasonKey];
        
        console.log(`\n📅 Processing Season: ${seasonName} (${matchesInSeason.length} matches)`);

        // Get/Create Season Board
        let seasonBoard = await prisma.leaderboard.findFirst({ where: { name: seasonName } });
        if (!seasonBoard) {
            seasonBoard = await prisma.leaderboard.create({ data: { name: seasonName, gameType: 'pool' } });
            console.log(`   ✨ Created new leaderboard: ${seasonName}`);
        }

        // Local cache for this season's players
        const seasonPlayerCache = new Map();

        for (const m of matchesInSeason) {
            // Helper to get/create player for THIS season
            const getSeasonPlayer = async (legacyPlayer) => {
                if (!legacyPlayer) return null;
                if (seasonPlayerCache.has(legacyPlayer.discordUserId)) {
                    return seasonPlayerCache.get(legacyPlayer.discordUserId);
                }

                let sPlayer = await prisma.player.findFirst({
                    where: { leaderboardId: seasonBoard.id, discordUserId: legacyPlayer.discordUserId }
                });

                if (!sPlayer) {
                    sPlayer = await prisma.player.create({
                        data: { leaderboardId: seasonBoard.id, discordUserId: legacyPlayer.discordUserId, name: legacyPlayer.name, elo: 1000 }
                    });
                }
                seasonPlayerCache.set(legacyPlayer.discordUserId, sPlayer);
                return sPlayer;
            };

            const sWinner = await getSeasonPlayer(m.winner);
            const sLoser = await getSeasonPlayer(m.loser);

            // --- RESOLVE BREAKER ---
            let sBreaker = null;
            if (m.breakerId) {
                const legacyBreaker = legacyPlayerMap.get(m.breakerId);
                if (legacyBreaker) {
                    sBreaker = await getSeasonPlayer(legacyBreaker);
                }
            }

            // Check if match exists
            const existingMatch = await prisma.match.findFirst({
                where: { 
                    leaderboardId: seasonBoard.id, 
                    timestamp: m.timestamp,
                    winnerId: sWinner.id, 
                    loserId: sLoser.id 
                }
            });

            if (existingMatch) {
                // FIX: If match exists but is missing the breaker, update it!
                if (!existingMatch.breakerId && sBreaker) {
                    await prisma.match.update({
                        where: { id: existingMatch.id },
                        data: { breakerId: sBreaker.id }
                    });
                    // process.stdout.write("B"); // Visual indicator for fixed breaker
                }
                continue;
            }

            // ... (ELO Logic identical to before) ...
            const K_FACTOR = 32;
            const expectedWinner = 1 / (1 + Math.pow(10, (sLoser.elo - sWinner.elo) / 400));
            const expectedLoser = 1 / (1 + Math.pow(10, (sWinner.elo - sLoser.elo) / 400));
            
            const newWinnerElo = Math.round(sWinner.elo + K_FACTOR * (1 - expectedWinner));
            const newLoserElo = Math.round(sLoser.elo + K_FACTOR * (0 - expectedLoser));
            const gain = newWinnerElo - sWinner.elo;

            // Update Players
            const updatedWinner = await prisma.player.update({ where: { id: sWinner.id }, data: { elo: newWinnerElo, wins: { increment: 1 } } });
            const updatedLoser = await prisma.player.update({ where: { id: sLoser.id }, data: { elo: newLoserElo, losses: { increment: 1 } } });

            seasonPlayerCache.set(m.winner.discordUserId, updatedWinner);
            seasonPlayerCache.set(m.loser.discordUserId, updatedLoser);

            // Create Match
            await prisma.match.create({
                data: {
                    leaderboardId: seasonBoard.id,
                    timestamp: m.timestamp,
                    winnerId: updatedWinner.id,
                    loserId: updatedLoser.id,
                    winnerElo: newWinnerElo,
                    loserElo: newLoserElo,
                    eloChange: gain,
                    breakerId: sBreaker ? sBreaker.id : null // <--- ADDED THIS
                }
            });
        }
        console.log(`   ✅ Processed ${seasonName}`);
    }
    console.log("\n🎉 All seasons seeded & breakers fixed!");
}

seedAllSeasons()
    .catch(e => console.error(e))
    .finally(async () => await prisma.$disconnect());
