require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const JSON_DB_PATH = path.join(__dirname, 'poolDB', 'poolEloDatabase.json');

async function migrate() {
    console.log('🚀 Starting migration...');

    if (!fs.existsSync(JSON_DB_PATH)) {
        console.error('❌ Could not find poolEloDatabase.json');
        return;
    }

    const rawData = fs.readFileSync(JSON_DB_PATH, 'utf-8');
    const jsonData = JSON.parse(rawData);

    console.log(`📄 Found ${Object.keys(jsonData.players || {}).length} players and ${(jsonData.matches || []).length} matches.`);

    // 1. Create Legacy Leaderboard
    const leaderboard = await prisma.leaderboard.create({
        data: {
            name: "Office Pool (Legacy)",
            gameType: "pool",
            discordChannelId: process.env.NOTIFICATION_CHANNEL_ID || null 
        }
    });
    console.log(`🏆 Created Leaderboard: "${leaderboard.name}"`);

    // 2. Migrate Players
    const discordIdToPrismaId = new Map();
    const players = jsonData.players || {};

    for (const discordId in players) {
        const oldPlayer = players[discordId];
        const newPlayer = await prisma.player.create({
            data: {
                leaderboardId: leaderboard.id,
                name: oldPlayer.name,
                discordUserId: discordId, 
                elo: oldPlayer.elo,
                wins: oldPlayer.wins,
                losses: oldPlayer.losses
            }
        });
        discordIdToPrismaId.set(discordId, newPlayer.id);
    }

    // 3. Migrate Matches
    const matches = jsonData.matches || [];
    let matchCount = 0;

    for (const match of matches) {
        const winnerUUID = discordIdToPrismaId.get(match.winnerId);
        const loserUUID = discordIdToPrismaId.get(match.loserId);

        if (winnerUUID && loserUUID) {
            await prisma.match.create({
                data: {
                    leaderboardId: leaderboard.id,
                    timestamp: new Date(match.timestamp),
                    winnerId: winnerUUID,
                    loserId: loserUUID,
                    winnerElo: match.winnerElo,
                    loserElo: match.loserElo,
                    // vvv MAP THE OLD GAIN HERE vvv
                    eloChange: match.winnerGain || 0, 
                    breakerId: match.breakerId ? discordIdToPrismaId.get(match.breakerId) : null
                }
            });
            matchCount++;
        }
    }

    console.log(`✅ Migration Complete! Imported ${matchCount} matches.`);
}

migrate()
    .catch((e) => { console.error(e); process.exit(1); })
    .finally(async () => { await prisma.$disconnect(); });
