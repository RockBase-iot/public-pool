import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ExternalSharesEntity } from './external-shares.entity';

@Injectable()
export class ExternalSharesService {
    constructor(
        @InjectRepository(ExternalSharesEntity)
        private externalSharesRepository: Repository<ExternalSharesEntity>
    ) {}

    public async insert(externalShare: Partial<ExternalSharesEntity>) {
        return await this.externalSharesRepository.insert(externalShare);
    }

    public async getTopDifficulties(): Promise<Array<{address: string, userAgent: string, time: number, externalPoolName: string, difficulty: number}>> {
        // Use a subquery to find the row with the highest difficulty per address
        return await this.externalSharesRepository
            .createQueryBuilder('share')
            .select('DISTINCT ON (share.address) share.address', 'address')
            .addSelect('share.userAgent', 'userAgent')
            .addSelect('share.time', 'time')
            .addSelect('share.externalPoolName', 'externalPoolName')
            .addSelect('share.difficulty', 'difficulty')
            .orderBy('share.address')
            .addOrderBy('share.difficulty', 'DESC')
            .limit(10)
            .getRawMany();
    }

    public async getAddressBestDifficulty(address: string): Promise<number> {
        const result = await this.externalSharesRepository
            .createQueryBuilder()
            .select('MAX(difficulty)', 'maxDifficulty')
            .where('address = :address', { address })
            .getRawOne();
        return result?.maxDifficulty || 0;
    }

    public async deleteOldShares() {
        const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
        return await this.externalSharesRepository
            .createQueryBuilder()
            .delete()
            .from(ExternalSharesEntity)
            .where('time < :time', { time: oneDayAgo.getTime() })
            .execute();
    }

    public async deleteAll() {
        return await this.externalSharesRepository.delete({});
    }
}
