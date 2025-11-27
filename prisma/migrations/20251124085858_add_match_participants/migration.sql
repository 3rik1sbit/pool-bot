-- CreateTable
CREATE TABLE "MatchParticipant" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "matchId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "startElo" INTEGER NOT NULL,
    "eloChange" INTEGER NOT NULL,
    CONSTRAINT "MatchParticipant_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "MatchParticipant_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Leaderboard" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "gameType" TEXT NOT NULL,
    "scoringType" TEXT NOT NULL DEFAULT '1v1',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "discordChannelId" TEXT
);
INSERT INTO "new_Leaderboard" ("createdAt", "discordChannelId", "gameType", "id", "name") SELECT "createdAt", "discordChannelId", "gameType", "id", "name" FROM "Leaderboard";
DROP TABLE "Leaderboard";
ALTER TABLE "new_Leaderboard" RENAME TO "Leaderboard";
CREATE UNIQUE INDEX "Leaderboard_discordChannelId_key" ON "Leaderboard"("discordChannelId");
CREATE TABLE "new_Match" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "leaderboardId" TEXT NOT NULL,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "winnerId" TEXT,
    "loserId" TEXT,
    "winnerElo" INTEGER,
    "loserElo" INTEGER,
    "eloChange" INTEGER NOT NULL DEFAULT 0,
    "breakerId" TEXT,
    CONSTRAINT "Match_leaderboardId_fkey" FOREIGN KEY ("leaderboardId") REFERENCES "Leaderboard" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Match_winnerId_fkey" FOREIGN KEY ("winnerId") REFERENCES "Player" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Match_loserId_fkey" FOREIGN KEY ("loserId") REFERENCES "Player" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Match" ("breakerId", "eloChange", "id", "leaderboardId", "loserElo", "loserId", "timestamp", "winnerElo", "winnerId") SELECT "breakerId", "eloChange", "id", "leaderboardId", "loserElo", "loserId", "timestamp", "winnerElo", "winnerId" FROM "Match";
DROP TABLE "Match";
ALTER TABLE "new_Match" RENAME TO "Match";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
