import { PrismaClient } from "@prisma/client";

function isPostgresUrl(url?: string) {
  return Boolean(
    url &&
      (url.startsWith("postgresql://") || url.startsWith("postgres://")),
  );
}

if (!isPostgresUrl(process.env.DATABASE_URL) && isPostgresUrl(process.env.DIRECT_URL)) {
  process.env.DATABASE_URL = process.env.DIRECT_URL;
}

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
