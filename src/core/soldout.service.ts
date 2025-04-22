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

  /**
   * 온채널 품절 상품 관리 메서드
   * 온채널에서 품절된 상품을 찾아 쿠팡과 네이버에서 해당 상품을 삭제하는 작업을 수행합니다.
   *
   * @param {string} jobId - 작업 식별을 위한 고유 ID
   * @returns {Promise<void>} 작업 완료 후 아무것도 반환하지 않음
   */
  async soldoutProductsManagement(jobId: string): Promise<void> {
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

  /**
   * 품절된 상품과 일치하는 쿠팡 상품 삭제 메서드
   * 온채널에서 품절된 상품 코드와 일치하는 쿠팡 상품을 찾아 판매 중지 및 삭제 처리합니다.
   *
   * @param {string} jobId - 작업 식별을 위한 고유 ID
   * @param {string[]} soldoutProductCodes - 품절된 상품의 코드 배열
   * @param {CoupangPagingProduct[]} coupangProducts - 쿠팡에 등록된 상품 목록
   * @returns {Promise<void>} 작업 완료 후 아무것도 반환하지 않음
   */
  async deleteMatchCoupangProducts(
    jobId: string,
    soldoutProductCodes: string[],
    coupangProducts: CoupangPagingProduct[],
  ): Promise<void> {
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
      const deleteProducts = matchedCoupangProducts.map((product) => {
        return {
          sellerProductId: String(product.sellerProductId),
          productName: product.sellerProductName,
        };
      });
      console.log(
        `${jobType}${jobId}: 쿠팡 품절 상품 ${matchedCoupangProducts.length}개 정지 시작`,
      );
      await this.rabbitmqService.send('coupang-queue', 'stopSaleBySellerProductId', {
        jobId: jobId,
        jobType: JobType.SOLDOUT,
        data: deleteProducts,
      });

      console.log(
        `${jobType}${jobId}: 쿠팡 품절 상품 ${matchedCoupangProducts.length}개 삭제 시작`,
      );
      await this.rabbitmqService.send('coupang-queue', 'deleteBySellerProductId', {
        jobId: jobId,
        jobType: JobType.SOLDOUT,
        data: deleteProducts,
      });

      console.log(`${jobType}${jobId}: 온채널 등록 상품 삭제`);
      await this.rabbitmqService.emit('onch-queue', 'deleteProducts', {
        jobId: jobId,
        jobType: JobType.SOLDOUT,
        data: matchedCoupangProducts,
      });
    }
  }

  /**
   * 품절된 상품과 일치하는 네이버 상품 삭제 메서드
   * 온채널에서 품절된 상품 코드와 일치하는 네이버 상품을 찾아 삭제 처리합니다.
   *
   * @param {string} jobId - 작업 식별을 위한 고유 ID
   * @param {string} store - 스토어 식별자
   * @param {string[]} soldoutProductCodes - 품절된 상품의 코드 배열
   * @param {NaverChannelProduct[]} naverProducts - 네이버에 등록된 상품 목록
   * @returns {Promise<void>} 작업 완료 후 아무것도 반환하지 않음
   */
  async deleteMatchNaverProducts(
    jobId: string,
    store: string,
    soldoutProductCodes: string[],
    naverProducts: NaverChannelProduct[],
  ): Promise<void> {
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

  /**
   * 품절 상품 정기 크론 작업
   * 20분마다 실행되며 품절된 상품을 감지하고 삭제하는 크론 작업을 수행합니다.
   * Redis를 이용한 락 메커니즘으로 중복 실행을 방지합니다.
   *
   * @returns {Promise<void>} 작업 완료 후 아무것도 반환하지 않음
   */
  @Cron('0 */20 * * * *')
  async soldOutCron(): Promise<void> {
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
