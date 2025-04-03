import { JobType, CoupangPagingProduct } from '@daechanjo/models';
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

  async soldoutProductsManagement(jobId: string) {
    const store = this.configService.get<string>('STORE');

    console.log(`${JobType.SOLDOUT}${jobId}: 온채널 품절 상품 탐색...`);
    const response = await this.rabbitmqService.send('onch-queue', 'crawlingOnchSoldoutProducts', {
      jobId: jobId,
      jobType: JobType.SOLDOUT,
      store: store,
    });

    if (response.data.soldoutProductCodes.length === 0) {
      console.log(`${JobType.SOLDOUT}${jobId}: 품절 상품이 없습니다.`);
      return;
    }

    console.log(`${JobType.SOLDOUT}${jobId}: 쿠팡/네이버 판매 상품 리스트업...`);
    const [coupangProducts, naverProducts] = await Promise.all([
      this.rabbitmqService.send('coupang-queue', 'getProductListPaging', {
        jobId: jobId,
        jobType: JobType.SOLDOUT,
      }),
      this.rabbitmqService.send('naver-queue', 'postSearchProducts', {
        jobId: jobId,
        jobType: JobType.SOLDOUT,
      }),
    ]);

    await Promise.all([
      this.deleteMatchCoupangProducts(
        jobId,
        store,
        response.data.soldoutProductCodes,
        coupangProducts.data,
      ),
      this.deleteMatchNaverProducts(
        jobId,
        store,
        response.data.soldoutProductCodes,
        naverProducts.data,
      ),
    ]);
  }

  async deleteMatchCoupangProducts(
    jobId: string,
    store: string,
    soldoutProductCodes: string[],
    coupangProducts: CoupangPagingProduct[],
  ) {
    console.log(`${JobType.SOLDOUT}${jobId}: 품절 상품 매칭...`);

    const jobType = JobType.SOLDOUT;

    // 유효성 체크
    const isCoupangProductsValid = Array.isArray(coupangProducts) && coupangProducts.length > 0;
    // const isNaverProductsValid = Array.isArray(naverProducts) && naverProducts.length > 0;
    if (!isCoupangProductsValid)
      console.log(`${jobType}${jobId}: 쿠팡 상품 데이터가 유효하지 않거나 비어 있습니다.`);

    const matchedCoupangProducts = isCoupangProductsValid
      ? coupangProducts.filter((product) => {
          const extractedCode = product?.sellerProductName?.match(/(CH\d{7})/)?.[0] || '';
          return soldoutProductCodes.includes(extractedCode);
        })
      : [];

    if (matchedCoupangProducts.length === 0 && isCoupangProductsValid)
      console.log(`${jobType}${jobId}: 매치된 쿠팡 상품이 없습니다.`);

    if (matchedCoupangProducts.length > 0) {
      console.log(
        `${jobType}${jobId}: 쿠팡 품절 상품 ${matchedCoupangProducts.length}개 정지 시작`,
      );
      await this.rabbitmqService.send('coupang-queue', 'stopSaleBySellerProductId', {
        jobId: jobId,
        jobType: JobType.SOLDOUT,
        data: matchedCoupangProducts,
      });

      console.log(
        `${jobType}${jobId}: 쿠팡 품절 상품 ${matchedCoupangProducts.length}개 삭제 시작`,
      );
      await this.rabbitmqService.send('coupang-queue', 'deleteBySellerProductId', {
        jobId: jobId,
        jobType: JobType.SOLDOUT,
        data: matchedCoupangProducts,
      });

      console.log(`${jobType}${jobId}: 온채널 등록 상품 삭제`);
      await this.rabbitmqService.emit('onch-queue', 'deleteProducts', {
        jobId: jobId,
        jobType: JobType.SOLDOUT,
        store: store,
        data: matchedCoupangProducts,
      });
    }
  }

  async deleteMatchNaverProducts(
    jobId: string,
    store: string,
    soldoutProductCodes: string[],
    naverProducts: NaverChannelProduct[],
  ) {
    console.log(`${JobType.SOLDOUT}${jobId}: 품절 상품 매칭...`);

    const jobType = JobType.SOLDOUT;

    const isNaverProductsValid = Array.isArray(naverProducts) && naverProducts.length > 0;
    if (!isNaverProductsValid)
      console.log(`${jobType}${jobId}: 네이버 상품 데이터가 유효하지 않거나 비어 있습니다.`);

    const matchedNaverProducts = isNaverProductsValid
      ? naverProducts.filter((product) => {
          return soldoutProductCodes.includes(product.sellerManagementCode);
        })
      : [];

    if (matchedNaverProducts.length > 0) {
      console.log(`${jobType}${jobId}: 네이버품절 ${matchedNaverProducts.length}개`);
      console.log(`${jobType}${jobId}: 네이버상품 삭제`);
      await this.rabbitmqService.emit('naver-queue', 'deleteNaverOriginProducts', {
        jobId: jobId,
        jobType: JobType.SOLDOUT,
        store: store,
        matchedNaverProducts: matchedNaverProducts,
      });

      console.log(`${jobType}${jobId}: 온채널 등록 상품 삭제`);
      await this.rabbitmqService.emit('onch-queue', 'deleteProducts', {
        jobId: jobId,
        jobType: JobType.SOLDOUT,
        store: store,
        products: matchedNaverProducts,
      });
    }
  }

  @Cron('0 */20 * * * *')
  async soldOutCron() {
    const jobId = this.utilService.generateCronId();
    const rockKey = `lock:soldout:${this.configService.get<string>('STORE')}`;

    try {
      const rock = await this.redis.set(rockKey, `run`);

      if (rock) {
        console.log(`${JobType.SOLDOUT}${jobId}: 품절상품 삭제 크론 시작`);
        await this.soldoutProductsManagement(jobId);
      } else {
        console.log(`${JobType.SOLDOUT}${jobId}: 이 전 작업이 아직 진행중입니다.`);
      }
    } catch (error) {
      console.error(`${JobType.ERROR}${JobType.SOLDOUT}${jobId}:`, error);
    } finally {
      await this.redis.del(rockKey);
      console.log(`${JobType.SOLDOUT}${jobId}: 품절상품 삭제 작업 종료`);
    }
  }
}
