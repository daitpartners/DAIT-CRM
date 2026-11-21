-- AlterTable
ALTER TABLE "contacts" ADD COLUMN     "about" TEXT,
ADD COLUMN     "education" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "experience" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "headline" TEXT,
ADD COLUMN     "languages" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "location" TEXT,
ADD COLUMN     "skills" JSONB NOT NULL DEFAULT '[]';
