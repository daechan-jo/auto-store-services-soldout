import { CronType, CoupangPagingProduct } from '@daechanjo/models';
import { NaverChannelProduct } from '@daechanjo/models/dist/interfaces/naver/naverChannelProduct.interface';
import { RabbitMQService } from '@daechanjo/rabbitmq';
import { UtilService } from '@daechanjo/util';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';

@Injectable()
export class SoldoutService {
  constructor(
    private readonly utilService: UtilService,
    private readonly rabbitmqService: RabbitMQService,
    private readonly configService: ConfigService,
    @InjectRedis() private readonly redis: Redis,
  ) {}

  async soldoutProductsManagement(cronId: string) {
    const store = this.configService.get<string>('STORE');

    console.log(`${CronType.SOLDOUT}${cronId}: 온채널 품절 상품 탐색...`);
    const response = await this.rabbitmqService.send('onch-queue', 'crawlingOnchSoldoutProducts', {
      store: store,
      type: CronType.SOLDOUT,
      cronId: cronId,
    });

    if (response.data.soldoutProductCodes.length === 0) {
      console.log(`${CronType.SOLDOUT}${cronId}: 품절 상품이 없습니다.`);
      return;
    }

    console.log(`${CronType.SOLDOUT}${cronId}: 쿠팡/네이버 판매 상품 리스트업...`);
    const [coupangProducts, naverProducts] = await Promise.all([
      this.rabbitmqService.send('coupang-queue', 'getProductListPaging', {
        cronId: cronId,
        type: CronType.SOLDOUT,
      }),
      this.rabbitmqService.send('naver-queue', 'postSearchProducts', {
        cronId: cronId,
        type: CronType.SOLDOUT,
      }),
    ]);

    await Promise.all([
      this.deleteMatchCoupangProducts(
        cronId,
        store,
        response.data.soldoutProductCodes,
        coupangProducts.data,
      ),
      this.deleteMatchNaverProducts(
        cronId,
        store,
        response.data.soldoutProductCodes,
        naverProducts.data,
      ),
    ]);
  }

  async deleteMatchCoupangProducts(
    cronId: string,
    store: string,
    soldoutProductCodes: string[],
    coupangProducts: CoupangPagingProduct[],
  ) {
    console.log(`${CronType.SOLDOUT}${cronId}: 품절 상품 매칭...`);

    const type = CronType.SOLDOUT;

    // 유효성 체크
    const isCoupangProductsValid = Array.isArray(coupangProducts) && coupangProducts.length > 0;
    // const isNaverProductsValid = Array.isArray(naverProducts) && naverProducts.length > 0;
    if (!isCoupangProductsValid)
      console.log(`${type}${cronId}: 쿠팡 상품 데이터가 유효하지 않거나 비어 있습니다.`);

    const matchedCoupangProducts = isCoupangProductsValid
      ? coupangProducts.filter((product) => {
          const extractedCode = product?.sellerProductName?.match(/(CH\d{7})/)?.[0] || '';
          return soldoutProductCodes.includes(extractedCode);
        })
      : [];

    if (matchedCoupangProducts.length === 0 && isCoupangProductsValid)
      console.log(`${type}${cronId}: 매치된 쿠팡 상품이 없습니다.`);

    if (matchedCoupangProducts.length > 0) {
      console.log(`${type}${cronId}: 쿠팡 품절 상품 ${matchedCoupangProducts.length}개 정지 시작`);
      await this.rabbitmqService.send('coupang-queue', 'stopSaleBySellerProductId', {
        cronId: cronId,
        type: CronType.SOLDOUT,
        data: matchedCoupangProducts,
      });

      console.log(`${type}${cronId}: 쿠팡 품절 상품 ${matchedCoupangProducts.length}개 삭제 시작`);
      await this.rabbitmqService.send('coupang-queue', 'deleteBySellerProductId', {
        cronId: cronId,
        type: CronType.SOLDOUT,
        data: matchedCoupangProducts,
      });

      console.log(`${type}${cronId}: 온채널 등록 상품 삭제`);
      await this.rabbitmqService.emit('onch-queue', 'deleteProducts', {
        cronId: cronId,
        store: store,
        type: CronType.SOLDOUT,
        data: matchedCoupangProducts,
      });
    }
  }

  async deleteMatchNaverProducts(
    cronId: string,
    store: string,
    soldoutProductCodes: string[],
    naverProducts: NaverChannelProduct[],
  ) {
    console.log(`${CronType.SOLDOUT}${cronId}: 품절 상품 매칭...`);

    const type = CronType.SOLDOUT;

    const isNaverProductsValid = Array.isArray(naverProducts) && naverProducts.length > 0;
    if (!isNaverProductsValid)
      console.log(`${type}${cronId}: 네이버 상품 데이터가 유효하지 않거나 비어 있습니다.`);

    const matchedNaverProducts = isNaverProductsValid
      ? naverProducts.filter((product) => {
          return soldoutProductCodes.includes(product.sellerManagementCode);
        })
      : [];

    if (matchedNaverProducts.length > 0) {
      console.log(`${type}${cronId}: 네이버품절 ${matchedNaverProducts.length}개`);
      console.log(`${type}${cronId}: 네이버상품 삭제`);
      await this.rabbitmqService.emit('naver-queue', 'deleteNaverOriginProducts', {
        cronId: cronId,
        store: store,
        type: CronType.SOLDOUT,
        matchedNaverProducts: matchedNaverProducts,
      });

      console.log(`${type}${cronId}: 온채널 등록 상품 삭제`);
      await this.rabbitmqService.emit('onch-queue', 'deleteProducts', {
        cronId: cronId,
        store: store,
        type: CronType.SOLDOUT,
        products: matchedNaverProducts,
      });
    }
  }

  @Cron('0 */20 * * * *')
  async soldOutCron() {
    const cronId = this.utilService.generateCronId();
    const rockKey = `lock:soldout:${this.configService.get<string>('STORE')}`;

    try {
      const rock = await this.redis.set(rockKey, `run`);

      if (rock) {
        console.log(`${CronType.SOLDOUT}${cronId}: 품절상품 삭제 크론 시작`);
        await this.soldoutProductsManagement(cronId);
      } else {
        console.log(`${CronType.SOLDOUT}${cronId}: 이 전 작업이 아직 진행중입니다.`);
      }
    } catch (error) {
      console.error(`${CronType.ERROR}${CronType.SOLDOUT}${cronId}:`, error);
    } finally {
      await this.redis.del(rockKey);
      console.log(`${CronType.SOLDOUT}${cronId}: 품절상품 삭제 작업 종료`);
    }
  }
}
