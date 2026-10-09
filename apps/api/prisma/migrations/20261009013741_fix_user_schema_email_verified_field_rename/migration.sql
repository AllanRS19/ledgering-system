/*
  Warnings:

  - You are about to drop the column `isEmailverified` on the `User` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "User" DROP COLUMN "isEmailverified",
ADD COLUMN     "emailVerified" BOOLEAN NOT NULL DEFAULT false;
