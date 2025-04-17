import { PlaywrightModule } from '@daechanjo/playwright';
import { RabbitMQModule } from '@daechanjo/rabbitmq';
import { UtilModule } from '@daechanjo/util';
import { Module, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RedisModule } from '@nestjs-modules/ioredis';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';

import { redisConfig } from './config/redis.config';
import { TypeormConfig } from './config/typeorm.config';
import { SoldoutService } from './core/soldout.service';
import process from 'node:process';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath:
        process.env.NODE_ENV !== 'PROD'
          ? '/Users/daechanjo/codes/project/auto-store/.env'
          : '/app/.env',
    }),
    TypeOrmModule.forRootAsync(TypeormConfig),
    RedisModule.forRootAsync({
      useFactory: () => redisConfig,
    }),
    UtilModule,
    PlaywrightModule,
    RabbitMQModule,
  ],
  controllers: [],
  providers: [SoldoutService],
})
export class AppModule implements OnApplicationBootstrap {
  constructor(
    private readonly soldoutService: SoldoutService,
    private readonly configService: ConfigService,
    @InjectRedis() private readonly redis: Redis,
  ) {}

  async onApplicationBootstrap() {
    setTimeout(async () => {});
    const rockKey = `lock:soldout:${this.configService.get<string>('STORE')}`;
    await this.redis.del(rockKey);
    console.log('환경변수', process.env.K8S_RABBITMQ_URL);
    console.log('환경변수', process.env.RABBITMQ_URL);
    console.log('환경변수', process.env.REDIS_URL);
    await this.soldoutService.soldOutCron();
  }
}
