import { RedisModuleOptions } from '@nestjs-modules/ioredis';
import * as process from 'node:process';
import * as dotenv from 'dotenv';

if (process.env.NODE_ENV !== 'PROD') {
  dotenv.config({
    path: '/Users/daechanjo/codes/project/auto-store/.env',
  });
} else {
  dotenv.config();
}

export const redisConfig: RedisModuleOptions = {
  type: process.env.ENV === 'prod' ? 'cluster' : 'single',
  nodes: [
    {
      host: process.env.REDIS_HOST || '127.0.0.1',
      port: +process.env.REDIS_PORT! || 6379,
    },
  ],
};
