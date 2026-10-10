// file to manage PrismaClient

import { PrismaClient } from '@prisma/client';

const prismaClientSingleton = () => {
  return new PrismaClient({
    transactionOptions: {
      timeout: 30_000,   // 30s — how long a transaction may run before Prisma kills it
      maxWait: 10_000,   // 10s — how long to wait to acquire a connection from the pool
    },
  });
};

export const prisma = global.prisma || prismaClientSingleton();
if (process.env.NODE_ENV !== 'production') global.prisma = prisma;


