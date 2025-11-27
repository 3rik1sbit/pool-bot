-- CreateTable
CREATE TABLE "Leaderboard" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "discordChannelId" TEXT
);

-- CreateTable
CREATE TABLE "Player" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "leaderboardId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "discordUserId" TEXT,
    "elo" INTEGER NOT NULL DEFAULT 1000,
    "wins" INTEGER NOT NULL DEFAULT 0,
    "losses" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "Player_leaderboardId_fkey" FOREIGN KEY ("leaderboardId") REFERENCES "Leaderboard" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Match" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "leaderboardId" TEXT NOT NULL,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "winnerId" TEXT NOT NULL,
    "loserId" TEXT NOT NULL,
    "winnerElo" INTEGER NOT NULL,
    "loserElo" INTEGER NOT NULL,
    "breakerId" TEXT,
    CONSTRAINT "Match_leaderboardId_fkey" FOREIGN KEY ("leaderboardId") REFERENCES "Leaderboard" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Match_winnerId_fkey" FOREIGN KEY ("winnerId") REFERENCES "Player" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Match_loserId_fkey" FOREIGN KEY ("loserId") REFERENCES "Player" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Leaderboard_discordChannelId_key" ON "Leaderboard"("discordChannelId");

-- CreateIndex
CREATE UNIQUE INDEX "Player_leaderboardId_discordUserId_key" ON "Player"("leaderboardId", "discordUserId");
