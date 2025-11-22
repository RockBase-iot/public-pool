import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import { ClientEntity } from './client.entity';



@Injectable()
export class ClientService {

    private heartbeatBulkUpdate: { [id: string]: { id: string, hashRate: number, updatedAt: Date } } = {};

    constructor(
        @InjectDataSource()
        private dataSource: DataSource,
        @InjectRepository(ClientEntity)
        private clientRepository: Repository<ClientEntity>
    ) {

    }

    // client.service.ts
    public async killDeadClients(): Promise<boolean> {
        const BATCH_SIZE = 500;

        return this.dataSource.transaction('REPEATABLE READ', async (manager) => {
            // IMPORTANT: We use raw SQL for the SELECT + SKIP LOCKED
            // This bypasses every TypeORM locking bug with inheritance
            const deadClients: { id: string }[] = await manager.query(`
            SELECT id
            FROM client_entity
            WHERE "deletedAt" IS NULL
              AND "updatedAt" < NOW() - INTERVAL '5 minutes'
            ORDER BY id
            LIMIT $1
            FOR UPDATE SKIP LOCKED
        `, [BATCH_SIZE]);

            if (deadClients.length === 0) {
                return false;
            }

            const ids = deadClients.map(c => c.id);

            // Now the update is safe and super fast
            await manager
                .createQueryBuilder()
                .update(ClientEntity)
                .set({ deletedAt: () => 'NOW()' })
                .whereInIds(ids)
                .execute();

            console.log(`Killed ${deadClients.length}`);

            return true;
        });
    }

    //public async heartbeat(id, hashRate: number, updatedAt: Date) {
    //     return await this.clientRepository.update({ id }, { hashRate, deletedAt: null, updatedAt });
    // }

    public heartbeatBulkAsync(id, hashRate: number, updatedAt: Date) {
        if (this.heartbeatBulkUpdate[id] != null) {
            this.heartbeatBulkUpdate[id].hashRate = hashRate;
            this.heartbeatBulkUpdate[id].updatedAt = updatedAt;
            return;
        }
        this.heartbeatBulkUpdate[id] = { id, hashRate, updatedAt };
    }

    public async doBulkHeartbeatUpdate() {
        if (Object.keys(this.heartbeatBulkUpdate).length < 1) {
            console.log('No heartbeats to update.')
            return;
        }

        const values = Object.entries(this.heartbeatBulkUpdate).map(([key, value]) => {
            return `('${value.id}', ${value.hashRate}, NOW())`
        }).join(',');

        const query = `
            DO $$
            BEGIN
                CREATE TEMP TABLE temp_heartbeats (
                    id UUID,
                    "hashRate" DECIMAL,
                    "updatedAt" TIMESTAMP
                ) ON COMMIT DROP;

                INSERT INTO temp_heartbeats (id, "hashRate", "updatedAt")
                VALUES ${values};

                UPDATE "client_entity" ce
                SET "hashRate" = th."hashRate",
                    "deletedAt" = NULL,
                    "updatedAt" = th."updatedAt"
                FROM temp_heartbeats th
                WHERE ce.id = th.id;
            END;
            $$;
        `;

        try {
            await this.clientRepository.query(query);
            console.log(`Bulk updated ${Object.keys(this.heartbeatBulkUpdate).length} client heartbeats`);
        } catch (error) {
            console.error('Bulk heartbeat failed:', error.message, 'Query:', query);
            throw error;
        }

        this.heartbeatBulkUpdate = {};
    }


    public async insert(partialClient: Partial<ClientEntity>): Promise<ClientEntity> {
        const insertResult = await this.clientRepository.insert(partialClient);

        const client = {
            ...partialClient,
            ...insertResult.generatedMaps[0]
        };

        return client as ClientEntity;
    }

    public async delete(id: string) {
        return await this.clientRepository.softDelete({ id });
    }

    public async deleteOldClients() {

        const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

        return await this.clientRepository
            .createQueryBuilder()
            .delete()
            .from(ClientEntity)
            .where('deletedAt < :deletedAt', { deletedAt: oneDayAgo })
            .execute();

    }

    public async updateBestDifficulty(id: string, bestDifficulty: number) {
        return await this.clientRepository.update({ id }, { bestDifficulty });
    }
    public async connectedClientCount(): Promise<number> {
        return await this.clientRepository.count();
    }

    public async getByAddress(address: string): Promise<ClientEntity[]> {
        return await this.clientRepository.find({
            where: {
                address
            }
        })
    }


    public async getByName(address: string, clientName: string): Promise<ClientEntity[]> {
        return await this.clientRepository.find({
            where: {
                address,
                clientName
            }
        })
    }

    public async getBySessionId(address: string, clientName: string, sessionId: string): Promise<ClientEntity> {
        return await this.clientRepository.findOne({
            where: {
                address,
                clientName,
                sessionId
            }
        })
    }

    public async deleteAll() {
        return await this.clientRepository.softDelete({})
    }

    // public async getUserAgents() {
    //     const result = await this.clientRepository.createQueryBuilder('client')
    //         .select('client.userAgent as "userAgent"')
    //         .addSelect('COUNT(client.userAgent)', 'count')
    //         .addSelect('MAX(client.bestDifficulty)', 'bestDifficulty')
    //         .addSelect('SUM(client.hashRate)', 'totalHashRate')
    //         .groupBy('client.userAgent')
    //         .orderBy('"totalHashRate"', 'DESC')
    //         .getRawMany();
    //     return result;
    // }

}